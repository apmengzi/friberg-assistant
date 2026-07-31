'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('C:/Users/30369/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const projectRoot = path.resolve(__dirname, '..');

function startServer() {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
    const target = path.resolve(projectRoot, `.${pathname}`);
    if (!target.startsWith(`${projectRoot}${path.sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(target, (error, contents) => {
      if (error) {
        response.writeHead(404).end('Not found');
        return;
      }
      const type = path.extname(target) === '.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
      response.writeHead(200, { 'content-type': type }).end(contents);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/tests/fixtures/license-gate-harness.html`);
    const gate = page.locator('#friberg-license-gate');
    await gate.waitFor({ state: 'attached' });
    await gate.locator('h1').waitFor();
    assert.equal(await gate.locator('h1').textContent(), '弗一把助手 · 付费测试版');
    assert.equal(
      await gate.locator('#friberg-device-code').textContent(),
      'FRB-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AABB',
    );
    await gate.locator('textarea').fill('FRIBERG1.TEST.VALID');
    await gate.locator('#friberg-activate').click();
    assert.equal(await gate.locator('textarea').inputValue(), '');
    await page.waitForFunction(() => document.body.dataset.licenseActive === 'true');
    await page.waitForFunction(() => !document.getElementById('friberg-license-gate'));
    const messages = await page.evaluate(() => globalThis.__licenseMessages);
    assert.equal(messages[0].action, 'status');
    assert.equal(messages[1].action, 'activate');
    assert.equal(messages[1].licenseText, 'FRIBERG1.TEST.VALID');
    console.log(JSON.stringify({
      suite: 'license-gate-browser',
      inactiveGate: true,
      activation: true,
      rawLicenseRemovedFromDom: true,
      status: 'passed',
    }));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(cause => {
  console.error(cause);
  process.exitCode = 1;
});
