'use strict';

const assert = require('node:assert/strict');
const GameSolver = require('../solver.js');
const Automation = require('../automation-core.js');
const rows = require('../data/players.game-646.json');

const players = GameSolver.normalizeGamePlayers(rows).filter(player => player.enabled !== false);
const matrix = Automation.buildFeedbackMatrix(players);
const byNick = nickname => {
  const matches = players.filter(player => GameSolver.normalize(player.nick) === GameSolver.normalize(nickname));
  assert.equal(matches.length, 1, `expected one ${nickname} in the pool`);
  return matches[0];
};

function visibleReading(colors, directions, visibleValues) {
  return {
    team: colors.team,
    country: colors.country,
    age: { color: colors.age, direction: directions.age },
    role: colors.role,
    majorWins: { color: colors.majorWins, direction: directions.majorWins },
    majorAppearances: { color: colors.majorApps, direction: directions.majorApps },
    status: colors.status,
    visibleValues,
  };
}

function createSession({ dataDriftMaxFields = 0, dataDriftMaxScore = 1 } = {}) {
  const session = new Automation.AssistantSession({
    players,
    matrix,
    origin: 'https://shnlfriberg.online/multi/room',
    mode: Automation.MODES.RECOMMEND,
    dataDriftMaxFields,
    dataDriftMaxScore,
  });
  session.startRound(`regression-${Date.now()}-${Math.random()}`);
  return session;
}

function record(session, nickname, reading) {
  const visibleGuess = Automation.guessFromVisibleReading(byNick(nickname), reading, players);
  return session.recordObservedVisibleFeedback(visibleGuess, reading, { maxGuesses: 8 });
}

function testIcyAgeDriftRecovery() {
  const session = createSession();
  record(session, 'frozen', visibleReading(
    { team: 'wrong', country: 'wrong', age: 'close', role: 'wrong', majorWins: 'correct', majorApps: 'wrong', status: 'correct' },
    { age: 'down', majorWins: 'none', majorApps: 'down' },
    { team: 'FaZe Clan', country: '斯洛伐克', age: 24, role: '步枪手', majorWins: 0, majorApps: 8, status: '现役' },
  ));
  record(session, 'history', visibleReading(
    { team: 'wrong', country: 'wrong', age: 'close', role: 'correct', majorWins: 'correct', majorApps: 'close', status: 'correct' },
    { age: 'down', majorWins: 'none', majorApps: 'up' },
    { team: 'Patins da Ferrari', country: '巴西', age: 22, role: '狙击手', majorWins: 0, majorApps: 2, status: '现役' },
  ));
  const result = record(session, 'molodoy', visibleReading(
    { team: 'wrong', country: 'correct', age: 'correct', role: 'correct', majorWins: 'correct', majorApps: 'correct', status: 'correct' },
    { age: 'none', majorWins: 'none', majorApps: 'none' },
    { team: 'FURIA', country: '哈萨克斯坦', age: 21, role: '狙击手', majorWins: 0, majorApps: 3, status: '现役' },
  ));
  assert.equal(result.dataDrift?.mode, 'data-drift');
  assert.deepEqual(result.candidates.map(player => GameSolver.normalize(player.nick)), ['icy']);
  assert.deepEqual(result.dataDrift.conflicts[0].fields, ['age']);
}

function testVisibleDevilwalkProfilePreventsFalseContradiction() {
  const session = createSession();
  record(session, 'frozen', visibleReading(
    { team: 'wrong', country: 'close', age: 'wrong', role: 'correct', majorWins: 'correct', majorApps: 'wrong', status: 'wrong' },
    { age: 'up', majorWins: 'none', majorApps: 'down' },
    { team: 'FaZe Clan', country: '斯洛伐克', age: 24, role: '步枪手', majorWins: 0, majorApps: 8, status: '现役' },
  ));
  const result = record(session, 'devilwalk', visibleReading(
    { team: 'wrong', country: 'close', age: 'close', role: 'wrong', majorWins: 'close', majorApps: 'close', status: 'wrong' },
    { age: 'up', majorWins: 'down', majorApps: 'down' },
    { team: '未签约/已下放', country: '瑞典', age: 35, role: '教练', majorWins: 1, majorApps: 2, status: '现役' },
  ));
  assert.equal(result.dataDrift, null, 'visible Coach/active values should keep the strict path consistent');
  assert.ok(result.candidates.length > 0, 'the second real round must not collapse to zero candidates');
}

