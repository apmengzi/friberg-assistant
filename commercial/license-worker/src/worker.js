const TIERS = Object.freeze({
  '5h': { label: '5 小时卡', seconds: 5 * 60 * 60 },
  '12h': { label: '12 小时卡', seconds: 12 * 60 * 60 },
  '1d': { label: '天卡', seconds: 24 * 60 * 60 },
  '3d': { label: '三天卡', seconds: 3 * 24 * 60 * 60 },
  '7d': { label: '周卡', seconds: 7 * 24 * 60 * 60 },
  '30d': { label: '月卡', seconds: 30 * 24 * 60 * 60 },
});

const CARD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const textEncoder = new TextEncoder();

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, textEncoder.encode(value))));
}

function normalizeCardKey(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
}

function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function generateCardKey() {
  let body = '';
  while (body.length < 32) {
    const bytes = new Uint8Array(48);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= 224) continue;
      body += CARD_ALPHABET[byte % CARD_ALPHABET.length];
      if (body.length === 32) break;
    }
  }
  return `FRB-${body.match(/.{1,4}/g).join('-')}`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function responseJson(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      ...extraHeaders,
    },
  });
}

function responseOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-max-age': '86400',
    },
  });
}

async function readJson(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new Error('请求必须使用 application/json。');
  return request.json();
}

function publicLicense(row, now = nowSeconds()) {
  const expired = Boolean(row.expires_at && row.expires_at <= now);
  const status = row.status === 'revoked' ? 'revoked' : expired ? 'expired' : row.activated_at ? 'active' : 'unused';
  return {
    id: row.id,
    productId: row.product_id,
    tier: row.tier,
    tierLabel: TIERS[row.tier]?.label || row.tier,
    status,
    activatedAt: row.activated_at,
    expiresAt: row.expires_at,
    serverTime: now,
    deviceBound: Boolean(row.device_hash),
    keyHint: `${row.key_prefix}••••${row.key_last4}`,
  };
}

async function addEvent(env, licenseId, eventType, detail = {}) {
  await env.DB.prepare(
    'INSERT INTO license_events (license_id, event_type, created_at, detail_json) VALUES (?, ?, ?, ?)',
  ).bind(licenseId || null, eventType, nowSeconds(), JSON.stringify(detail)).run();
}

async function findByKeyHash(env, keyHash) {
  return env.DB.prepare('SELECT * FROM license_keys WHERE key_hash = ? LIMIT 1').bind(keyHash).first();
}

async function activateLicense(request, env) {
  const body = await readJson(request);
  const normalizedKey = normalizeCardKey(body.cardKey);
  const deviceId = String(body.deviceId || '');
  if (normalizedKey.length < 24 || deviceId.length < 16 || deviceId.length > 200) {
    return responseJson({ active: false, code: 'INVALID_REQUEST', message: '卡密或设备标识格式无效。' }, 400);
  }

  const keyHash = await hmacHex(env.LICENSE_PEPPER, normalizedKey);
  const deviceHash = await hmacHex(env.LICENSE_PEPPER, `device:${deviceId}`);
  let row = await findByKeyHash(env, keyHash);
  if (!row || row.product_id !== env.PRODUCT_ID) {
    await addEvent(env, null, 'activation_rejected', { reason: 'unknown_key' });
    return responseJson({ active: false, code: 'INVALID_LICENSE', message: '卡密无效或不属于当前产品。' }, 404);
  }

  const now = nowSeconds();
  if (row.status === 'revoked') return responseJson({ active: false, code: 'REVOKED', message: '该卡密已被封禁。' }, 403);
  if (row.expires_at && row.expires_at <= now) {
    await env.DB.prepare("UPDATE license_keys SET status = 'expired' WHERE id = ?").bind(row.id).run();
    return responseJson({ active: false, code: 'EXPIRED', message: '该卡密已经到期。', license: publicLicense(row, now) }, 403);
  }

  const refreshToken = randomToken(32);
  const refreshHash = await hmacHex(env.LICENSE_PEPPER, `refresh:${refreshToken}`);
  if (!row.activated_at) {
    const expiresAt = now + row.duration_seconds;
    const result = await env.DB.prepare(
      "UPDATE license_keys SET status = 'active', activated_at = ?, expires_at = ?, device_hash = ?, refresh_hash = ?, last_seen_at = ? WHERE id = ? AND activated_at IS NULL",
    ).bind(now, expiresAt, deviceHash, refreshHash, now, row.id).run();
    if (Number(result.meta?.changes || 0) > 0) {
      row = await env.DB.prepare('SELECT * FROM license_keys WHERE id = ?').bind(row.id).first();
      await addEvent(env, row.id, 'activated', { clientVersion: String(body.clientVersion || '') });
      return responseJson({ active: true, refreshToken, license: publicLicense(row, now) });
    }
    row = await env.DB.prepare('SELECT * FROM license_keys WHERE id = ?').bind(row.id).first();
  }

  if (row.device_hash && row.device_hash !== deviceHash) {
    await addEvent(env, row.id, 'activation_rejected', { reason: 'device_mismatch' });
    return responseJson({
      active: false,
      code: 'DEVICE_MISMATCH',
      message: '该卡密已经绑定其他设备；如为本人换机，请联系卖家重置设备。',
      license: publicLicense(row, now),
    }, 409);
  }

  await env.DB.prepare(
    "UPDATE license_keys SET status = 'active', device_hash = ?, refresh_hash = ?, last_seen_at = ? WHERE id = ?",
  ).bind(deviceHash, refreshHash, now, row.id).run();
  row = await env.DB.prepare('SELECT * FROM license_keys WHERE id = ?').bind(row.id).first();
  await addEvent(env, row.id, 'reactivated', { clientVersion: String(body.clientVersion || '') });
  return responseJson({ active: true, refreshToken, license: publicLicense(row, now) });
}

