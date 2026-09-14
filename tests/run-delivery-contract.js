const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const extensionRoot = path.join(dist, 'friberg-assistant-extension');
const zip = path.join(dist, 'friberg-assistant-extension.zip');

assert.ok(fs.existsSync(path.join(extensionRoot, 'manifest.json')), 'unpacked extension root must contain manifest.json');
assert.ok(fs.existsSync(zip), 'extension ZIP must exist');
assert.ok(fs.existsSync(path.join(dist, 'friberg-assistant.user.js')), 'short ScriptCat script must exist');
assert.ok(fs.existsSync(path.join(dist, 'friberg-assistant-scriptcat.user.js')), 'ScriptCat-named script must exist');
['docs/INSTALL_EDGE.md', 'docs/INSTALL_SCRIPTCAT.md', 'docs/USAGE_REAL_SITE.md', 'docs/implementation-validation.md', 'OPEN_EXTENSION_FOLDER.bat', 'OPEN_INSTALL_GUIDE.bat'].forEach(relative => {
  assert.ok(fs.existsSync(path.join(root, relative)), `${relative} must be delivered`);
});

const entries = childProcess.execFileSync('tar', ['-tf', zip], { encoding: 'utf8' }).trim().split(/\r?\n/);
assert.ok(entries.includes('manifest.json'), 'ZIP root must contain manifest.json');
assert.ok(!entries.some(entry => /^friberg-assistant-extension\//.test(entry)), 'ZIP must not nest the extension root directory');

console.log(JSON.stringify({
  suite: 'delivery-contract',
  zipEntries: entries.length,
  manifestAtUnpackedRoot: true,
  manifestAtZipRoot: true,
  status: 'passed',
}));
