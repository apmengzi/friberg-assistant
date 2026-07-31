'use strict';

importScripts('license-config.js');

const PRIVATE_SCRIPT_ID = 'friberg-authorized-private-adapter';
const PRIVATE_FILES = [
  'license-config.js',
  'license-client.js',
  'solver.js',
  'automation-core.js',
  'overlay.js',
  'content-script.js',
];
const SESSION_KEY = 'fribergCommercialLicenseSessionV1';
const DEVICE_KEY = 'fribergCommercialDeviceIdV1';
const config = globalThis.FribergLicenseConfig;

function matchPatternForOrigin(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

async function replacePrivateRegistration(origins) {
  const matches = [...new Set((origins || []).map(matchPatternForOrigin))]
    .filter(match => !match.startsWith('https://shnlfriberg.online/'));
  await chrome.scripting.unregisterContentScripts({ ids: [PRIVATE_SCRIPT_ID] }).catch(() => undefined);
  if (!matches.length) return;
  await chrome.scripting.registerContentScripts([{
    id: PRIVATE_SCRIPT_ID,
    matches,
    css: ['overlay.css'],
    js: PRIVATE_FILES,
    runAt: 'document_idle',
    persistAcrossSessions: true,
  }]);
}

async function storageGet(defaults) {
  return chrome.storage.local.get(defaults);
}

async function getDeviceId() {
  const saved = await storageGet({ [DEVICE_KEY]: '' });
  if (saved[DEVICE_KEY]) return saved[DEVICE_KEY];
  const value = crypto.randomUUID();
  await chrome.storage.local.set({ [DEVICE_KEY]: value });
  return value;
}

async function readSession() {
  const saved = await storageGet({ [SESSION_KEY]: null });
  return saved[SESSION_KEY];
}

async function writeSession(session) {
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

async function clearSession() {
  await chrome.storage.local.remove(SESSION_KEY);
}

function licenseState(session, source = 'cache') {
  const nowMs = Date.now();
  const serverOffsetMs = Number(session.serverOffsetMs || 0);
  const estimatedServerNow = nowMs + serverOffsetMs;
  const active = Number(session.expiresAt || 0) * 1000 > estimatedServerNow;
  return {
    active,
    source,
    license: active ? {
      id: session.licenseId,
      tier: session.tier,
      tierLabel: session.tierLabel,
      expiresAt: session.expiresAt,
      serverTime: Math.floor(estimatedServerNow / 1000),
      keyHint: session.keyHint,
    } : null,
    message: active ? '许可证有效。' : '许可证已到期。',
  };
}

async function apiRequest(path, body) {
  const base = String(config.apiBase || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('卡密服务地址未配置。');
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.active) {
    const error = new Error(payload.message || `卡密服务返回 ${response.status}`);
    error.code = payload.code || 'LICENSE_REJECTED';
    throw error;
  }
  return payload;
}

function sessionFromPayload(payload, deviceId) {
  const license = payload.license || {};
  return {
    licenseId: license.id,
    refreshToken: payload.refreshToken,
    expiresAt: license.expiresAt,
    tier: license.tier,
    tierLabel: license.tierLabel,
    keyHint: license.keyHint,
    deviceId,
    verifiedAtMs: Date.now(),
    serverOffsetMs: Number(license.serverTime || 0) * 1000 - Date.now(),
  };
}

async function activate(cardKey) {
  const deviceId = await getDeviceId();
  const payload = await apiRequest('/v1/licenses/activate', {
    cardKey: String(cardKey || ''),
    deviceId,
    productId: config.productId,
    clientVersion: config.clientVersion,
  });
  const session = sessionFromPayload(payload, deviceId);
  await writeSession(session);
  return licenseState(session, 'activated');
}

async function refresh(force = false) {
  const session = await readSession();
  if (!session) return { active: false, code: 'NO_LICENSE', message: '请输入卡密激活。' };
  const cached = licenseState(session);
  if (!cached.active) {
    await clearSession();
    return { active: false, code: 'EXPIRED', message: '许可证已经到期。' };
  }
  if (!force && Date.now() - Number(session.verifiedAtMs || 0) < config.verificationIntervalMs) return cached;

  try {
    const payload = await apiRequest('/v1/licenses/refresh', {
      licenseId: session.licenseId,
      refreshToken: session.refreshToken,
      deviceId: session.deviceId || await getDeviceId(),
      clientVersion: config.clientVersion,
    });
    const updated = {
      ...session,
      expiresAt: payload.license.expiresAt,
      tier: payload.license.tier,
      tierLabel: payload.license.tierLabel,
      keyHint: payload.license.keyHint,
      verifiedAtMs: Date.now(),
      serverOffsetMs: Number(payload.license.serverTime || 0) * 1000 - Date.now(),
    };
    await writeSession(updated);
    return licenseState(updated, 'server');
  } catch (cause) {
    if (cause.code && cause.code !== 'NETWORK_ERROR') {
      await clearSession();
      return { active: false, code: cause.code, message: cause.message };
    }
    if (Date.now() - Number(session.verifiedAtMs || 0) <= config.offlineGraceMs) {
      return { ...cached, source: 'offline-grace', message: '暂时离线，正在使用短时宽限。' };
    }
    return { active: false, code: 'SERVER_UNREACHABLE', message: '无法连接卡密服务器，请检查网络后重试。' };
  }
}

async function handleLicenseMessage(message) {
  if (message.action === 'activate') return activate(message.cardKey);
  if (message.action === 'status') return refresh(Boolean(message.force));
  if (message.action === 'clear') {
    await clearSession();
    return { active: false, code: 'CLEARED', message: '本机许可证会话已清除。' };
  }
  return { active: false, code: 'UNKNOWN_ACTION', message: '未知许可证操作。' };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'friberg-license') {
    handleLicenseMessage(message)
      .then(sendResponse)
      .catch(cause => sendResponse({
        active: false,
        code: cause.code || 'NETWORK_ERROR',
        message: cause.message || '卡密服务连接失败。',
      }));
    return true;
  }
  if (message?.type === 'friberg:configure-private-origins') {
    replacePrivateRegistration(message.origins)
      .then(() => sendResponse({ ok: true }))
      .catch(cause => sendResponse({ ok: false, message: cause.message }));
    return true;
  }
  return undefined;
});
