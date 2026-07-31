const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const GameSolver = require(path.join(root, 'solver.js'));
const Automation = require(path.join(root, 'automation-core.js'));
globalThis.GameSolver = GameSolver;
globalThis.FribergAutomation = Automation;
require(path.join(root, 'extension/speed-strategy.js'));

const Speed = globalThis.FribergSpeedStrategy;
const rows = require(path.join(root, 'data/players.game-646.json'));
const players = GameSolver.normalizeGamePlayers(rows).filter(player => player.enabled !== false);
const matrix = Automation.buildFeedbackMatrix(players);
const openings = Speed.rankOpenings(matrix);
const refrezh = players.find(player => GameSolver.normalize(player.nick) === 'refrezh');
const refrezhMetrics = Speed.evaluateOpening(matrix, refrezh);

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

let singleSpeedSecondHits = 0;
let balancedSecondHits = 0;
let cacheHits = 0;
const groupKeys = new Set();

for (const answer of players) {
  const feedback = Automation.feedbackFromVisibleReading(refrezh, visibleReading(answer, refrezh));
  const candidates = GameSolver.filterCandidates(players, [feedback], new Set([GameSolver.playerKey(refrezh)]));
  groupKeys.add(GameSolver.feedbackSignature(answer, refrezh));

  const speed = Speed.recommendSpeed({
    matrix,
    candidates,
    guessedKeys: new Set([GameSolver.playerKey(refrezh)]),
    remainingGuesses: 7,
  });
  if (speed.cacheHit) cacheHits += 1;
  if (GameSolver.playerKey(speed.player) === GameSolver.playerKey(answer)) singleSpeedSecondHits += 1;

  const balanced = Automation.recommendNext({
    players,
    matrix,
    candidates,
    guessedKeys: new Set([GameSolver.playerKey(refrezh)]),
    remainingGuesses: 7,
  });
  if (GameSolver.playerKey(balanced.player) === GameSolver.playerKey(answer)) balancedSecondHits += 1;
}

const report = {
  generatedAt: new Date().toISOString(),
  scope: 'single-player and local benchmark only',
  players: players.length,
  fixedOpening: refrezh.nick,
  fixedOpeningMetrics: {
    partitions: refrezhMetrics.partitions,
    worstGroup: refrezhMetrics.worstGroup,
    expectedRemaining: refrezhMetrics.expectedRemaining,
    entropy: refrezhMetrics.entropy,
    secondGuessCeilingUniform: refrezhMetrics.secondGuessCeilingUniform,
    guaranteedBySecondRate: refrezhMetrics.guaranteedBySecondRate,
  },
  observedFeedbackGroups: groupKeys.size,
  balancedSecondHits,
  singleSpeedSecondHits,
  balancedSecondHitRate: balancedSecondHits / players.length,
  singleSpeedSecondHitRate: singleSpeedSecondHits / players.length,
  cacheHits,
  cacheSize: Speed.cacheSize(),
  bestOpeningsBySecondGuessCeiling: openings.slice(0, 20).map(entry => ({
    nickname: entry.player.nick,
    partitions: entry.partitions,
    worstGroup: entry.worstGroup,
    expectedRemaining: entry.expectedRemaining,
    secondGuessCeilingUniform: entry.secondGuessCeilingUniform,
    guaranteedBySecondRate: entry.guaranteedBySecondRate,
  })),
};

fs.mkdirSync(path.join(root, 'outputs'), { recursive: true });
fs.writeFileSync(path.join(root, 'outputs/single-speed-strategy-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
