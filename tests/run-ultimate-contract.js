const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const manifest = JSON.parse(read('extension/manifest.json'));
const controller = read('extension/ultimate-controller.js');
const dom = read('extension/ultimate-dom.js');
const ui = read('extension/ultimate-ui.js');
const policySource = read('extension/ultimate-policy.js');
const Solver = require(path.join(root, 'solver.js'));
require(path.join(root, 'automation-core.js'));
const Policy = require(path.join(root, 'extension/ultimate-policy.js'));
const players = Solver.normalizeGamePlayers(JSON.parse(read('data/players.game-646.json')))
  .filter(player => player.enabled !== false);

assert.strictEqual(manifest.name, 'Friberg Ultimate Assistant');
assert.strictEqual(manifest.version, '1.1.0');
assert.deepStrictEqual(manifest.content_scripts[0].js, [
  'solver.js',
  'automation-core.js',
  'ultimate-policy.js',
  'ultimate-dom.js',
  'ultimate-ui.js',
  'ultimate-controller.js',
]);
assert.deepStrictEqual(manifest.content_scripts[0].css, ['ultimate-ui.css']);
assert.strictEqual(manifest.content_scripts[0].run_at, 'document_idle');
['overlay.js', 'live-qol.js', 'content-script.js', 'autoplay.js', 'autoplay-hotfix.js', 'race-controller.js', 'live-dom-adapter.js', 'feedback-parser-patch.js']
  .forEach(file => assert.ok(!manifest.content_scripts[0].js.includes(file), `${file} must not run in Ultimate`));

for (const token of [
  "SINGLE_ONCE: 'single-once'",
  "SINGLE_LOOP: 'single-loop'",
  "MULTI_SAFE: 'multi-safe'",
  "MULTI_RACE: 'multi-race'",
  'handleReadyCheck',
  'handleTerminal',
  'requestOneShot',
  'Dom.submitExact',
  'RETRY_AFTER_MS',
]) assert.ok(controller.includes(token), `controller missing ${token}`);

for (const token of [
  '.player-board-self',
  '.single-game-page',
  'table.game-table tbody > tr',
  'requestSubmit(surface.button)',
  'readyButton',
  'againButton',
  'roleFromText',
  'visibleGuess',
]) assert.ok(dom.includes(token), `DOM adapter missing ${token}`);

for (const token of [
  '单人本局自动',
  '单人连续循环',
  '多人稳健托管',
  '多人竞速托管',
  '填入并提交',
  '立即停止',
]) assert.ok(ui.includes(token), `UI missing ${token}`);

assert.ok(policySource.includes("OPENING = 'refrezh'"));
assert.ok(policySource.includes("SAFE: 'safe'"));
assert.ok(policySource.includes("RACE: 'race'"));
assert.ok(policySource.includes('rankDataDriftCandidates'));
assert.ok(policySource.includes('Automation.recommendNext'));
assert.strictEqual(players.length, 646);
assert.strictEqual(players.filter(player => Solver.normalize(player.nick) === 'refrezh').length, 1);
assert.strictEqual(Policy.opening, 'refrezh');

const opening = Policy.openingPlayer(players);
const depths = {};
let total = 0;
for (const target of players) {
  const history = [];
  const guessedKeys = new Set();
  let solved = false;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const recommendation = Policy.recommend({
      players,
      history,
      guessedKeys,
      remainingGuesses: 9 - attempt,
      strategy: Policy.strategies.RACE,
    });
    const guess = recommendation.player;
    const key = Solver.playerKey(guess);
    guessedKeys.add(key);
    if (key === Solver.playerKey(target)) {
      depths[attempt] = (depths[attempt] || 0) + 1;
      total += attempt;
      solved = true;
      break;
    }
    const colors = Solver.FIELD_ORDER.map(field => Solver.classifyFeedback(target, guess, field).color);
    const directions = Object.fromEntries(Array.from(Solver.NUMERIC_FIELDS, field => [
      field,
      Solver.classifyFeedback(target, guess, field).direction || 'none',
    ]));
    history.push(Solver.buildFeedback(guess, colors, directions));
  }
  assert.ok(solved, `${target.nick} must solve within 8 guesses in race strategy`);
}
assert.strictEqual(Object.values(depths).reduce((sum, value) => sum + value, 0), 646);
assert.ok(total / players.length < 3.2, 'race average must remain below 3.2 guesses');

const sampleTarget = players.find(player => Solver.normalize(player.nick) !== 'refrezh');
const sampleFeedback = Solver.buildFeedback(
  opening,
  Solver.FIELD_ORDER.map(field => Solver.classifyFeedback(sampleTarget, opening, field).color),
  Object.fromEntries(Array.from(Solver.NUMERIC_FIELDS, field => [
    field,
    Solver.classifyFeedback(sampleTarget, opening, field).direction || 'none',
  ])),
);
const safe = Policy.recommend({
  players,
  history: [sampleFeedback],
  guessedKeys: new Set([Solver.playerKey(opening)]),
  remainingGuesses: 7,
  strategy: Policy.strategies.SAFE,
});
assert.ok(safe.player);
assert.ok(safe.candidateCount > 0);

console.log(JSON.stringify({
  suite: 'ultimate-contract',
  version: manifest.version,
  players: players.length,
  raceDepths: depths,
  raceAverage: total / players.length,
  status: 'passed',
}));