async function refreshLicense(request, env) {
  const body = await readJson(request);
  const licenseId = String(body.licenseId || '');
  const deviceId = String(body.deviceId || '');
  const refreshToken = String(body.refreshToken || '');
  if (!licenseId || deviceId.length < 16 || refreshToken.length < 24) {
    return responseJson({ active: false, code: 'INVALID_REQUEST', message: '许可证会话格式无效。' }, 400);
  }

  const row = await env.DB.prepare('SELECT * FROM license_keys WHERE id = ? LIMIT 1').bind(licenseId).first();
  const now = nowSeconds();
  if (!row || row.product_id !== env.PRODUCT_ID) return responseJson({ active: false, code: 'INVALID_LICENSE', message: '许可证不存在。' }, 404);
  if (row.status === 'revoked') return responseJson({ active: false, code: 'REVOKED', message: '许可证已被封禁。' }, 403);
  if (!row.expires_at || row.expires_at <= now) {
    await env.DB.prepare("UPDATE license_keys SET status = 'expired' WHERE id = ?").bind(row.id).run();
    return responseJson({ active: false, code: 'EXPIRED', message: '许可证已到期。', license: publicLicense(row, now) }, 403);
  }

  const deviceHash = await hmacHex(env.LICENSE_PEPPER, `device:${deviceId}`);
  const refreshHash = await hmacHex(env.LICENSE_PEPPER, `refresh:${refreshToken}`);
  if (row.device_hash !== deviceHash || row.refresh_hash !== refreshHash) {
    await addEvent(env, row.id, 'refresh_rejected', { reason: 'session_mismatch' });
    return responseJson({ active: false, code: 'SESSION_MISMATCH', message: '许可证会话与绑定设备不匹配。' }, 409);
  }

  await env.DB.prepare('UPDATE license_keys SET last_seen_at = ? WHERE id = ?').bind(now, row.id).run();
  return responseJson({ active: true, license: publicLicense(row, now) });
}

function requireAdmin(request, env) {
  const value = request.headers.get('authorization') || '';
  return env.ADMIN_TOKEN && value === `Bearer ${env.ADMIN_TOKEN}`;
}

async function createBatch(request, env) {
  const body = await readJson(request);
  const tier = String(body.tier || '');
  const quantity = Math.max(1, Math.min(100, Number(body.quantity) || 1));
  if (!TIERS[tier]) return responseJson({ code: 'INVALID_TIER', message: '未知卡密时长。', tiers: TIERS }, 400);

  const createdAt = nowSeconds();
  const cards = [];
  for (let index = 0; index < quantity; index += 1) {
    let cardKey;
    let keyHash;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      cardKey = generateCardKey();
      keyHash = await hmacHex(env.LICENSE_PEPPER, normalizeCardKey(cardKey));
      if (!(await findByKeyHash(env, keyHash))) break;
      cardKey = null;
    }
    if (!cardKey) throw new Error('无法生成唯一卡密，请重试。');
    const id = crypto.randomUUID();
    const normalized = normalizeCardKey(cardKey);
    await env.DB.prepare(
      `INSERT INTO license_keys
        (id, product_id, key_hash, key_prefix, key_last4, tier, duration_seconds, status, created_at, note, order_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'unused', ?, ?, ?)`,
    ).bind(
      id,
      env.PRODUCT_ID,
      keyHash,
      cardKey.slice(0, 8),
      normalized.slice(-4),
      tier,
      TIERS[tier].seconds,
      createdAt,
      String(body.note || '').slice(0, 240),
      String(body.orderRef || '').slice(0, 120),
    ).run();
    await addEvent(env, id, 'created', { tier });
    cards.push({ id, cardKey, tier, tierLabel: TIERS[tier].label, durationSeconds: TIERS[tier].seconds });
  }

  return responseJson({
    warning: '明文卡密仅在本次响应返回。请安全保存并按订单逐个发送，不要截图公开卡密列表。',
    cards,
  }, 201);
}

