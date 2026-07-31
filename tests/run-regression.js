'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const solver = require('../solver.js');
const suppliedHistory = require('./fixtures/frozen-torzsi-woxic-aizy.js');

const root = path.resolve(__dirname, '..');
const rawPool = JSON.parse(fs.readFileSync(path.join(root, 'data', 'players.game-646.json'), 'utf8'));
const players = solver.normalizeGamePlayers(rawPool).filter(player => player.enabled !== false);
const byNick = nickname => {
  const player = players.find(candidate => solver.normalize(candidate.nick) === solver.normalize(nickname));
  assert.ok(player, `expected ${nickname} in the game pool`);
  return player;
};

function testGamePoolIntegrity() {
  assert.equal(rawPool.length, 646, 'the bundled game pool should contain all 646 source rows');
  assert.equal(players.length, 646, 'no enabled game player should be dropped during normalization');
  assert.ok(players.every(player => player.region), 'every game player needs an explicit game region');
}

function testCountryFeedbackUsesGameRegions() {
  const guessed = byNick('frozen');
  const countryGray = {
    version: 1,
    guessedKey: solver.playerKey(guessed),
    guessedNick: guessed.nick,
    fields: { country: { color: 'wrong', guess: { country: guessed.country, region: solver.gameRegionOf(guessed) }, direction: 'none' } },
  };
  const countryYellow = {
    ...countryGray,
    fields: { country: { color: 'close', guess: { country: guessed.country, region: solver.gameRegionOf(guessed) }, direction: 'none' } },
  };

  assert.equal(solver.matchesFeedback(byNick('torzsi'), countryGray), false, 'country gray must reject the entire Europe game region, not only Slovakia');
  assert.equal(solver.matchesFeedback(byNick('woxic'), countryGray), true, 'country gray should keep a player outside the guessed game region');
  assert.equal(solver.matchesFeedback(byNick('torzsi'), countryYellow), true, 'country yellow should keep another country in the same game region');
  assert.equal(solver.matchesFeedback(guessed, countryYellow), false, 'country yellow must reject the exact guessed country');
}

function testNumericRangesAndDirections() {
  const guess = { id: 'probe', nick: 'probe', country: '中国', region: '亚太', team: 'A', age: 24, role: 'AWPer', majorWins: 0, majorApps: 8, status: 'active', enabled: true };
  const feedback = solver.buildFeedback(guess, ['wrong', 'close', 'close', 'correct', 'correct', 'wrong', 'correct'], { age: 'down', majorWins: 'none', majorApps: 'down' });
  const legal = { ...guess, id: 'legal', nick: 'legal', country: '土耳其', team: 'B', age: 22, majorApps: 5 };
  const tooFarAge = { ...legal, id: 'too-far-age', nick: 'too-far-age', age: 20 };
  const wrongDirection = { ...legal, id: 'wrong-direction', nick: 'wrong-direction', age: 25 };
  assert.equal(solver.matchesFeedback(legal, feedback), true, 'yellow age plus down arrow and gray Major appearances should intersect');
  assert.equal(solver.matchesFeedback(tooFarAge, feedback), false, 'yellow age must stay within three years');
  assert.equal(solver.matchesFeedback(wrongDirection, feedback), false, 'numeric arrows must be enforced when supplied');
}

function testSuppliedHistoryReplay() {
  const feedbacks = suppliedHistory.guesses.map(guess => solver.buildFeedback(byNick(guess.nickname), guess.cells, guess.directions));
  const excluded = new Set(suppliedHistory.guesses.map(guess => solver.playerKey(byNick(guess.nickname))));
  const candidates = solver.filterCandidates(players, feedbacks, excluded).map(player => player.nick).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(candidates, suppliedHistory.expectedCandidates, `${suppliedHistory.name} should replay deterministically`);
  assert.equal(candidates.includes('aizy'), false, 'a coach from a previous guess must never be recommended after AWPer is green');
  assert.ok(candidates.every(nickname => feedbacks.every(feedback => solver.matchesFeedback(byNick(nickname), feedback))), 'every returned player must satisfy every feedback cell');
}

function testInvalidFeedbackFailsClosed() {
  const invalid = solver.buildFeedback(byNick('aizy'), ['close', 'wrong', 'wrong', 'wrong', 'correct', 'wrong', 'correct'], { age: 'down', majorWins: 'none', majorApps: 'down' });
  const validation = solver.validateFeedback(invalid);
  assert.equal(validation.valid, false, 'yellow team feedback is unsupported and must ask for correction');
  assert.equal(solver.matchesFeedback(byNick('woxic'), invalid), false, 'invalid feedback must not create permissive candidates');
}

function testSourceFieldsRemainExact() {
  const sourceGuess = solver.normalizeGamePlayer({
    nickname: 'raw-source', nationality: 'United States', region: '北美洲', team: 'FaZe', age: 24,
    role: 'AWPer', major_championships: 0, major_appearances: 1, is_active: false, is_enabled: true,
  });
  const displayEquivalentButSourceDifferent = solver.normalizeGamePlayer({
    nickname: 'raw-variant', nationality: 'united states', region: '北美洲', team: 'faze', age: 24,
    role: 'awper', major_championships: 0, major_appearances: 1, is_active: false, is_enabled: true,
  });
  const feedback = key => ({
    version: 1,
    fields: { [key]: { color: 'correct', guess: key === 'country' ? { country: sourceGuess.gameCountry, region: solver.gameRegionOf(sourceGuess) } : key === 'status' ? sourceGuess.gameActive : sourceGuess[`game${key[0].toUpperCase()}${key.slice(1)}`], direction: 'none' } },
  });

  assert.equal(solver.matchesFeedback(displayEquivalentButSourceDifferent, feedback('team')), false, 'team comparison must follow raw game text, not display normalization');
  assert.equal(solver.matchesFeedback(displayEquivalentButSourceDifferent, feedback('role')), false, 'role comparison must follow raw game text, not display normalization');
  assert.equal(solver.matchesFeedback(displayEquivalentButSourceDifferent, feedback('country')), false, 'country green must require raw game nationality equality');
  assert.equal(solver.matchesFeedback(displayEquivalentButSourceDifferent, feedback('status')), true, 'status must compare the source Boolean(is_active), independent of status wording');
}

function testAllGreenAttributesDoNotImplyNickname() {
  let collision = null;
  for (const guess of players) {
    const feedback = solver.buildFeedback(guess, Array(7).fill('correct'));
    const group = solver.filterCandidates(players, [feedback]);
    if (group.length > 1) {
      collision = { guess, feedback, group };
      break;
    }
  }
  assert.ok(collision, 'the current pool should contain at least one equal-attribute nickname collision');
  const withoutSubmittedNick = solver.filterCandidates(
    players,
    [collision.feedback],
    new Set([solver.playerKey(collision.guess)]),
  );
  assert.equal(withoutSubmittedNick.includes(collision.guess), false, 'a wrong submitted nickname must be excluded even when all visible attributes are green');
  assert.equal(withoutSubmittedNick.length, collision.group.length - 1, 'other same-attribute nicknames must remain possible');
}

testGamePoolIntegrity();
testCountryFeedbackUsesGameRegions();
testNumericRangesAndDirections();
testSuppliedHistoryReplay();
testInvalidFeedbackFailsClosed();
testSourceFieldsRemainExact();
testAllGreenAttributesDoNotImplyNickname();

console.log(`PASS: ${players.length}-player pool, region semantics, numeric arrows, and supplied screenshot replay.`);
