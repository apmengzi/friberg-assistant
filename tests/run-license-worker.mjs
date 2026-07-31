import assert from 'node:assert/strict';
import { TIERS, generateCardKey, normalizeCardKey, handleRequest } from '../commercial/license-worker/src/worker.js';

assert.deepEqual(
  Object.fromEntries(Object.entries(TIERS).map(([tier, value]) => [tier, value.seconds])),
  {
    '5h': 18000,
    '12h': 43200,
    '1d': 86400,
    '3d': 259200,
    '7d': 604800,
    '30d': 2592000,
  },
);

const keys = new Set();
for (let index = 0; index < 1000; index += 1) {
  const key = generateCardKey();
  assert.match(key, /^FRB-(?:[A-HJ-NP-Z2-9]{4}-){7}[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(normalizeCardKey(key).length, 35);
  assert.ok(!/[IO01]/.test(key));
  keys.add(key);
}
assert.equal(keys.size, 1000, 'generated cards must be unique in the sample');

const options = await handleRequest(new Request('https://license.test/v1/licenses/activate', {
  method: 'OPTIONS',
}), {});
assert.equal(options.status, 204);
assert.equal(await options.text(), '');

console.log(JSON.stringify({
  suite: 'license-worker',
  tiers: Object.keys(TIERS).length,
  uniqueCardSample: keys.size,
  entropyBitsApprox: 160,
  status: 'passed',
}));