async function listLicenses(request, env) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
  const query = status
    ? env.DB.prepare('SELECT * FROM license_keys WHERE status = ? ORDER BY created_at DESC LIMIT ?').bind(status, limit)
    : env.DB.prepare('SELECT * FROM license_keys ORDER BY created_at DESC LIMIT ?').bind(limit);
  const result = await query.all();
  return responseJson({ licenses: (result.results || []).map(row => ({ ...publicLicense(row), note: row.note, orderRef: row.order_ref, lastSeenAt: row.last_seen_at })) });
}

async function adminAction(request, env, licenseId, action) {
  const row = await env.DB.prepare('SELECT * FROM license_keys WHERE id = ?').bind(licenseId).first();
  if (!row) return responseJson({ code: 'NOT_FOUND', message: '许可证不存在。' }, 404);
  if (action === 'revoke') {
    await env.DB.prepare("UPDATE license_keys SET status = 'revoked', refresh_hash = NULL WHERE id = ?").bind(licenseId).run();
    await addEvent(env, licenseId, 'revoked');
  } else if (action === 'reset-device') {
    const status = row.expires_at && row.expires_at <= nowSeconds() ? 'expired' : row.activated_at ? 'active' : 'unused';
    await env.DB.prepare('UPDATE license_keys SET status = ?, device_hash = NULL, refresh_hash = NULL WHERE id = ?').bind(status, licenseId).run();
    await addEvent(env, licenseId, 'device_reset');
  } else {
    return responseJson({ code: 'UNKNOWN_ACTION', message: '未知管理操作。' }, 404);
  }
  const updated = await env.DB.prepare('SELECT * FROM license_keys WHERE id = ?').bind(licenseId).first();
  return responseJson({ ok: true, license: publicLicense(updated) });
}

async function handleRequest(request, env) {
  if (request.method === 'OPTIONS') return responseOptions();
  const url = new URL(request.url);
  if (url.pathname === '/health') return responseJson({ ok: true, productId: env.PRODUCT_ID, serverTime: nowSeconds() });
  if (request.method === 'POST' && url.pathname === '/v1/licenses/activate') return activateLicense(request, env);
  if (request.method === 'POST' && url.pathname === '/v1/licenses/refresh') return refreshLicense(request, env);

  if (url.pathname.startsWith('/v1/admin/')) {
    if (!requireAdmin(request, env)) return responseJson({ code: 'UNAUTHORIZED', message: '管理令牌无效。' }, 401);
    if (request.method === 'POST' && url.pathname === '/v1/admin/licenses/batch') return createBatch(request, env);
    if (request.method === 'GET' && url.pathname === '/v1/admin/licenses') return listLicenses(request, env);
    const match = url.pathname.match(/^\/v1\/admin\/licenses\/([^/]+)\/(revoke|reset-device)$/);
    if (request.method === 'POST' && match) return adminAction(request, env, decodeURIComponent(match[1]), match[2]);
  }
  return responseJson({ code: 'NOT_FOUND', message: '接口不存在。' }, 404);
}

export { TIERS, generateCardKey, normalizeCardKey, handleRequest };

export default {
  async fetch(request, env) {
    try {
      if (!env.DB || !env.LICENSE_PEPPER || !env.PRODUCT_ID) {
        return responseJson({ code: 'SERVER_NOT_CONFIGURED', message: '许可证服务尚未完成配置。' }, 503);
      }
      return await handleRequest(request, env);
    } catch (_cause) {
      return responseJson({ code: 'SERVER_ERROR', message: '许可证服务暂时不可用。' }, 500);
    }
  },
};
