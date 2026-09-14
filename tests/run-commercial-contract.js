const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const commercial = path.join(root, 'dist', 'friberg-assistant-commercial');
const freeManifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(commercial, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
const readCommercial = name => fs.readFileSync(path.join(commercial, name), 'utf8');

assert.ok(fs.existsSync(path.join(commercial, 'manifest.json')));
assert.equal(manifest.version, '0.9.2');
assert.ok(manifest.name.includes('Offline Licensed Edition'));
assert.deepEqual(manifest.content_scripts[0].js.slice(0, 3), ['license-config.js', 'license-core.js', 'solver.js']);
assert.ok(manifest.content_scripts[0].js.indexOf('license-client.js') < manifest.content_scripts[0].js.indexOf('content-script.js'));
assert.ok(readCommercial('background.js').includes('verifyStoredLicense'));
assert.ok(readCommercial('license-core.js').includes("name: 'Ed25519'"));
assert.ok(readCommercial('license-client.js').includes('requireActiveLicense'));
assert.ok(readCommercial('license-client.js').includes('安装实例绑定'));
assert.ok(!readCommercial('license-config.js').includes('127.0.0.1'));
assert.deepEqual(manifest.permissions, ['storage']);
assert.deepEqual(manifest.host_permissions, ['https://shnlfriberg.online/multi*']);

const distributedText = [
  readCommercial('background.js'),
  readCommercial('license-client.js'),
  readCommercial('license-config.js'),
].join('\n');
assert.ok(!distributedText.includes('LICENSE_PEPPER'));
assert.ok(!distributedText.includes('ADMIN_TOKEN'));
assert.ok(!distributedText.includes('BEGIN PRIVATE KEY'));
assert.ok(!freeManifest.content_scripts[0].js.includes('license-client.js'));
assert.ok(!freeManifest.name.includes('Licensed Edition'));

console.log(JSON.stringify({
  suite: 'commercial-contract',
  licenseMode: 'offline-ed25519',
  freeBuildSeparated: true,
  serverSecretsShipped: false,
  status: 'passed',
}));
