const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const manifest = JSON.parse(read('extension/manifest.json'));
const autoplay = read('extension/autoplay.js');
const hotfix = read('extension/autoplay-hotfix.js');
const css = read('extension/autoplay.css');
const scripts = manifest.content_scripts[0].js;
const styles = manifest.content_scripts[0].css;
const matches = manifest.content_scripts[0].matches;

assert.strictEqual(manifest.version, '0.9.8.2');
assert.ok(matches.includes('https://shnlfriberg.online/multi*'));
assert.ok(matches.includes('https://shnlfriberg.online/single*'));
assert.ok(manifest.host_permissions.includes('https://shnlfriberg.online/single*'));
assert.ok(styles.includes('autoplay.css'));
assert.ok(scripts.includes('autoplay.js'));
assert.ok(scripts.includes('autoplay-hotfix.js'));
assert.ok(scripts.indexOf('content-script.js') < scripts.indexOf('autoplay.js'));
assert.ok(scripts.indexOf('autoplay.js') < scripts.indexOf('autoplay-hotfix.js'));

assert.ok(autoplay.includes('state.mode = mode'));
assert.ok(autoplay.includes("mode === 'single' ? SINGLE_WINDOW_MS : MULTI_WINDOW_MS"));
assert.ok(autoplay.includes('ensureAutoReadyArmed'));
assert.ok(autoplay.includes('本次匹配托管：开'));
assert.ok(autoplay.includes('单人本局全自动：开'));
assert.ok(autoplay.includes("location.pathname.startsWith('/single')"));
assert.ok(autoplay.includes("document.querySelectorAll('.guess-progress')"));
assert.ok(autoplay.includes('bindSingleBoardIfUnique'));
assert.ok(autoplay.includes('candidates.length === 1'));
assert.ok(autoplay.includes("qolButton('fill-submit')"));
assert.ok(autoplay.includes('fastRefrezh'));
assert.ok(autoplay.includes('event.stopImmediatePropagation()'));
assert.ok(autoplay.includes('timeoutMs: 900'));
assert.ok(autoplay.includes("baseButton('submit')"));
assert.ok(autoplay.includes('ACTION_TIMEOUT_MS'));
assert.ok(autoplay.includes("disarm('插件报告了无法安全继续的页面状态。"));

assert.ok(hotfix.includes('Adapter.submitSelectedGuess'));
assert.ok(hotfix.includes("normalize(input.value) !== FIRST_GUESS"));
assert.ok(hotfix.includes('awaitingFirstProgress'));
assert.ok(hotfix.includes('refrezh 已自动提交'));
assert.ok(hotfix.includes("const SINGLE_NORMAL_ROUTE = '/single/normal'"));
assert.ok(hotfix.includes('单人完整版循环：开'));
assert.ok(hotfix.includes('uniqueAgainButton'));
assert.ok(hotfix.includes('ensureAutoplayArmed'));
assert.ok(hotfix.includes('loopCompleted'));
assert.ok(hotfix.includes('已离开“单人 · 完整版”实际对局页面'));

assert.ok(css.includes('.fa-autoplay'));
assert.ok(css.includes('grid-column: 1 / -1'));
assert.ok(css.includes('[data-armed="true"]'));

console.log(JSON.stringify({
  suite: 'autoplay-contract',
  version: manifest.version,
  routes: ['multi', 'single'],
  modes: ['current-match trustee', 'current single game autoplay', 'continuous normal single loop'],
  firstGuessSubmitBridge: true,
  status: 'passed',
}));
