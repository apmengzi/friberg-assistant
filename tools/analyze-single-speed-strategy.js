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
const allIndices = players.map((_, index) => index);
const openingRank = Speed.rankOpenings(matrix);
const refrezhIndex = players.findIndex(player => GameSolver.normalize(player.nick) === 'refrezh');

function firstGroups(openingIndex) {
  const groups = new Map();
  for (const answerIndex of allIndices) {
    const signature = matrix.signatures[openingIndex][answerIndex];
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(answerIndex);
  }
  return groups;
}

function nextGuess(mode, candidateIndices, guessedKeys, remainingGuesses) {
  if (candidateIndices.length === 1) return candidateIndices[0];
  const candidates = candidateIndices.map(index => players[index]);
  const recommendation = mode === 'race'
    ? Speed.recommendRace({ matrix, candidates, guessedKeys, remainingGuesses })
    : Automation.recommendNext({ players, matrix, candidates, guessedKeys, remainingGuesses });
  return matrix.indexByKey.get(GameSolver.playerKey(recommendation.player));
}

function simulateOpening(openingIndex, mode) {
  const groups = firstGroups(openingIndex);
  const turns = [];
  let failures = 0;

  for (let answerIndex = 0; answerIndex < players.length; answerIndex += 1) {
    let guessIndex = openingIndex;
    let candidateIndices = allIndices;
    const guessedKeys = new Set();
    let solved = false;

    for (let turn = 1; turn <= 8; turn += 1) {
      if (guessIndex === answerIndex) {
        turns.push(turn);
        solved = true;
        break;
      }

      const signature = matrix.signatures[guessIndex][answerIndex];
      guessedKeys.add(matrix.keys[guessIndex]);
      if (turn === 1) {
        candidateIndices = (groups.get(signature) || []).filter(index => index !== guessIndex);
      } else {
        candidateIndices = candidateIndices.filter(index => (
          index !== guessIndex && matrix.signatures[guessIndex][index] === signature
        ));
      }
      if (!candidateIndices.length) break;
      guessIndex = nextGuess(mode, candidateIndices, guessedKeys, 8 - turn);
      if (guessIndex === undefined) break;
    }

    if (!solved) failures += 1;
  }

  const histogram = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, 0]));
  turns.forEach(turn => { histogram[turn] += 1; });
  const totalTurns = turns.reduce((sum, turn) => sum + turn, 0);
  return {
    nickname: players[openingIndex].nick,
    mode,
    solved: turns.length,
    failures,
    averageGuesses: turns.length ? totalTurns / turns.length : null,
    maxGuesses: turns.length ? Math.max(...turns) : null,
    secondGuessWins: (histogram[1] || 0) + (histogram[2] || 0),
    secondGuessRate: ((histogram[1] || 0) + (histogram[2] || 0)) / players.length,
    thirdGuessRate: ((histogram[1] || 0) + (histogram[2] || 0) + (histogram[3] || 0)) / players.length,
    histogram,
  };
}

const raceResults = openingRank.map(entry => ({
  opening: {
    nickname: entry.player.nick,
    partitions: entry.partitions,
    worstGroup: entry.worstGroup,
    expectedRemaining: entry.expectedRemaining,
    entropy: entry.entropy,
    singletonBuckets: entry.singletonBuckets,
    twoGuessHitRateUniform: entry.twoGuessHitRateUniform,
    guaranteedBySecondRate: entry.guaranteedBySecondRate,
  },
  simulation: simulateOpening(entry.probeIndex, 'race'),
}));

raceResults.sort((left, right) => (
  left.simulation.averageGuesses - right.simulation.averageGuesses
  || right.simulation.secondGuessRate - left.simulation.secondGuessRate
  || left.simulation.maxGuesses - right.simulation.maxGuesses
  || left.opening.nickname.localeCompare(right.opening.nickname)
));

const topRaceIndices = raceResults.slice(0, 20)
  .map(result => players.findIndex(player => player.nick === result.opening.nickname));
if (!topRaceIndices.includes(refrezhIndex)) topRaceIndices.push(refrezhIndex);

const balancedComparisons = topRaceIndices.map(index => simulateOpening(index, 'balanced'))
  .sort((left, right) => left.averageGuesses - right.averageGuesses);

const report = {
  generatedAt: new Date().toISOString(),
  players: players.length,
  interpretation: {
    twoGuessHitRateUniform: 'For a fixed first guess and a direct legal-candidate second guess, the exact uniform-answer hit rate equals non-empty feedback partitions divided by the pool size.',
    guaranteedBySecondRate: 'Fraction of answers landing in singleton feedback buckets after the opening.',
    race: 'After every visible feedback, guess a legal answer immediately; ties prefer the candidate that best separates the remaining wrong-answer cases.',
    balanced: 'Existing minimax/expected-remaining strategy, which may use a non-answer probe.',
  },
  refrezh: {
    opening: openingRank.find(entry => entry.probeIndex === refrezhIndex),
    race: simulateOpening(refrezhIndex, 'race'),
    balanced: simulateOpening(refrezhIndex, 'balanced'),
  },
  bestByOpeningPartitions: openingRank.slice(0, 30).map(entry => ({
    nickname: entry.player.nick,
    partitions: entry.partitions,
    worstGroup: entry.worstGroup,
    expectedRemaining: entry.expectedRemaining,
    entropy: entry.entropy,
    singletonBuckets: entry.singletonBuckets,
    twoGuessHitRateUniform: entry.twoGuessHitRateUniform,
    guaranteedBySecondRate: entry.guaranteedBySecondRate,
  })),
  bestRacePolicies: raceResults.slice(0, 30),
  balancedComparisons,
  cacheSize: Speed.cacheSize(),
};

fs.mkdirSync(path.join(root, 'outputs'), { recursive: true });
fs.writeFileSync(
  path.join(root, 'outputs/single-speed-strategy-report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify({
  players: report.players,
  refrezh: report.refrezh,
  bestOpeningByPartitions: report.bestByOpeningPartitions[0],
  bestRacePolicy: report.bestRacePolicies[0],
  bestBalancedComparison: report.balancedComparisons[0],
}));
