const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const Solver = require(path.join(root, 'solver.js'));
const Automation = require(path.join(root, 'automation-core.js'));
globalThis.GameSolver = Solver;
globalThis.FribergAutomation = Automation;
require(path.join(root, 'extension/speed-strategy.js'));

const Speed = globalThis.FribergSpeedStrategy;
const raw = require(path.join(root, 'data/players.game-646.json'));
const players = Solver.normalizeGamePlayers(raw).filter(player => player.enabled !== false);
const matrix = Automation.buildFeedbackMatrix(players);

assert.ok(Speed);
assert.strictEqual(typeof Speed.recommendRace, 'function');
assert.strictEqual(typeof Speed.rankOpenings, 'function');
assert.strictEqual(typeof Speed.installRaceMode, 'function');

const openings = Speed.rankOpenings(matrix);
assert.strictEqual(openings.length, 646);
for (const opening of openings) {
  assert.ok(opening.twoGuessHitRateUniform > 0 && opening.twoGuessHitRateUniform <= 1);
  assert.ok(opening.guaranteedBySecondRate > 0);
  assert.ok(opening.guaranteedBySecondRate <= opening.twoGuessHitRateUniform);
  assert.strictEqual(opening.decisionOutcomes, opening.wrongPartitions + 1);
}
for (let index = 1; index < openings.length; index += 1) {
  assert.ok(openings[index - 1].twoGuessHitRateUniform >= openings[index].twoGuessHitRateUniform);
}

const sample = players.slice(0, 4);
const recommendation = Speed.recommendRace({
  matrix,
  candidates: sample,
  guessedKeys: new Set(),
  remainingGuesses: 7,
});
assert.ok(sample.some(player => Solver.playerKey(player) === Solver.playerKey(recommendation.player)));
assert.strictEqual(recommendation.strategy, 'race');
assert.strictEqual(recommendation.purpose, 'answer');

const unique = Speed.recommendRace({
  matrix,
  candidates: [sample[2]],
  guessedKeys: new Set(),
  remainingGuesses: 7,
});
assert.strictEqual(Solver.playerKey(unique.player), Solver.playerKey(sample[2]));
assert.strictEqual(unique.immediateHitRate, 1);

const weighted = Object.fromEntries(sample.map((player, index) => [Solver.playerKey(player), index === 3 ? 50 : 1]));
const weightedRecommendation = Speed.recommendRace({
  matrix,
  candidates: sample,
  guessedKeys: new Set(),
  remainingGuesses: 7,
  priorWeights: weighted,
  priorVersion: 'test-v1',
});
assert.strictEqual(Solver.playerKey(weightedRecommendation.player), Solver.playerKey(sample[3]));

console.log(JSON.stringify({
  suite: 'speed-strategy-contract',
  players: players.length,
  bestOpening: openings[0].player.nick,
  bestTwoGuessRate: openings[0].twoGuessHitRateUniform,
  cacheSize: Speed.cacheSize(),
  status: 'passed',
}));
