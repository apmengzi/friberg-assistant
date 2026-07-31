import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PRODUCT = 'friberg-assistant';
export const EDITION = 'commercial';
export const PREFIX = 'FRIBERG1';
const DEVICE_PREFIX = 'FRB';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

export function normalizeDeviceCode(value) {
  const compact = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '');
  if (!compact.startsWith(DEVICE_PREFIX) || !/^[A-Z2-7]{28}$/.test(compact.slice(DEVICE_PREFIX.length))) {
    throw new Error('设备码格式错误，应为 FRB- 后跟七组四位字符。');
  }
  return `${DEVICE_PREFIX}-${compact.slice(DEVICE_PREFIX.length).match(/.{4}/g).join('-')}`;
}

function decodeBase32(value) {
  let bits = 0;
  let accumulator = 0;
  const output = [];
  for (const character of value) {
    const number = BASE32.indexOf(character);
    if (number < 0) throw new Error('设备码包含无效字符。');
    accumulator = (accumulator << 5) | number;
    bits += 5;
    if (bits >= 8) {
      output.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function encodeBase32(value) {
  let bits = 0;
  let accumulator = 0;
  let output = '';
  for (const byte of value) {
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

export function validateDeviceCode(value) {
  const normalized = normalizeDeviceCode(value);
  const compact = normalized.replace(/-/g, '').slice(DEVICE_PREFIX.length);
  const body = compact.slice(0, 26);
  const checksum = compact.slice(26);
  const installationBytes = decodeBase32(body).subarray(0, 16);
  const expected = encodeBase32(createHash('sha256').update(installationBytes).digest()).slice(0, 2);
  if (checksum !== expected) throw new Error('设备码校验失败，请让买家重新复制设备码。');
  return normalized;
}

export function deviceHash(value) {
  return base64url(createHash('sha256').update(validateDeviceCode(value), 'utf8').digest());
}

export function publicKeyInfo(publicKey) {
  const normalizedPublicKey = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey);
  const spki = normalizedPublicKey.export({ type: 'spki', format: 'der' });
  return {
    spki,
    spkiBase64: spki.toString('base64'),
    keyId: createHash('sha256').update(spki).digest('hex').slice(0, 16),
  };
}

export async function createSigningKeys({ privateKeyPath, publicKeyPath }) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  await writeFile(privateKeyPath, privatePem, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await writeFile(publicKeyPath, publicPem, { encoding: 'utf8', flag: 'wx' });
  return publicKeyInfo(publicKey);
}

export async function readSigningKey(privateKeyPath) {
  return createPrivateKey(await readFile(privateKeyPath, 'utf8'));
}

export function createLicensePayload({
  licenseId,
  deviceCode,
  issuedAt = new Date(),
  notBefore = issuedAt,
  expiresAt,
  minVersion = '0.9.2',
  maxVersion = null,
  keyId,
  features = ['assistant', 'solver', 'fill', 'submit'],
}) {
  if (!/^[A-Za-z0-9._:-]{3,80}$/.test(String(licenseId || ''))) {
    throw new Error('许可证编号只能使用字母、数字、点、下划线、冒号和连字符。');
  }
  const issuedAtDate = new Date(issuedAt);
  const notBeforeDate = new Date(notBefore);
  const expiresAtDate = new Date(expiresAt);
  if (![issuedAtDate, notBeforeDate, expiresAtDate].every(value => Number.isFinite(value.getTime()))) {
    throw new Error('许可证时间参数无效。');
  }
  if (expiresAtDate <= notBeforeDate) throw new Error('到期时间必须晚于生效时间。');
  return {
    schemaVersion: 1,
    licenseId,
    product: PRODUCT,
    edition: EDITION,
    keyId,
    issuedAt: issuedAtDate.toISOString(),
    notBefore: notBeforeDate.toISOString(),
    expiresAt: expiresAtDate.toISOString(),
    deviceHash: deviceHash(deviceCode),
    features: [...new Set(features)],
    minVersion,
    maxVersion,
  };
}

export function signLicense(payload, privateKey) {
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign(null, payloadBytes, privateKey);
  return `${PREFIX}.${base64url(payloadBytes)}.${base64url(signature)}`;
}

export function isInside(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
