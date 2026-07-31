const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const manifest = JSON.parse(read('extension/manifest.json'));
const pool = JSON.parse(read('data/players.game-646.json'));
const scripts = manifest.content_scripts[0].js;
const qol = read('extension/live-qol.js');
const background = read('extension/background.js');

assert.strictEqual(manifest.version, '0.9.5');
assert.ok(manifest.permissions.includes('notifications'));
assert.ok(manifest.permissions.includes('tabs'));
assert.ok(scripts.includes('live-qol.js'));
assert.ok(scripts.indexOf('overlay.js') < scripts.indexOf('live-qol.js'));
assert.ok(scripts.indexOf('live-qol.js') < scripts.indexOf('content-script.js'));
assert.strictEqual(pool.filter(player => String(player.nickname || player.nick || '').toLocaleLowerCase() === 'refrezh').length, 1, 'bundled pool must contain one refrezh');

assert.ok(qol.includes("dispatchEvent(new CustomEvent('friberg:force-rescan'"));
assert.ok(qol.includes('currentVisibleSelfBoard'));
assert.ok(qol.includes('board !== state.lastVisibleSelfBoard'));
assert.ok(qol.includes("fillSpecificPlayer('refrezh'"));
assert.ok(qol.includes("data-fa-qol-action=\"refrezh-first\""));
assert.ok(qol.includes("data-fa-qol-action=\"fill-submit\""));
assert.ok(qol.includes('callbacks.onFillNext?.()'));
assert.ok(qol.includes('callbacks.onSubmitGuess?.()'));
assert.ok(qol.includes('readyButtons.length !== 1'));
assert.ok(qol.includes('AUTO_READY_WINDOW_MS'));
assert.ok(qol.includes('state.autoReadyUntil = 0'));
assert.ok(qol.includes("type: 'friberg:desktop-notification'"));
assert.ok(qol.includes('state.notifiedFingerprint !== fingerprint'));
assert.ok(qol.includes('state.actionBusy'));

assert.ok(background.includes("message?.type === 'friberg:desktop-notification'"));
assert.ok(background.includes('chrome.notifications.create'));
assert.ok(background.includes('chrome.notifications.onClicked'));
assert.ok(background.includes('chrome.windows.update'));
assert.ok(background.includes('chrome.tabs.update'));
assert.ok(background.includes('notificationTargets.delete'));
assert.ok(background.includes("data:image/png;base64,"));
assert.ok(!background.includes('notification-icon.svg'));

console.log(JSON.stringify({
  suite: 'live-qol-contract',
  version: manifest.version,
  controls: ['refrezh-first', 'fill-submit', 'notifications', 'auto-ready'],
  status: 'passed',
}));
