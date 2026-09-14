'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('C:/Users/30369/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const projectRoot = path.resolve(__dirname, '..');
const extensionPath = path.join(projectRoot, 'dist', 'friberg-assistant-commercial');
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'friberg-commercial-extension-'));

(async () => {
  const context = await chromium.launchPersistentContext(profilePath, {
    headless: true,
    channel: 'chromium',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  try {
    let workers = context.serviceWorkers();
    if (!workers.length) {
      workers = [await context.waitForEvent('serviceworker', { timeout: 10000 })];
    }
    const worker = workers.find(candidate => candidate.url().startsWith('chrome-extension://'));
    assert.ok(worker, 'commercial extension service worker must start');
    const device = await worker.evaluate(() => getDeviceInfo());
    assert.match(device.deviceCode, /^FRB-(?:[A-Z2-7]{4}-){6}[A-Z2-7]{4}$/);
    const status = await worker.evaluate(() => verifyStoredLicense('browser-load-test'));
    assert.equal(status.active, false);
    assert.equal(status.code, 'NO_LICENSE');
    assert.equal(status.device.deviceCode, device.deviceCode);

    console.log(JSON.stringify({
      suite: 'commercial-extension-browser-load',
      manifestV3Worker: true,
      deviceCodeGenerated: true,
      unlicensedCoreLocked: true,
      status: 'passed',
    }));
  } finally {
    await context.close();
    fs.rmSync(profilePath, { recursive: true, force: true });
  }
})().catch(cause => {
  console.error(cause);
  process.exitCode = 1;
});
