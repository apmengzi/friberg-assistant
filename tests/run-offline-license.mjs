import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  createLicensePayload,
  publicKeyInfo,
  signLicense,
} from '../seller-tools/license-generator/license-format.mjs';

function browserCoreContext() {
  const context = {
    TextEncoder,
    TextDecoder,
    crypto: webcrypto,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
  };
  context.globalThis = context;
  vm.createContext(context);
  return context;
}

async function loadBrowserCore() {
  const context = browserCoreContext();
  const source = await readFile(new URL('../commercial/offline-license/license-core.js', import.meta.url), 'utf8');
  vm.runInContext(source, context, { filename: 'license-core.js' });
  return context.FribergOfflineLicenseCore;
}

const core = await loadBrowserCore();
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keyInfo = publicKeyInfo(publicKey);
const installationId = randomBytes(16).toString('base64url');
const otherInstallationId = randomBytes(16).toString('base64url');
const deviceCode = await core.deviceCodeFromInstallationId(installationId);
const otherDeviceCode = await core.deviceCodeFromInstallationId(otherInstallationId);
const now = new Date('2026-07-30T00:00:00.000Z');

const payload = createLicensePayload({
  licenseId: 'TEST-20260730-0001',
  deviceCode,
  issuedAt: now,
  notBefore: now,
  expiresAt: new Date(now.getTime() + 7 * 86400000),
  minVersion: '0.9.2',
  maxVersion: null,
  keyId: keyInfo.keyId,
});
const license = signLicense(payload, privateKey);
const options = {
  publicKeySpkiBase64: keyInfo.spkiBase64,
  keyId: keyInfo.keyId,
  product: 'friberg-assistant',
  edition: 'commercial',
  clientVersion: '0.9.2',
  deviceCode,
  nowMs: now.getTime(),
};

const verified = await core.verifyLicense(license, options);
assert.equal(verified.payload.licenseId, payload.licenseId);
assert.equal(verified.remainingSeconds, 7 * 86400);

const upgraded = await core.verifyLicense(license, { ...options, clientVersion: '0.9.3' });
assert.equal(upgraded.payload.licenseId, payload.licenseId, '0.9.2 license must survive a 0.9.3 update');

await assert.rejects(
  core.verifyLicense(license, { ...options, deviceCode: otherDeviceCode }),
  error => error.code === 'DEVICE_MISMATCH',
);

const parts = license.split('.');
const tamperedPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
tamperedPayload.expiresAt = '2036-07-30T00:00:00.000Z';
const tamperedLicense = `${parts[0]}.${Buffer.from(JSON.stringify(tamperedPayload)).toString('base64url')}.${parts[2]}`;
await assert.rejects(
  core.verifyLicense(tamperedLicense, options),
  error => error.code === 'SIGNATURE_INVALID',
);

await assert.rejects(
  core.verifyLicense(license, { ...options, nowMs: Date.parse(payload.expiresAt) }),
  error => error.code === 'EXPIRED',
);

const futurePayload = createLicensePayload({
  ...payload,
  licenseId: 'TEST-FUTURE',
  deviceCode,
  issuedAt: now,
  notBefore: new Date(now.getTime() + 3600000),
  expiresAt: new Date(now.getTime() + 7200000),
  keyId: keyInfo.keyId,
});
const futureLicense = signLicense(futurePayload, privateKey);
await assert.rejects(
  core.verifyLicense(futureLicense, options),
  error => error.code === 'NOT_YET_VALID',
);

await assert.rejects(
  core.verifyLicense(license, { ...options, clientVersion: '0.9.1' }),
  error => error.code === 'CLIENT_TOO_OLD',
);

const invalidChecksum = `${deviceCode.slice(0, -1)}${deviceCode.endsWith('A') ? 'B' : 'A'}`;
await assert.rejects(
  core.validateDeviceCode(invalidChecksum),
  error => error.code === 'DEVICE_CHECKSUM',
);

process.stdout.write(`${JSON.stringify({
  status: 'passed',
  checks: 8,
  algorithms: ['Ed25519', 'SHA-256'],
  sampleDeviceCode: deviceCode,
  updatePreservesLicense: true,
  privateKeyBundled: false,
})}\n`);
