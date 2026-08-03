const assert = require('assert');

const Solver = require('../extension/solver.js');
globalThis.GameSolver = Solver;
const Automation = require('../extension/automation-core.js');
globalThis.FribergAutomation = Automation;
require('../extension/human-choice-policy.js');

function rawPlayer(nickname, index, extra = {}) {
  return {
    nickname,
    nationality: index % 2 ? '丹麦' : '法国',
    region: '欧洲',
    team: extra.team || '未签约/已下放',
    age: 20 + index,
    role: index % 3 === 0 ? 'AWPer' : 'Rifler',
    major_championships: extra.majorWins || 0,
    major_appearances: extra.majorApps || index + 1,
    difficulties: ['normal'],
    is_active: extra.active !== false,
    is_enabled: true,
  };
}

const smallPool = Solver.normalizeGamePlayers([
  rawPlayer('obscure_alpha', 0),
  rawPlayer('s1mple', 1, { team: 'NAVI', majorWins: 1, majorApps: 10 }),
  rawPlayer('obscure_beta', 2),
  rawPlayer('obscure_gamma', 3),
]);
const smallSession = new Automation.AssistantSession({
  players: smallPool,
  matrix: Automation.buildFeedbackMatrix(smallPool),
  origin: 'https://shnlfriberg.online',
  mode: Automation.MODES.RECOMMEND,
});
const small = smallSession.startRound('human-small');
assert.strictEqual(small.recommendation.player.nick, 's1mple');
assert.strictEqual(small.recommendation.humanChoice, true);
assert.strictEqual(small.recommendation.purpose, 'answer');
assert.ok(small.recommendation.popularityScore > 100);

const largeRaw = [rawPlayer('s1mple', 1, { team: 'NAVI', majorWins: 1, majorApps: 10 })];
for (let index = 0; index < 12; index += 1) largeRaw.push(rawPlayer(`candidate_${index}`, index + 2));
const largePool = Solver.normalizeGamePlayers(largeRaw);
const largeSession = new Automation.AssistantSession({
  players: largePool,
  matrix: Automation.buildFeedbackMatrix(largePool),
  origin: 'https://shnlfriberg.online',
  mode: Automation.MODES.RECOMMEND,
});
const large = largeSession.startRound('human-large');
assert.notStrictEqual(large.recommendation.humanChoice, true, 'large pools must retain the audited information strategy');

const restricted = {
  matrix: Automation.buildFeedbackMatrix(smallPool),
  lastCandidates: smallPool.filter(player => player.nick !== 's1mple'),
  guessedKeys: new Set(),
};
const restrictedChoice = globalThis.FribergHumanChoice.chooseHumanCandidate(restricted);
assert.ok(restrictedChoice);
assert.notStrictEqual(restrictedChoice.player.nick, 's1mple', 'popularity must never reintroduce an illegal candidate');

console.log(JSON.stringify({
  suite: 'human-choice-policy',
  smallPoolChoice: small.recommendation.player.nick,
  threshold: globalThis.FribergHumanChoice.threshold,
  status: 'passed',
}));
