const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const extensionRoot = path.join(dist, 'friberg-assistant-extension');
const zip = path.join(dist, 'friberg-assistant-extension.zip');
const expected = [
  'manifest.json',
  'solver.js',
  'race-policy.js',
  'race-controller.js',
  'data/game-players-646.json',
];

assert.ok(fs.existsSync(path.join(extensionRoot, 'manifest.json')), 'unpacked extension root must contain manifest.json');
assert.ok(fs.existsSync(zip), 'extension ZIP must exist');
for (const relative of expected) {
  assert.ok(fs.existsSync(path.join(extensionRoot, ...relative.split('/'))), `${relative} must be shipped`);
}

const unpacked = fs.readdirSync(extensionRoot, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile())
  .map(entry => path.relative(extensionRoot, path.join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
  .sort();
assert.deepStrictEqual(unpacked, expected.slice().sort(), 'Race Lite must ship only the three runtime scripts and official pool');

const entries = childProcess.execFileSync('tar', ['-tf', zip], { encoding: 'utf8' })
  .trim().split(/\r?\n/).filter(Boolean).map(entry => entry.replace(/\\/g, '/'));
assert.ok(entries.includes('manifest.json'), 'ZIP root must contain manifest.json');
assert.ok(!entries.some(entry => /^friberg-assistant-extension\//.test(entry)), 'ZIP must not nest the extension root directory');
for (const relative of expected) assert.ok(entries.includes(relative), `ZIP must contain ${relative}`);
assert.ok(!entries.some(entry => /(?:autoplay|overlay|live-qol|content-script|background|options|live-dom-adapter|feedback-parser)/i.test(entry)), 'ZIP must exclude legacy and generic DOM files');

console.log(JSON.stringify({
  suite: 'race-lite-delivery-contract',
  shippedFiles: unpacked,
  zipEntries: entries.length,
  status: 'passed',
}));