function testSmithzzStatusDriftRecovery() {
  const session = createSession();
  const guesses = [
    ['frozen',
      { team: 'wrong', country: 'close', age: 'wrong', role: 'wrong', majorWins: 'close', majorApps: 'wrong', status: 'correct' },
      { age: 'up', majorWins: 'up', majorApps: 'up' },
      { team: 'FaZe Clan', country: '斯洛伐克', age: 24, role: '步枪手', majorWins: 0, majorApps: 8, status: '现役' }],
    ['neo',
      { team: 'wrong', country: 'close', age: 'close', role: 'wrong', majorWins: 'correct', majorApps: 'wrong', status: 'correct' },
      { age: 'down', majorWins: 'none', majorApps: 'down' },
      { team: 'Astralis', country: '波兰', age: 39, role: '教练', majorWins: 1, majorApps: 14, status: '现役' }],
    ['afro',
      { team: 'wrong', country: 'correct', age: 'wrong', role: 'correct', majorWins: 'close', majorApps: 'wrong', status: 'correct' },
      { age: 'up', majorWins: 'up', majorApps: 'up' },
      { team: 'Luminosity Gaming', country: '法国', age: 27, role: '狙击手', majorWins: 0, majorApps: 1, status: '现役' }],
    ['torzsi',
      { team: 'wrong', country: 'close', age: 'wrong', role: 'correct', majorWins: 'close', majorApps: 'wrong', status: 'correct' },
      { age: 'up', majorWins: 'up', majorApps: 'up' },
      { team: 'MOUZ', country: '匈牙利', age: 24, role: '狙击手', majorWins: 0, majorApps: 7, status: '现役' }],
    ['ZywOo',
      { team: 'wrong', country: 'correct', age: 'wrong', role: 'correct', majorWins: 'wrong', majorApps: 'correct', status: 'correct' },
      { age: 'up', majorWins: 'down', majorApps: 'none' },
      { team: 'Team Vitality', country: '法国', age: 25, role: '狙击手', majorWins: 3, majorApps: 11, status: '现役' }],
  ];
  let result;
  guesses.forEach(([nickname, colors, directions, values]) => {
    result = record(session, nickname, visibleReading(colors, directions, values));
  });
  assert.equal(result.dataDrift?.mode, 'data-drift');
  assert.deepEqual(result.candidates.map(player => GameSolver.normalize(player.nick)), ['smithzz']);
  assert.deepEqual(result.dataDrift.conflicts[0].fields, ['status']);
}

function testEasyRoundUsesVisibleTeamValue() {
  const session = createSession();
  record(session, 'frozen', visibleReading(
    { team: 'wrong', country: 'wrong', age: 'wrong', role: 'correct', majorWins: 'correct', majorApps: 'wrong', status: 'correct' },
    { age: 'up', majorWins: 'none', majorApps: 'down' },
    { team: 'FaZe Clan', country: '斯洛伐克', age: 24, role: '步枪手', majorWins: 0, majorApps: 8, status: '现役' },
  ));
  record(session, 'kngv', visibleReading(
    { team: 'wrong', country: 'wrong', age: 'wrong', role: 'wrong', majorWins: 'correct', majorApps: 'wrong', status: 'correct' },
    { age: 'down', majorWins: 'none', majorApps: 'up' },
    { team: 'O Plano', country: '巴西', age: 33, role: '狙击手', majorWins: 0, majorApps: 2, status: '现役' },
  ));
  const result = record(session, 'summer', visibleReading(
    { team: 'wrong', country: 'wrong', age: 'close', role: 'correct', majorWins: 'correct', majorApps: 'wrong', status: 'correct' },
    { age: 'down', majorWins: 'none', majorApps: 'down' },
    { team: 'Rare Atom', country: '中国', age: 29, role: '步枪手', majorWins: 0, majorApps: 6, status: '现役' },
  ));
  assert.equal(result.dataDrift, null);
  assert.deepEqual(result.candidates.map(player => GameSolver.normalize(player.nick)), ['brehze']);
  assert.equal(GameSolver.normalize(result.recommendation.player.nick), 'brehze');
}

