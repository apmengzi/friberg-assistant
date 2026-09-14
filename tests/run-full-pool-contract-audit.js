'use strict';

// Independent reference implementation of the public game's server-side
// compareGuess contract.  It intentionally does not call GameSolver to decide
// colors; see the upstream gameService.ts source:
// https://github.com/shnlfriberg/csgofriberg/blob/main/server/src/services/gameService.ts

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const solver = require('../solver.js');

const root = path.resolve(__dirname, '..');
const rawPlayers = JSON.parse(fs.readFileSync(path.join(root, 'data', 'players.game-646.json'), 'utf8'));
const players = solver.normalizeGamePlayers(rawPlayers).filter(player => player.enabled !== false);

const FIELD_ORDER = ['team', 'country', 'age', 'role', 'majorWins', 'majorApps', 'status'];
const numericFeedback = (guess, target, closeRange) => {
  if (guess === target) return { color: 'correct', direction: 'none' };
  return {
    color: Math.abs(guess - target) <= closeRange ? 'close' : 'wrong',
    direction: target > guess ? 'up' : 'down',
  };
};

function gameOracle(guess, target) {
  const country = guess.nationality === target.nationality
    ? { color: 'correct', direction: 'none' }
    : guess.region && guess.region === target.region
      ? { color: 'close', direction: 'none' }
      : { color: 'wrong', direction: 'none' };
  const exact = (left, right) => ({ color: left === right ? 'correct' : 'wrong', direction: 'none' });
  const fields = {
    team: exact(guess.team, target.team),
    country,
    age: numericFeedback(guess.age, target.age, 3),
    role: exact(guess.role, target.role),
    majorWins: numericFeedback(guess.major_championships, target.major_championships, 1),
    majorApps: numericFeedback(guess.major_appearances, target.major_appearances, 1),
    status: exact(Boolean(guess.is_active), Boolean(target.is_active)),
  };
  return {
    fields,
    cells: FIELD_ORDER.map(key => fields[key].color),
    directions: {
      age: fields.age.direction,
      majorWins: fields.majorWins.direction,
      majorApps: fields.majorApps.direction,
    },
  };
}

function signature(oracled) {
  return FIELD_ORDER.map(key => {
    const field = oracled.fields[key];
    return `${key}:${field.color}${field.direction === 'none' ? '' : `-${field.direction}`}`;
  }).join('|');
}

function solverResult(answer, probe) {
  const fields = Object.fromEntries(FIELD_ORDER.map(key => [key, solver.classifyFeedback(answer, probe, key)]));
  return {
    fields,
    cells: FIELD_ORDER.map(key => fields[key].color),
    directions: {
      age: fields.age.direction,
      majorWins: fields.majorWins.direction,
      majorApps: fields.majorApps.direction,
    },
  };
}

function sortedKeys(indices) {
  return indices.map(index => solver.playerKey(players[index])).sort();
}

function percentile(sortedValues, fraction) {
  if (!sortedValues.length) return 0;
  return sortedValues[Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * fraction) - 1)];
}

assert.equal(rawPlayers.length, 646, 'expected the complete game data file');
assert.equal(players.length, rawPlayers.length, 'normalization must not drop enabled game players');
assert.equal(new Set(rawPlayers.map(player => player.nickname)).size, rawPlayers.length, 'the current game pool must have unique nicknames');

// Optional inclusive/exclusive guess-index range.  This keeps the exhaustive
// audit runnable under short CI command limits without turning it into a
// sample: the four documented ranges concatenate to [0, 646).
const startIndex = Number.parseInt(process.argv[2] || '0', 10);
const endIndex = Number.parseInt(process.argv[3] || String(rawPlayers.length), 10);
assert.ok(Number.isInteger(startIndex) && startIndex >= 0 && startIndex < rawPlayers.length, 'invalid audit start index');
assert.ok(Number.isInteger(endIndex) && endIndex > startIndex && endIndex <= rawPlayers.length, 'invalid audit end index');

let pairChecks = 0;
let partitionChecks = 0;
let largestPartition = 0;
const remainingAfterWrongGuess = [];
const allGreenCollisionGroups = [];

