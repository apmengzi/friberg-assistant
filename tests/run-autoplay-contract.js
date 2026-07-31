const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const manifest = JSON.parse(read('extension/manifest.json'));
const autoplay = read('extension/direct-autoplay.js');
const css = read('extension/autoplay.css');
const scripts = manifest.content_scripts[0].js;
const styles = manifest.content_scripts[0].css;
const matches = manifest.content_scripts[0].matches;

assert.strictEqual(manifest.version, '0.9.10');
assert.ok(matches.includes('https://shnlfriberg.online/multi*'));
assert.ok(matches.includes('https://shnlfriberg.online/single*'));
assert.ok(manifest.host_permissions.includes('https://shnlfriberg.online/single*'));
assert.ok(styles.includes('autoplay.css'));
assert.ok(scripts.includes('direct-autoplay.js'));
assert.ok(!scripts.includes('autoplay.js'));
assert.ok(!scripts.includes('autoplay-hotfix.js'));
assert.ok(!scripts.includes('instant-next.js'));
assert.ok(scripts.indexOf('content-script.js') < scripts.indexOf('direct-autoplay.js'));

assert.ok(autoplay.includes("const FIRST_GUESS = 'refrezh'"));
assert.ok(autoplay.includes('FALLBACK_MS = 16'));
assert.ok(autoplay.includes('MutationObserver'));
assert.ok(autoplay.includes('requestAnimationFrame'));
assert.ok(autoplay.includes('state.mode = kind'));
assert.ok(autoplay.includes("kind === 'single' ? SINGLE_WINDOW_MS : MULTI_WINDOW_MS"));
assert.ok(autoplay.includes('ensureAutoReady'));
assert.ok(autoplay.includes('本次匹配托管：开'));
assert.ok(autoplay.includes('单人本局全自动：开'));
assert.ok(autoplay.includes("location.pathname.startsWith('/single')"));
assert.ok(autoplay.includes("document.querySelectorAll('.guess-progress')"));
assert.ok(autoplay.includes('bindSingleBoard'));
assert.ok(autoplay.includes('Adapter.fillAndSelectUniqueOption'));
assert.ok(autoplay.includes('directSubmitButton'));
assert.ok(autoplay.includes('button.disabled'));
assert.ok(autoplay.includes('count === 0) return FIRST_GUESS'));
assert.ok(autoplay.includes('recommendationAtProgressStart'));
assert.ok(autoplay.includes('guessedNicknames'));
assert.ok(autoplay.includes('phase: \'filling\''));
assert.ok(autoplay.includes("action.phase = 'selected'"));
assert.ok(autoplay.includes("action.phase = 'submitted'"));
assert.ok(autoplay.includes('单人完整版循环：开'));
assert.ok(autoplay.includes('AGAIN_RE'));
assert.ok(autoplay.includes('loopCompleted'));
assert.ok(autoplay.includes('已提前完成输入和下拉选择'));
assert.ok(autoplay.includes('冷却结束的第一刻直接提交'));

assert.ok(css.includes('.fa-autoplay'));
assert.ok(css.includes('grid-column: 1 / -1'));
assert.ok(css.includes('[data-armed="true"]'));

console.log(JSON.stringify({
  suite: 'autoplay-contract',
  version: manifest.version,
  routes: ['multi', 'single'],
  modes: ['current-match trustee', 'current single game autoplay', 'continuous normal single loop'],
  raceStrategy: true,
  controllerCount: 1,
  fixedOpening: 'refrezh',
  fillBeforeCooldownEnds: true,
  eventDrivenSubmit: true,
  status: 'passed',
}));