function testAumanMultiFieldVolatilityRecovery() {
  const session = createSession();
  const guesses = [
    ['AW',
      { team: 'wrong', country: 'wrong', age: 'wrong', role: 'wrong', majorWins: 'correct', majorApps: 'correct', status: 'correct' },
      { age: 'up', majorWins: 'none', majorApps: 'none' },
      { team: 'magic', country: '俄罗斯', age: 20, role: '步枪手', majorWins: 0, majorApps: 1, status: '现役' }],
    ['nawwk',
      { team: 'correct', country: 'wrong', age: 'wrong', role: 'wrong', majorWins: 'correct', majorApps: 'wrong', status: 'correct' },
      { age: 'up', majorWins: 'none', majorApps: 'down' },
      { team: '未签约/已下放', country: '瑞典', age: 28, role: '狙击手', majorWins: 0, majorApps: 3, status: '现役' }],
    ['hardstyle',
      { team: 'correct', country: 'close', age: 'wrong', role: 'correct', majorWins: 'correct', majorApps: 'correct', status: 'correct' },
      { age: 'down', majorWins: 'none', majorApps: 'none' },
      { team: '未签约/已下放', country: '土耳其', age: 43, role: '教练', majorWins: 0, majorApps: 1, status: '现役' }],
    ['Jamyoung',
      { team: 'wrong', country: 'correct', age: 'wrong', role: 'wrong', majorWins: 'correct', majorApps: 'wrong', status: 'correct' },
      { age: 'up', majorWins: 'none', majorApps: 'down' },
      { team: 'TYLOO', country: '中国', age: 25, role: '步枪手', majorWins: 0, majorApps: 3, status: '现役' }],
    ['marek',
      { team: 'wrong', country: 'correct', age: 'close', role: 'correct', majorWins: 'correct', majorApps: 'correct', status: 'correct' },
      { age: 'up', majorWins: 'none', majorApps: 'none' },
      { team: 'Rare Atom', country: '中国', age: 30, role: '教练', majorWins: 0, majorApps: 1, status: '现役' }],
    ['jnt',
      { team: 'correct', country: 'wrong', age: 'correct', role: 'correct', majorWins: 'correct', majorApps: 'correct', status: 'correct' },
      { age: 'none', majorWins: 'none', majorApps: 'none' },
      { team: '未签约/已下放', country: '巴西', age: 32, role: '教练', majorWins: 0, majorApps: 1, status: '现役' }],
    ['zhokiNg',
      { team: 'wrong', country: 'correct', age: 'correct', role: 'correct', majorWins: 'correct', majorApps: 'correct', status: 'correct' },
      { age: 'none', majorWins: 'none', majorApps: 'none' },
      { team: 'TYLOO', country: '中国', age: 32, role: '教练', majorWins: 0, majorApps: 1, status: '现役' }],
  ];
  let result;
  guesses.forEach(([nickname, colors, directions, values]) => {
    result = record(session, nickname, visibleReading(colors, directions, values));
  });
  assert.equal(result.dataDrift?.weighted, true);
  assert.deepEqual(result.candidates.map(player => GameSolver.normalize(player.nick)), ['auman']);
  assert.deepEqual([...result.dataDrift.conflicts[0].fields].sort(), ['role', 'status', 'team']);
  assert.ok(result.dataDrift.minScore <= 1);
  assert.equal(GameSolver.normalize(result.recommendation.player.nick), 'auman');
}

function testNoCandidateFailureIsTransactional() {
  const onlyFrozen = [byNick('frozen')];
  const session = new Automation.AssistantSession({
    players: onlyFrozen,
    origin: 'http://127.0.0.1:4174',
    mode: Automation.MODES.RECOMMEND,
  });
  session.startRound('transactional');
  const impossible = visibleReading(
    { team: 'wrong', country: 'wrong', age: 'wrong', role: 'wrong', majorWins: 'wrong', majorApps: 'wrong', status: 'wrong' },
    { age: 'up', majorWins: 'up', majorApps: 'up' },
    { team: 'FaZe Clan', country: '斯洛伐克', age: 24, role: '步枪手', majorWins: 0, majorApps: 8, status: '现役' },
  );
  assert.throws(() => record(session, 'frozen', impossible), /没有合法候选/);
  assert.notEqual(session.state, Automation.STATES.ERROR);
  assert.equal(session.history.length, 0);
}

testIcyAgeDriftRecovery();
testVisibleDevilwalkProfilePreventsFalseContradiction();
testSmithzzStatusDriftRecovery();
testEasyRoundUsesVisibleTeamValue();
testAumanMultiFieldVolatilityRecovery();
testNoCandidateFailureIsTransactional();

console.log('PASS: real BO3 screenshots recover icy/smithzz/auman, keep devilwalk strict, and resolve the easy round to brehze.');
