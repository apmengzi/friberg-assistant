import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';

const licenseFile = process.argv[2];
const deviceCode = process.argv[3];
if (!licenseFile || !deviceCode) {
  throw new Error('Usage: node tests/verify-packaged-license.mjs <license-file> <device-code>');
}

const root = path.resolve(import.meta.dirname, '..');
const context = {
  TextEncoder,
  TextDecoder,
  crypto: webcrypto,
  atob: value => Buffer.from(value, 'base64').toString('binary'),
  btoa: value => Buffer.from(value, 'binary').toString('base64'),
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(
  await readFile(path.join(root, 'dist', 'friberg-assistant-commercial', 'license-config.js'), 'utf8'),
  context,
);
vm.runInContext(
  await readFile(path.join(root, 'dist', 'friberg-assistant-commercial', 'license-core.js'), 'utf8'),
  context,
);

const licenseText = (await readFile(path.resolve(licenseFile), 'utf8'))
  .split(/\r?\n/)
  .find(line => line.startsWith('FRIBERG1.'));
assert.ok(licenseText, 'license output file must contain a FRIBERG1 line');

const config = context.FribergLicenseConfig;
const verified = await context.FribergOfflineLicenseCore.verifyLicense(licenseText, {
  publicKeySpkiBase64: config.publicKeySpkiBase64,
  keyId: config.keyId,
  product: config.product,
  edition: config.edition,
  clientVersion: config.clientVersion,
  deviceCode,
  nowMs: Date.now(),
});
assert.ok(verified.remainingSeconds > 0);

process.stdout.write(`${JSON.stringify({
  status: 'passed',
  licenseId: verified.payload.licenseId,
  keyId: verified.payload.keyId,
  packagedPublicKeyMatchesSellerKey: true,
})}\n`);