for (let guessIndex = startIndex; guessIndex < endIndex; guessIndex += 1) {
  const rawGuess = rawPlayers[guessIndex];
  const normalizedGuess = players[guessIndex];
  const partitions = new Map();

  for (let targetIndex = 0; targetIndex < rawPlayers.length; targetIndex += 1) {
    const oracle = gameOracle(rawGuess, rawPlayers[targetIndex]);
    const actual = solverResult(players[targetIndex], normalizedGuess);
    assert.deepEqual(actual, oracle, `classifier mismatch: guess=${rawGuess.nickname}, target=${rawPlayers[targetIndex].nickname}`);

    const feedback = solver.buildFeedback(normalizedGuess, oracle.cells, oracle.directions);
    assert.equal(
      solver.matchesFeedback(players[targetIndex], feedback),
      true,
      `true answer was removed: guess=${rawGuess.nickname}, target=${rawPlayers[targetIndex].nickname}`,
    );

    const key = signature(oracle);
    const group = partitions.get(key) || { oracle, targetIndices: [] };
    group.targetIndices.push(targetIndex);
    partitions.set(key, group);
    pairChecks += 1;
  }

  for (const { oracle, targetIndices } of partitions.values()) {
    const feedback = solver.buildFeedback(normalizedGuess, oracle.cells, oracle.directions);
    const expected = sortedKeys(targetIndices);
    const actual = solver.filterCandidates(players, [feedback]).map(solver.playerKey).sort();
    assert.deepEqual(
      actual,
      expected,
      `candidate partition mismatch for guess=${rawGuess.nickname}; expected ${expected.length}, got ${actual.length}`,
    );
    largestPartition = Math.max(largestPartition, targetIndices.length);
    partitionChecks += 1;

    // The submitted nickname can occur in only one partition: its own
    // all-green attribute partition.  In every other partition exclusion is
    // a mathematical no-op, so calculate its resulting size here without a
    // redundant second full-pool scan.
    const removesSubmittedNickname = targetIndices.includes(guessIndex) ? 1 : 0;
    targetIndices.forEach(targetIndex => {
      if (targetIndex !== guessIndex) remainingAfterWrongGuess.push(targetIndices.length - removesSubmittedNickname);
    });
  }

  // Check exclusion precisely where it can change the candidate set.  This is
  // also the global test for the "all seven attributes green != nickname
  // correct" edge case, not a hand-picked example.
  const selfOracle = gameOracle(rawGuess, rawGuess);
  const selfGroup = partitions.get(signature(selfOracle));
  assert.ok(selfGroup, `missing self partition for guess=${rawGuess.nickname}`);
  const selfFeedback = solver.buildFeedback(normalizedGuess, selfOracle.cells, selfOracle.directions);
  const expectedAfterExclusion = sortedKeys(selfGroup.targetIndices).filter(key => key !== solver.playerKey(normalizedGuess));
  const actualAfterExclusion = solver.filterCandidates(
    players,
    [selfFeedback],
    new Set([solver.playerKey(normalizedGuess)]),
  ).map(solver.playerKey).sort();
  assert.deepEqual(actualAfterExclusion, expectedAfterExclusion, `nickname exclusion mismatch for guess=${rawGuess.nickname}`);
  if (selfGroup.targetIndices.length > 1) {
    allGreenCollisionGroups.push({ guess: rawGuess.nickname, candidates: selfGroup.targetIndices.map(index => rawPlayers[index].nickname) });
  }
}

const sortedRemaining = remainingAfterWrongGuess.slice().sort((left, right) => left - right);
const totalRemaining = sortedRemaining.reduce((sum, value) => sum + value, 0);
const summary = {
  startIndex,
  endIndex,
  players: players.length,
  pairChecks,
  partitionChecks,
  largestPartition,
  allGreenCollisionGroups: allGreenCollisionGroups.length,
  distinctAllGreenCollisionSets: new Set(allGreenCollisionGroups.map(group => group.candidates.join('|'))).size,
  wrongGuessOutcomes: sortedRemaining.length,
  averageCandidatesAfterOneWrongGuess: Number((totalRemaining / sortedRemaining.length).toFixed(2)),
  medianCandidatesAfterOneWrongGuess: percentile(sortedRemaining, 0.5),
  p90CandidatesAfterOneWrongGuess: percentile(sortedRemaining, 0.9),
  p99CandidatesAfterOneWrongGuess: percentile(sortedRemaining, 0.99),
  directlySolvedAfterOneWrongGuess: sortedRemaining.filter(value => value === 1).length,
};

console.log(`PASS FULL-POOL CONTRACT AUDIT ${JSON.stringify(summary)}`);
