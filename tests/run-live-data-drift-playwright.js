'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('C:/Users/30369/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

let base = process.argv[2] || '';
const projectRoot = path.resolve(__dirname, '..');

function startFixtureServer() {
  const types = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
    const target = path.resolve(projectRoot, `.${pathname}`);
    if (!target.startsWith(`${projectRoot}${path.sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(target, (error, contents) => {
      if (error) {
        response.writeHead(error.code === 'ENOENT' ? 404 : 500).end(error.code || 'Error');
        return;
      }
      response.writeHead(200, { 'content-type': types[path.extname(target)] || 'application/octet-stream' });
      response.end(contents);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function easyRoundMarkup() {
  const arrow = direction => `<svg class="lucide lucide-arrow-${direction}" aria-hidden="true"></svg>`;
  const row = (nickname, team, country, age, ageClass, ageDirection, role, wins, apps, appsDirection) => `
    <tr><td>${nickname}</td><td class="wrong">${team}</td><td class="wrong">${country}</td>
    <td class="${ageClass}">${age}${arrow(ageDirection)}</td><td class="${role === '步枪手' ? 'correct' : 'wrong'}">${role}</td>
    <td class="correct">${wins}</td><td class="wrong">${apps}${arrow(appsDirection)}</td><td class="correct">现役</td></tr>`;
  return `<section class="card player-board player-board-self"><h2>我的猜测 <span>3/8</span></h2>
    <table class="game-table"><thead><tr><th>昵称</th><th>队伍</th><th>国家或地区</th><th>年龄</th><th>位置</th><th>Major 冠军数</th><th>Major 次数</th><th>状态</th></tr></thead><tbody>
    ${row('frozen', 'FaZe Clan', '斯洛伐克', 24, 'wrong', 'up', '步枪手', 0, 8, 'down')}
    ${row('kngv', 'O Plano', '巴西', 33, 'wrong', 'down', '狙击手', 0, 2, 'up')}
    ${row('summer', 'Rare Atom', '中国', 29, 'close', 'down', '步枪手', 0, 6, 'down')}
    </tbody></table></section>`;
}

function aumanRoundMarkup() {
  const arrow = direction => direction === 'none' ? '' : `<svg class="lucide lucide-arrow-${direction}" aria-hidden="true"></svg>`;
  const row = ({ nick, team, teamColor, country, countryColor, age, ageColor, ageDirection, role, roleColor, wins = 0, apps, appsColor, appsDirection = 'none' }) => `
    <tr><td>${nick}</td><td class="${teamColor}">${team}</td><td class="${countryColor}">${country}</td>
    <td class="${ageColor}">${age}${arrow(ageDirection)}</td><td class="${roleColor}">${role}</td>
    <td class="correct">${wins}</td><td class="${appsColor}">${apps}${arrow(appsDirection)}</td><td class="correct">现役</td></tr>`;
  const rows = [
    { nick: 'AW', team: 'magic', teamColor: 'wrong', country: '俄罗斯', countryColor: 'wrong', age: 20, ageColor: 'wrong', ageDirection: 'up', role: '步枪手', roleColor: 'wrong', apps: 1, appsColor: 'correct' },
    { nick: 'nawwk', team: '未签约/已下放', teamColor: 'correct', country: '瑞典', countryColor: 'wrong', age: 28, ageColor: 'wrong', ageDirection: 'up', role: '狙击手', roleColor: 'wrong', apps: 3, appsColor: 'wrong', appsDirection: 'down' },
    { nick: 'hardstyle', team: '未签约/已下放', teamColor: 'correct', country: '土耳其', countryColor: 'close', age: 43, ageColor: 'wrong', ageDirection: 'down', role: '教练', roleColor: 'correct', apps: 1, appsColor: 'correct' },
    { nick: 'Jamyoung', team: 'TYLOO', teamColor: 'wrong', country: '中国', countryColor: 'correct', age: 25, ageColor: 'wrong', ageDirection: 'up', role: '步枪手', roleColor: 'wrong', apps: 3, appsColor: 'wrong', appsDirection: 'down' },
    { nick: 'marek', team: 'Rare Atom', teamColor: 'wrong', country: '中国', countryColor: 'correct', age: 30, ageColor: 'close', ageDirection: 'up', role: '教练', roleColor: 'correct', apps: 1, appsColor: 'correct' },
    { nick: 'jnt', team: '未签约/已下放', teamColor: 'correct', country: '巴西', countryColor: 'wrong', age: 32, ageColor: 'correct', ageDirection: 'none', role: '教练', roleColor: 'correct', apps: 1, appsColor: 'correct' },
    { nick: 'zhokiNg', team: 'TYLOO', teamColor: 'wrong', country: '中国', countryColor: 'correct', age: 32, ageColor: 'correct', ageDirection: 'none', role: '教练', roleColor: 'correct', apps: 1, appsColor: 'correct' },
  ];
  return `<section class="card player-board player-board-self"><h2>我的猜测 <span>7/8</span></h2>
    <table class="game-table"><thead><tr><th>昵称</th><th>队伍</th><th>国家或地区</th><th>年龄</th><th>位置</th><th>Major 冠军数</th><th>Major 次数</th><th>状态</th></tr></thead>
    <tbody>${rows.map(row).join('')}</tbody></table></section>`;
}

async function verifyMovableWindow(page, {
  hostSelector,
  handleSelector,
  collapseSelector,
  collapsedState,
  bodySelector,
  storedLayout,
}) {
  const host = page.locator(hostSelector);
  const handle = page.locator(handleSelector);
  const before = await host.boundingBox();
  const grip = await handle.boundingBox();
  assert.ok(before && grip, 'assistant window and drag handle must be visible');
  await page.mouse.move(grip.x + 42, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(Math.max(180, grip.x - 220), Math.min(720, grip.y + 140), { steps: 8 });
  await page.mouse.up();
  const moved = await host.boundingBox();
  assert.ok(Math.abs(moved.x - before.x) > 80 || Math.abs(moved.y - before.y) > 80, 'dragging the header must move the assistant');

  await page.locator(collapseSelector).click();
  await page.waitForFunction(collapsedState);
  await page.waitForTimeout(220);
  const collapsed = await host.boundingBox();
  assert.ok(collapsed.width <= 212, 'collapsed assistant must leave only a compact restore strip');
  assert.equal(await page.locator(bodySelector).isVisible(), false);
  const persisted = await page.evaluate(storedLayout);
  assert.equal(persisted.collapsed, true);
  assert.ok(Number.isFinite(persisted.x) && Number.isFinite(persisted.y));
  await page.locator(collapseSelector).click();
}

async function verifyFirstGuessControls(page, { randomSelector, submitSelector }) {
  await page.locator(randomSelector).click();
  await page.waitForFunction(() => document.querySelector('#guess-input')?.value.length > 0);
  await page.waitForFunction(() => window.__fixtureSelected === document.querySelector('#guess-input')?.value);
  assert.equal(await page.evaluate(() => window.__fixtureSubmitClicks), 0, 'filling a random first guess must not auto-submit');
  await page.locator(submitSelector).click();
  await page.waitForFunction(() => window.__fixtureSubmitClicks === 1);
  assert.equal(await page.locator(submitSelector).isDisabled(), true, 'submit must lock while waiting for a feedback row');
}

async function verifyTextOnlySubmit(page, { randomSelector, submitSelector }) {
  await page.evaluate(() => { window.__fixtureDisableDropdown = true; });
  await page.locator(randomSelector).click();
  await page.waitForFunction(() => document.querySelector('#guess-input')?.value.length > 0);
  assert.equal(await page.locator('#player-options [role="option"]').count(), 0, 'text-only fixture must not render a dropdown');
  await page.locator(submitSelector).click();
  await page.waitForFunction(() => window.__fixtureSubmitClicks === 1);
  assert.equal(await page.locator(submitSelector).isDisabled(), true);
}

async function verifyCooldownQueue(page, { randomSelector, submitSelector }) {
  await page.locator(randomSelector).click();
  await page.waitForFunction(() => document.querySelector('#guess-input')?.value.length > 0);
  await page.evaluate(() => { document.querySelector('#submit-guess').disabled = true; });
  await page.waitForFunction(selector => !document.querySelector(selector)?.disabled, submitSelector);
  await page.locator(submitSelector).click();
  assert.equal(await page.evaluate(() => window.__fixtureSubmitClicks), 0, 'cooldown click must be queued, not discarded');
  assert.match(await page.locator(submitSelector).textContent(), /CD|冷却/);
  await page.evaluate(() => {
    setTimeout(() => { document.querySelector('#submit-guess').disabled = false; }, 350);
  });
  await page.waitForFunction(() => window.__fixtureSubmitClicks === 1);
  assert.equal(await page.locator(submitSelector).isDisabled(), true, 'queued submit must lock after the original button is clicked once');
}

async function verifyVisibleCooldownQueue(page, { randomSelector, submitSelector }) {
  await page.locator(randomSelector).click();
  await page.waitForFunction(() => document.querySelector('#guess-input')?.value.length > 0);
  await page.evaluate(() => {
    document.querySelector('#fixture-cooldown').textContent = '猜测间隔：还需等待 0.6 秒';
  });
  await page.locator(submitSelector).click();
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.__fixtureSubmitClicks), 0, 'visible site cooldown must prevent an early click');
  assert.match(await page.locator(submitSelector).textContent(), /CD|冷却/);
  await page.evaluate(() => {
    setTimeout(() => { document.querySelector('#fixture-cooldown').textContent = ''; }, 450);
  });
  await page.waitForFunction(() => window.__fixtureSubmitClicks === 1);
  assert.equal(await page.locator(submitSelector).isDisabled(), true, 'visible cooldown queue must submit exactly once');
}

async function waitForDisabledState(locator, expected, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await locator.isDisabled() === expected) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await locator.isDisabled(), expected, `button disabled state must become ${expected}`);
}

async function verifyBo3RoundReset(page, { randomSelector }) {
  const random = page.locator(randomSelector);
  await page.evaluate(() => window.fixtureBoard({ unknown: true }));
  await waitForDisabledState(random, true);
  await page.evaluate(() => {
    document.querySelector('#fixture-round').firstChild.nodeValue = '第 2 局 · 先胜 2 局';
    document.querySelector('.player-board-self h2 span').firstChild.nodeValue = '0/8';
    document.querySelectorAll('.player-board-self tbody tr').forEach(row => { row.style.display = 'none'; });
  });
  await waitForDisabledState(random, false);
  await random.click();
  await page.waitForFunction(() => document.querySelector('#guess-input')?.value.length > 0);
}

(async () => {
  const fixtureServer = process.argv[2] ? null : await startFixtureServer();
  if (fixtureServer) base = `http://127.0.0.1:${fixtureServer.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const extension = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await extension.goto(`${base}/tests/fixtures/live-assist-extension-harness.html`, { waitUntil: 'networkidle' });
    await extension.waitForSelector('#friberg-assistant-overlay');
    await verifyMovableWindow(extension, {
      hostSelector: '#friberg-assistant-overlay',
      handleSelector: '#friberg-assistant-overlay [data-fa-drag-handle]',
      collapseSelector: '#friberg-assistant-overlay [data-fa-window="collapse"]',
      collapsedState: () => document.querySelector('#friberg-assistant-overlay')?.dataset.collapsed === 'true',
      bodySelector: '#friberg-assistant-overlay .fa-body',
      storedLayout: () => window.__fixtureChromeStorage.fribergAssistantOverlayLayoutV1,
    });
    await verifyFirstGuessControls(extension, {
      randomSelector: '#friberg-assistant-overlay [data-fa-action="random-first"]',
      submitSelector: '#friberg-assistant-overlay [data-fa-action="submit"]',
    });
    await extension.reload({ waitUntil: 'networkidle' });
    await extension.waitForSelector('#friberg-assistant-overlay');
    await verifyCooldownQueue(extension, {
      randomSelector: '#friberg-assistant-overlay [data-fa-action="random-first"]',
      submitSelector: '#friberg-assistant-overlay [data-fa-action="submit"]',
    });
    await extension.reload({ waitUntil: 'networkidle' });
    await extension.waitForSelector('#friberg-assistant-overlay');
    await verifyVisibleCooldownQueue(extension, {
      randomSelector: '#friberg-assistant-overlay [data-fa-action="random-first"]',
      submitSelector: '#friberg-assistant-overlay [data-fa-action="submit"]',
    });
    await extension.reload({ waitUntil: 'networkidle' });
    await extension.waitForSelector('#friberg-assistant-overlay');
    await verifyBo3RoundReset(extension, {
      randomSelector: '#friberg-assistant-overlay [data-fa-action="random-first"]',
    });
    await extension.reload({ waitUntil: 'networkidle' });
    await extension.waitForSelector('#friberg-assistant-overlay');
    await verifyTextOnlySubmit(extension, {
      randomSelector: '#friberg-assistant-overlay [data-fa-action="random-first"]',
      submitSelector: '#friberg-assistant-overlay [data-fa-action="submit"]',
    });
    await extension.reload({ waitUntil: 'networkidle' });
    await extension.waitForSelector('#friberg-assistant-overlay');
    await extension.evaluate(markup => {
      document.querySelector('#fixture-stage').innerHTML = markup;
      document.querySelector('#fixture-state').textContent = '我的猜测';
    }, easyRoundMarkup());
    await extension.waitForFunction(() => document.querySelector('[data-fa-next]')?.textContent.includes('brehze'));
    assert.equal(await extension.locator('[data-fa-candidates]').innerText(), '1');
    const parsed = await extension.evaluate(() => {
      const rows = FribergLiveDomAdapter.feedbackRows(document.querySelector('.player-board-self'));
      const reading = FribergLiveDomAdapter.readFeedbackRow(rows[1]);
      return { valid: reading.valid, team: reading.visibleValues.team, role: reading.visibleValues.role };
    });
    assert.deepEqual(parsed, { valid: true, team: 'O Plano', role: '狙击手' });
    await extension.reload({ waitUntil: 'networkidle' });
    await extension.waitForSelector('#friberg-assistant-overlay');
    await extension.evaluate(markup => {
      document.querySelector('#fixture-stage').innerHTML = markup;
      document.querySelector('#fixture-state').textContent = '我的猜测';
    }, aumanRoundMarkup());
    await extension.waitForFunction(() => document.querySelector('[data-fa-next]')?.textContent.includes('auman'));
    assert.equal(await extension.locator('[data-fa-candidates]').innerText(), '1');
    assert.match(await extension.locator('[data-fa-detail]').innerText(), /team|role|status/);

    const scriptcat = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await scriptcat.goto(`${base}/tests/fixtures/live-assist-scriptcat-harness.html`, { waitUntil: 'networkidle' });
    await scriptcat.waitForSelector('#friberg-scriptcat-assistant');
    await verifyMovableWindow(scriptcat, {
      hostSelector: '#friberg-scriptcat-assistant',
      handleSelector: '#friberg-scriptcat-assistant [data-drag-handle]',
      collapseSelector: '#friberg-scriptcat-assistant [data-window="collapse"]',
      collapsedState: () => document.querySelector('#friberg-scriptcat-assistant')?.shadowRoot?.querySelector('.panel')?.dataset.collapsed === 'true',
      bodySelector: '#friberg-scriptcat-assistant .body',
      storedLayout: () => window.__fixtureGmStorage['friberg-scriptcat-layout-v1'],
    });
    await verifyFirstGuessControls(scriptcat, {
      randomSelector: '#friberg-scriptcat-assistant [data-action="random-first"]',
      submitSelector: '#friberg-scriptcat-assistant [data-action="submit"]',
    });
    await scriptcat.reload({ waitUntil: 'networkidle' });
    await scriptcat.waitForSelector('#friberg-scriptcat-assistant');
    await verifyCooldownQueue(scriptcat, {
      randomSelector: '#friberg-scriptcat-assistant [data-action="random-first"]',
      submitSelector: '#friberg-scriptcat-assistant [data-action="submit"]',
    });
    await scriptcat.reload({ waitUntil: 'networkidle' });
    await scriptcat.waitForSelector('#friberg-scriptcat-assistant');
    await verifyVisibleCooldownQueue(scriptcat, {
      randomSelector: '#friberg-scriptcat-assistant [data-action="random-first"]',
      submitSelector: '#friberg-scriptcat-assistant [data-action="submit"]',
    });
    await scriptcat.reload({ waitUntil: 'networkidle' });
    await scriptcat.waitForSelector('#friberg-scriptcat-assistant');
    await verifyBo3RoundReset(scriptcat, {
      randomSelector: '#friberg-scriptcat-assistant [data-action="random-first"]',
    });
    await scriptcat.reload({ waitUntil: 'networkidle' });
    await scriptcat.waitForSelector('#friberg-scriptcat-assistant');
    await verifyTextOnlySubmit(scriptcat, {
      randomSelector: '#friberg-scriptcat-assistant [data-action="random-first"]',
      submitSelector: '#friberg-scriptcat-assistant [data-action="submit"]',
    });
    await scriptcat.reload({ waitUntil: 'networkidle' });
    await scriptcat.waitForSelector('#friberg-scriptcat-assistant');
    await scriptcat.evaluate(markup => {
      document.querySelector('#fixture-stage').innerHTML = markup;
      document.querySelector('#fixture-state').textContent = '我的猜测';
    }, easyRoundMarkup());
    await scriptcat.waitForFunction(() => document.querySelector('#friberg-scriptcat-assistant')?.shadowRoot?.querySelector('[data-next]')?.textContent.includes('brehze'));
    assert.equal(
      await scriptcat.evaluate(() => document.querySelector('#friberg-scriptcat-assistant').shadowRoot.querySelector('[data-candidates]').textContent),
      '1',
    );
    await scriptcat.reload({ waitUntil: 'networkidle' });
    await scriptcat.waitForSelector('#friberg-scriptcat-assistant');
    await scriptcat.evaluate(markup => {
      document.querySelector('#fixture-stage').innerHTML = markup;
      document.querySelector('#fixture-state').textContent = '我的猜测';
    }, aumanRoundMarkup());
    await scriptcat.waitForFunction(() => document.querySelector('#friberg-scriptcat-assistant')?.shadowRoot?.querySelector('[data-next]')?.textContent.includes('auman'));
    assert.equal(
      await scriptcat.evaluate(() => document.querySelector('#friberg-scriptcat-assistant').shadowRoot.querySelector('[data-candidates]').textContent),
      '1',
    );
  } finally {
    await browser.close();
    if (fixtureServer) await new Promise(resolve => fixtureServer.close(resolve));
  }
  console.log('PASS: extension and ScriptCat dropdown/text-only/visible-cooldown submit, BO3 reset, drag/collapse, brehze, and auman browser replays passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
