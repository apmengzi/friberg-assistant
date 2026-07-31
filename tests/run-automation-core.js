const assert = require('assert');
const GameSolver = require('../solver.js');
const Automation = require('../automation-core.js');
const rows = require('../data/players.game-646.json');

const players = GameSolver.normalizeGamePlayers(rows).filter(player => player.enabled !== false);
assert.strictEqual(players.length, 646, 'automation must use the full game pool');

function visibleReading(answer, guess) {
  const fields = Object.fromEntries(GameSolver.FIELD_ORDER.map(field => [field, GameSolver.classifyFeedback(answer, guess, field)]));
  return {
    team: fields.team.color,
    country: fields.country.color,
    age: fields.age,
    role: fields.role.color,
    majorWins: fields.majorWins,
    majorAppearances: fields.majorApps,
    status: fields.status.color,
  };
}

const matrix = Automation.buildFeedbackMatrix(players);
assert.strictEqual(matrix.roster.length, 646);
assert.strictEqual(matrix.signatures.length, 646);
assert.strictEqual(matrix.signatures[0].length, 646);

const publicPolicy = Automation.originPolicy('https://shnlfriberg.online/multi');
assert.strictEqual(publicPolicy.kind, 'public');
assert.strictEqual(publicPolicy.canRead, true);
assert.strictEqual(publicPolicy.canAct, false);
assert.deepStrictEqual(publicPolicy.allowedModes, [Automation.MODES.RECOMMEND]);
assert.strictEqual(Automation.canPerformPageAction(publicPolicy, Automation.MODES.AUTO, true), false);

const localPolicy = Automation.originPolicy('http://127.0.0.1:4174');
assert.strictEqual(localPolicy.kind, 'local');
assert.strictEqual(Automation.canPerformPageAction(localPolicy, Automation.MODES.AUTO, true), true);
assert.strictEqual(Automation.canPerformPageAction(localPolicy, Automation.MODES.AUTO, false), false);
assert.throws(() => new Automation.AssistantSession({
  players,
  matrix,
  origin: 'https://shnlfriberg.online/multi',
  mode: Automation.MODES.AUTO,
}), /不允许/);

const guess = players[0];
const answer = players.find(player => GameSolver.playerKey(player) !== GameSolver.playerKey(guess));
const reading = visibleReading(answer, guess);
const feedback = Automation.feedbackFromVisibleReading(guess, reading);
assert.strictEqual(GameSolver.matchesFeedback(answer, feedback), true, 'visible colors must produce strict matching feedback');
assert.throws(() => Automation.feedbackFromVisibleReading(guess, { ...reading, team: 'purple' }), /无法识别反馈颜色/);

const recommendation = Automation.recommendNext({ players, matrix, candidates: players, remainingGuesses: 8 });
assert.ok(recommendation.player && matrix.indexByKey.has(GameSolver.playerKey(recommendation.player)));
assert.ok(Number.isFinite(recommendation.expectedRemaining));

const firstRandom = Automation.pickRandomPlayer({ players, random: () => 0 });
const lastRandom = Automation.pickRandomPlayer({ players, random: () => 0.999999 });
assert.strictEqual(firstRandom, players[0], 'zero random sample must select the first enabled player');
assert.strictEqual(lastRandom, players.at(-1), 'high random sample must select the last enabled player');
assert.notStrictEqual(
  Automation.pickRandomPlayer({ players, guessedKeys: new Set([GameSolver.playerKey(players[0])]), random: () => 0 }),
  players[0],
  'random first guess must exclude an already guessed player',
);

const observed = new Automation.AssistantSession({
  players,
  matrix,
  origin: 'http://127.0.0.1:4174',
  mode: Automation.MODES.RECOMMEND,
});
observed.startRound('observed-row');
const observedResult = observed.recordObservedVisibleFeedback(guess, reading, { maxGuesses: 8 });
assert.strictEqual(observedResult.won, undefined);
assert.strictEqual(observed.state, Automation.STATES.CHOOSING_GUESS);

const automated = new Automation.AssistantSession({
  players,
  matrix,
  origin: 'http://127.0.0.1:4174',
  mode: Automation.MODES.AUTO,
});
automated.startRound('authorized-action');
automated.beginPageAction(true);
automated.recordVisibleFeedback(guess, reading, { maxGuesses: 8 });
assert.strictEqual(automated.state, Automation.STATES.CHOOSING_GUESS);

console.log(JSON.stringify({
  suite: 'automation-core',
  players: players.length,
  matrixCells: matrix.signatures.length * matrix.signatures.length,
  firstProbe: recommendation.player.nick,
  worstGroup: recommendation.worstGroup,
  status: 'passed',
}));
