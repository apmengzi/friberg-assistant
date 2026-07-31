const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const manifest = JSON.parse(read('extension/manifest.json'));
const scripts = manifest.content_scripts[0].js;
const styles = manifest.content_scripts[0].css;
const qol = read('extension/live-qol.js');
const background = read('extension/background.js');
const qolCss = read('extension/live-qol.css');
const pool = JSON.parse(read('data/players.game-646.json'));

assert.strictEqual(manifest.version, '0.9.10');
assert.ok(manifest.permissions.includes('notifications'));
assert.ok(manifest.permissions.includes('tabs'));
assert.ok(scripts.includes('live-qol.js'));
assert.ok(styles.includes('live-qol.css'));
assert.ok(scripts.indexOf('overlay.js') < scripts.indexOf('live-qol.js'));
assert.ok(scripts.indexOf('live-qol.js') < scripts.indexOf('content-script.js'));
assert.strictEqual(pool.filter(player => String(player.nickname || player.nick || '').toLocaleLowerCase() === 'refrezh').length, 1);

assert.ok(qol.includes("/(?:我的猜测|我的竞猜)[^0-9]{0,40}(\\d+)\\s*\\/\\s*8\\b/i"));
assert.ok(qol.includes('firstZeroForIdentity'));
assert.ok(qol.includes('roundChanged || boardChanged || counterReturnedToZero || firstZeroForIdentity'));
assert.ok(qol.includes('首猜 refrezh：按当前小局 0/8 强制重置并重新绑定。'));
assert.ok(qol.includes("fillSpecificPlayer('refrezh'"));
assert.ok(qol.includes('baseFill.disabled'));
assert.ok(qol.includes('callbacks.onFillNext?.()'));
assert.ok(qol.includes('callbacks.onSubmitGuess?.()'));
assert.ok(qol.includes('data-fa-qol-action="fill-submit"'));
assert.ok(qol.includes('测试匹配通知'));
assert.ok(qol.includes('readyButtons.length !== 1'));
assert.ok(qol.includes('AUTO_READY_WINDOW_MS'));

assert.ok(background.includes('chrome.notifications.getPermissionLevel'));
assert.ok(background.includes('chrome.notifications.create'));
assert.ok(background.includes('chrome.notifications.onClicked'));
assert.ok(background.includes('chrome.windows.update'));
assert.ok(background.includes('chrome.tabs.update'));
assert.ok(background.includes('NOTIFICATION_ICON_URL'));

assert.ok(qolCss.includes('.fa-combined { grid-column: 1 / -1;'));
assert.ok(qolCss.includes('.fa-auto-ready { grid-column: 1 / -1;'));

console.log(JSON.stringify({
  suite: 'live-qol-contract',
  version: manifest.version,
  controls: ['refrezh-first', 'fill-submit', 'notifications', 'test-notification', 'auto-ready'],
  status: 'passed',
}));
