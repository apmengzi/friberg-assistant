const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const manifest = JSON.parse(read('extension/manifest.json'));
const controller = read('extension/race-controller.js');
const policySource = read('extension/race-policy.js');
const Solver = require(path.join(root, 'solver.js'));
const Policy = require(path.join(root, 'extension/race-policy.js'));
const raw = JSON.parse(read('data/players.game-646.json'));
const players = Solver.normalizeGamePlayers(raw).filter(player => player.enabled !== false);
const scripts = manifest.content_scripts[0].js;

assert.strictEqual(manifest.version, '1.0.1');
assert.strictEqual(manifest.name, 'Friberg Race Lite');
assert.deepStrictEqual(manifest.host_permissions, ['https://shnlfriberg.online/multi*']);
assert.deepStrictEqual(scripts, [
  'solver.js',
  'race-policy.js',
  'race-controller.js',
]);
assert.strictEqual(manifest.content_scripts[0].run_at, 'document_start');
['live-dom-adapter.js', 'feedback-parser-patch.js', 'overlay.js', 'live-qol.js', 'content-script.js', 'autoplay.js', 'autoplay-hotfix.js', 'instant-next.js', 'automation-core.js']
  .forEach(file => assert.ok(!scripts.includes(file), `${file} must not run in race build`));

assert.ok(controller.includes('.player-board-self'));
assert.ok(controller.includes('tbody > tr'));
assert.ok(controller.includes('form.input-bar'));
assert.ok(controller.includes('requestSubmit(controls.button)'));
assert.ok(controller.includes('officialRows'));
assert.ok(controller.includes('serverVisibleGuess'));
assert.ok(controller.includes('rankDataDriftCandidates'));
assert.ok(controller.includes('roleFromText'));
assert.ok(controller.includes("'AWPer'"));
assert.ok(controller.includes("'Coach'"));
assert.ok(controller.includes("'Rifler'"));
assert.ok(controller.includes('FALLBACK_MS = 8'));
assert.ok(controller.includes('RETRY_MS = 8'));
assert.ok(controller.includes('MutationObserver'));
assert.ok(controller.includes('requestAnimationFrame(drive)'));
assert.ok(controller.includes('Solver.buildFeedback(guess'));
assert.ok(!controller.includes('exactOptions'));
assert.ok(!controller.includes("new MouseEvent('mousedown'"));
assert.ok(!controller.includes('WebSocket'));
assert.ok(!controller.includes('socket.emit'));
assert.ok(!controller.includes('chrome.notifications'));

assert.ok(policySource.includes("opening: 'refrezh'"));
assert.ok(policySource.includes('expectedWrongRemaining'));
assert.ok(policySource.includes('signatureCache'));
assert.strictEqual(players.length, 646);
assert.strictEqual(Policy.poolSize, 646);
assert.strictEqual(Policy.opening, 'refrezh');
assert.strictEqual(Policy.exactAtMostTwo, 268);

const opening = players.find(player => Solver.normalize(player.nick) === 'refrezh');
assert.ok(opening, 'refrezh must exist exactly once');
const depth = {};
let total = 0;
for (const target of players) {
  let guess = opening;
  const feedbacks = [];
  const guessedKeys = new Set();
  let attempts = 0;
  while (attempts < 8) {
    attempts += 1;
    const guessKey = Solver.playerKey(guess);
    guessedKeys.add(guessKey);
    if (guessKey === Solver.playerKey(target)) break;
    const colors = Solver.FIELD_ORDER.map(field => Solver.classifyFeedback(target, guess, field).color);
    const directions = Object.fromEntries(Array.from(Solver.NUMERIC_FIELDS, field => [
      field,
      Solver.classifyFeedback(target, guess, field).direction || 'none',
    ]));
    feedbacks.push(Solver.buildFeedback(guess, colors, directions));
    const candidates = Solver.filterCandidates(players, feedbacks, guessedKeys);
    guess = Policy.choose({ Solver, candidates, guessedKeys });
    assert.ok(guess, `policy must continue for ${target.nick}`);
  }
  assert.ok(attempts <= 6, `${target.nick} should finish within six guesses`);
  depth[attempts] = (depth[attempts] || 0) + 1;
  total += attempts;
}

assert.deepStrictEqual(depth, { 1: 1, 2: 267, 3: 287, 4: 79, 5: 11, 6: 1 });
assert.strictEqual(depth[1] + depth[2], 268);
assert.ok(Math.abs(total / players.length - 2.7445820433436534) < 1e-12);

console.log(JSON.stringify({
  suite: 'race-lite-contract',
  version: manifest.version,
  scripts,
  depth,
  atMostTwo: depth[1] + depth[2],
  atMostTwoRate: (depth[1] + depth[2]) / players.length,
  averageGuesses: total / players.length,
  status: 'passed',
}));
