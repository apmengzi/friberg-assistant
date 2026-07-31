(function createFribergOfflineLicenseCore(global) {
  'use strict';

  const PRODUCT = 'friberg-assistant';
  const EDITION = 'commercial';
  const PREFIX = 'FRIBERG1';
  const DEVICE_PREFIX = 'FRB';
  const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });

  class LicenseError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'LicenseError';
      this.code = code;
    }
  }

  function bytesToBase64Url(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64UrlToBytes(value) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(value || ''))) {
      throw new LicenseError('FORMAT_ERROR', '许可证包含无效的 Base64URL 数据。');
    }
    const padded = String(value).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    try {
      const binary = atob(padded);
      return Uint8Array.from(binary, character => character.charCodeAt(0));
    } catch {
      throw new LicenseError('FORMAT_ERROR', '许可证编码无法解析。');
    }
  }

  function base64ToBytes(value) {
    try {
      const binary = atob(String(value || '').replace(/\s+/g, ''));
      return Uint8Array.from(binary, character => character.charCodeAt(0));
    } catch {
      throw new LicenseError('CONFIG_ERROR', '商业版公钥配置无效。');
    }
  }

  function encodeBase32(bytes) {
    let bits = 0;
    let accumulator = 0;
    let output = '';
    for (const byte of bytes) {
      accumulator = (accumulator << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        output += BASE32[(accumulator >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) output += BASE32[(accumulator << (5 - bits)) & 31];
    return output;
  }

  function installationIdToBytes(installationId) {
    const bytes = base64UrlToBytes(installationId);
    if (bytes.length !== 16) {
      throw new LicenseError('DEVICE_ERROR', '安装实例标识长度无效。');
    }
    return bytes;
  }

  async function deviceCodeFromInstallationId(installationId) {
    const installationBytes = installationIdToBytes(installationId);
    const body = encodeBase32(installationBytes);
    const checksumBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', installationBytes));
    const checksum = encodeBase32(checksumBytes).slice(0, 2);
    const compact = `${body}${checksum}`;
    const groups = compact.match(/.{1,4}/g);
    return `${DEVICE_PREFIX}-${groups.join('-')}`;
  }

  function normalizeDeviceCode(value) {
    const compact = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '');
    if (!compact.startsWith(DEVICE_PREFIX)) {
      throw new LicenseError('DEVICE_FORMAT', '设备码必须以 FRB 开头。');
    }
    const body = compact.slice(DEVICE_PREFIX.length);
    if (!/^[A-Z2-7]{28}$/.test(body)) {
      throw new LicenseError('DEVICE_FORMAT', '设备码格式错误，请重新复制完整设备码。');
    }
    return `${DEVICE_PREFIX}-${body.match(/.{4}/g).join('-')}`;
  }

  async function validateDeviceCode(value) {
    const normalized = normalizeDeviceCode(value);
    const compact = normalized.replace(/-/g, '').slice(DEVICE_PREFIX.length);
    const body = compact.slice(0, 26);
    const checksum = compact.slice(26);
    const decoded = [];
    let bits = 0;
    let accumulator = 0;
    for (const character of body) {
      accumulator = (accumulator << 5) | BASE32.indexOf(character);
      bits += 5;
      if (bits >= 8) {
        decoded.push((accumulator >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    const installationBytes = Uint8Array.from(decoded.slice(0, 16));
    const expected = encodeBase32(new Uint8Array(await crypto.subtle.digest('SHA-256', installationBytes))).slice(0, 2);
    if (checksum !== expected) {
      throw new LicenseError('DEVICE_CHECKSUM', '设备码校验失败，请重新点击“复制设备码”。');
    }
    return normalized;
  }

  async function hashDeviceCode(value) {
    const normalized = await validateDeviceCode(value);
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(normalized));
    return bytesToBase64Url(new Uint8Array(digest));
  }

  function parseVersion(value) {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(String(value || ''));
    if (!match) throw new LicenseError('VERSION_ERROR', `无法识别软件版本：${value || '空'}`);
    return match.slice(1).map(Number);
  }

  function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
    }
    return 0;
  }

  function parseIsoTime(value, field) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
      throw new LicenseError('PAYLOAD_ERROR', `${field} 必须是 UTC ISO 时间。`);
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new LicenseError('PAYLOAD_ERROR', `${field} 无法解析。`);
    return parsed;
  }

  function validatePayload(payload, options) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new LicenseError('PAYLOAD_ERROR', '许可证载荷不是有效对象。');
    }
    if (payload.schemaVersion !== 1) throw new LicenseError('SCHEMA_UNSUPPORTED', '许可证格式版本不受支持。');
    if (!/^[A-Za-z0-9._:-]{3,80}$/.test(String(payload.licenseId || ''))) {
      throw new LicenseError('PAYLOAD_ERROR', '许可证编号无效。');
    }
    if (payload.product !== (options.product || PRODUCT)) throw new LicenseError('PRODUCT_MISMATCH', '许可证不属于本产品。');
    if (payload.edition !== (options.edition || EDITION)) throw new LicenseError('EDITION_MISMATCH', '许可证版本不匹配。');
    if (payload.keyId !== options.keyId) throw new LicenseError('KEY_MISMATCH', '许可证签名密钥版本不受支持。');
    if (!/^[A-Za-z0-9_-]{43}$/.test(String(payload.deviceHash || ''))) {
      throw new LicenseError('PAYLOAD_ERROR', '许可证设备摘要无效。');
    }
    if (!Array.isArray(payload.features) || !payload.features.includes('assistant') || !payload.features.includes('solver')) {
      throw new LicenseError('FEATURE_MISSING', '许可证未包含助手核心功能。');
    }
    const issuedAtMs = parseIsoTime(payload.issuedAt, 'issuedAt');
    const notBeforeMs = parseIsoTime(payload.notBefore, 'notBefore');
    const expiresAtMs = parseIsoTime(payload.expiresAt, 'expiresAt');
    if (expiresAtMs <= notBeforeMs || notBeforeMs < issuedAtMs - 60000) {
      throw new LicenseError('PAYLOAD_ERROR', '许可证时间范围无效。');
    }
    if (options.nowMs + 60000 < notBeforeMs) throw new LicenseError('NOT_YET_VALID', '许可证尚未生效。');
    if (options.nowMs >= expiresAtMs) throw new LicenseError('EXPIRED', '许可证已经到期。');
    if (payload.minVersion && compareVersions(options.clientVersion, payload.minVersion) < 0) {
      throw new LicenseError('CLIENT_TOO_OLD', `请升级到 ${payload.minVersion} 或更高版本。`);
    }
    if (payload.maxVersion && compareVersions(options.clientVersion, payload.maxVersion) > 0) {
      throw new LicenseError('CLIENT_TOO_NEW', `当前许可证最高支持 ${payload.maxVersion}。`);
    }
    return { issuedAtMs, notBeforeMs, expiresAtMs };
  }

  async function verifyLicense(licenseText, options) {
    const normalized = String(licenseText || '').trim();
    if (normalized.length > 8192) throw new LicenseError('FORMAT_ERROR', '许可证文本过长。');
    const parts = normalized.split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX) {
      throw new LicenseError('FORMAT_ERROR', '许可证格式错误，应以 FRIBERG1. 开头。');
    }
    const payloadBytes = base64UrlToBytes(parts[1]);
    const signatureBytes = base64UrlToBytes(parts[2]);
    if (signatureBytes.length !== 64) throw new LicenseError('SIGNATURE_INVALID', '许可证签名长度无效。');
    const publicKey = await crypto.subtle.importKey(
      'spki',
      base64ToBytes(options.publicKeySpkiBase64),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const signatureValid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      signatureBytes,
      payloadBytes,
    );
    if (!signatureValid) throw new LicenseError('SIGNATURE_INVALID', '许可证签名无效或内容已被修改。');

    let payload;
    try {
      payload = JSON.parse(decoder.decode(payloadBytes));
    } catch {
      throw new LicenseError('PAYLOAD_ERROR', '许可证载荷无法解析。');
    }
    const times = validatePayload(payload, options);
    const expectedDeviceHash = await hashDeviceCode(options.deviceCode);
    if (payload.deviceHash !== expectedDeviceHash) {
      throw new LicenseError('DEVICE_MISMATCH', '许可证不属于当前安装实例。');
    }
    return Object.freeze({
      text: normalized,
      payload: Object.freeze({ ...payload, features: Object.freeze(payload.features.slice()) }),
      issuedAtMs: times.issuedAtMs,
      notBeforeMs: times.notBeforeMs,
      expiresAtMs: times.expiresAtMs,
      remainingSeconds: Math.max(0, Math.floor((times.expiresAtMs - options.nowMs) / 1000)),
    });
  }

  global.FribergOfflineLicenseCore = Object.freeze({
    PRODUCT,
    EDITION,
    PREFIX,
    LicenseError,
    bytesToBase64Url,
    base64UrlToBytes,
    deviceCodeFromInstallationId,
    normalizeDeviceCode,
    validateDeviceCode,
    hashDeviceCode,
    compareVersions,
    verifyLicense,
  });
}(globalThis));
