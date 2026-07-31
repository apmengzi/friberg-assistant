import assert from 'node:assert/strict';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  createLicensePayload,
  publicKeyInfo,
  signLicense,
} from '../seller-tools/license-generator/license-format.mjs';

let fakeNow = Date.parse('2026-07-30T00:00:00.000Z');
class FakeDate extends Date {
  static now() {
    return fakeNow;
  }
}

const stored = {};
let messageListener;
const context = {
  TextEncoder,
  TextDecoder,
  Date: FakeDate,
  crypto: webcrypto,
  atob: value => Buffer.from(value, 'base64').toString('binary'),
  btoa: value => Buffer.from(value, 'binary').toString('base64'),
  importScripts() {},
  chrome: {
    storage: {
      local: {
        async get(defaults) {
          if (typeof defaults === 'string') return { [defaults]: stored[defaults] };
          return { ...defaults, ...stored };
        },
        async set(values) {
          Object.assign(stored, values);
        },
        async remove(key) {
          for (const name of Array.isArray(key) ? key : [key]) delete stored[name];
        },
      },
    },
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        },
      },
    },
  },
};
context.globalThis = context;
vm.createContext(context);

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keyInfo = publicKeyInfo(publicKey);
context.FribergLicenseConfig = Object.freeze({
  product: 'friberg-assistant',
  edition: 'commercial',
  clientVersion: '0.9.2',
  keyId: keyInfo.keyId,
  publicKeySpkiBase64: keyInfo.spkiBase64,
  rollbackToleranceMs: 21600000,
});
vm.runInContext(
  await readFile(new URL('../commercial/offline-license/license-core.js', import.meta.url), 'utf8'),
  context,
);
vm.runInContext(
  await readFile(new URL('../commercial/extension-overlay/license-background.js', import.meta.url), 'utf8'),
  context,
);

function send(action, extra = {}) {
  return new Promise((resolve, reject) => {
    try {
      const asynchronous = messageListener(
        { type: 'friberg-offline-license', action, ...extra },
        {},
        resolve,
      );
      assert.equal(asynchronous, true);
    } catch (error) {
      reject(error);
    }
  });
}

const deviceResult = await send('device');
const deviceCode = deviceResult.device.deviceCode;
assert.match(deviceCode, /^FRB-(?:[A-Z2-7]{4}-){6}[A-Z2-7]{4}$/);

const payload = createLicensePayload({
  licenseId: 'BACKGROUND-TEST',
  deviceCode,
  issuedAt: new Date(fakeNow),
  expiresAt: new Date(fakeNow + 30 * 86400000),
  keyId: keyInfo.keyId,
});
const licenseText = signLicense(payload, privateKey);
const activated = await send('activate', { licenseText });
assert.equal(activated.active, true);
assert.equal(activated.license.id, 'BACKGROUND-TEST');

const activeStatus = await send('status');
assert.equal(activeStatus.active, true);
const originalDeviceCode = activeStatus.license.deviceCode;

fakeNow += 2 * 86400000;
assert.equal((await send('status')).active, true);
fakeNow -= 86400000;
const rollback = await send('status');
assert.equal(rollback.active, false);
assert.equal(rollback.code, 'CLOCK_ROLLBACK');

fakeNow += 86400000;
const cleared = await send('clear');
assert.equal(cleared.active, false);
assert.equal(cleared.device.deviceCode, originalDeviceCode);
assert.equal((await send('status')).code, 'NO_LICENSE');

process.stdout.write(`${JSON.stringify({
  status: 'passed',
  checks: 7,
  activation: true,
  clockRollbackDetected: true,
  clearPreservesDeviceCode: true,
})}\n`);
