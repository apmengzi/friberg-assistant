const assert = require('assert');
const fs = require('fs');
const path = require('path');
const GameSolver = require('../solver.js');
const Automation = require('../automation-core.js');
const rows = require('../data/players.game-646.json');

const players = GameSolver.normalizeGamePlayers(rows).filter(player => player.enabled !== false);
const matrix = Automation.buildFeedbackMatrix(players);
const allIndices = matrix.roster.map((_, index) => index);
const decisionCache = new Map();
const outcomeCache = new Map();

function chooseProbe(candidateIndices, guessedIndices, remainingGuesses) {
  const cacheKey = `${remainingGuesses}|${candidateIndices.join(',')}|${[...guessedIndices].sort((a, b) => a - b).join(',')}`;
  if (decisionCache.has(cacheKey)) return decisionCache.get(cacheKey);
  const candidates = candidateIndices.map(index => matrix.roster[index]);
  const guessedKeys = new Set([...guessedIndices].map(index => matrix.keys[index]));
  const recommendation = Automation.recommendNext({
    players,
    matrix,
    candidates,
    guessedKeys,
    remainingGuesses,
  });
  const chosen = matrix.indexByKey.get(GameSolver.playerKey(recommendation.player));
  decisionCache.set(cacheKey, chosen);
  return chosen;
}

function simulateAnswer(answerIndex) {
  if (outcomeCache.has(answerIndex)) return outcomeCache.get(answerIndex);
  let candidateIndices = allIndices;
  const guessedIndices = new Set();
  const trace = [];
  for (let turn = 1; turn <= 8; turn += 1) {
    const probeIndex = chooseProbe(candidateIndices, guessedIndices, 9 - turn);
    trace.push(matrix.roster[probeIndex].nick);
    if (probeIndex === answerIndex) {
      const result = { won: true, attempts: turn, trace, remainingCandidates: 1 };
      outcomeCache.set(answerIndex, result);
      return result;
    }
    const signature = matrix.signatures[probeIndex][answerIndex];
    guessedIndices.add(probeIndex);
    candidateIndices = candidateIndices.filter(index => index !== probeIndex && matrix.signatures[probeIndex][index] === signature);
    if (!candidateIndices.length) break;
  }
  const result = { won: false, attempts: 8, trace, remainingCandidates: candidateIndices.length };
  outcomeCache.set(answerIndex, result);
  return result;
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

const random = seededRandom(0xF11B3E);
const samples = Array.from({ length: 1000 }, () => Math.floor(random() * players.length));
const started = Date.now();
const rounds = samples.map((answerIndex, sample) => {
  const result = simulateAnswer(answerIndex);
  return {
    sample: sample + 1,
    answerId: matrix.keys[answerIndex],
    answerNick: matrix.roster[answerIndex].nick,
    ...result,
  };
});
const elapsedMs = Date.now() - started;
const wins = rounds.filter(round => round.won).length;
const maxAttempts = Math.max(...rounds.map(round => round.attempts));
const averageAttempts = rounds.reduce((sum, round) => sum + round.attempts, 0) / rounds.length;

const logDirectory = path.resolve(__dirname, '../logs');
fs.mkdirSync(logDirectory, { recursive: true });
fs.writeFileSync(path.join(logDirectory, 'simulation-rounds.jsonl'), `${rounds.map(round => JSON.stringify(round)).join('\n')}\n`, 'utf8');

assert.strictEqual(wins, rounds.length, 'all 1,000 authorized local simulations must finish within eight guesses');
assert.ok(maxAttempts <= 8);
console.log(JSON.stringify({
  suite: 'automation-simulation',
  rounds: rounds.length,
  wins,
  maxAttempts,
  averageAttempts: Number(averageAttempts.toFixed(3)),
  uniqueAnswers: outcomeCache.size,
  decisionStates: decisionCache.size,
  elapsedMs,
  log: 'logs/simulation-rounds.jsonl',
  status: 'passed',
}));
