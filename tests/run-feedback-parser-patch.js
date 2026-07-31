const assert = require('assert');
const path = require('path');

const patch = require(path.resolve(__dirname, '../extension/feedback-parser-patch.js'));

const trailing = ['Alliance', '瑞典', '31↑', '步枪手', '0', '5↓', '现役'];
assert.strictEqual(
  patch.extractNickname('twist Alliance 瑞典 31↑ 步枪手 0 5↓ 现役', trailing),
  'twist',
  'whole-row text must be reduced to the nickname cell value',
);
assert.strictEqual(
  patch.extractNickname('Zero (中国) TYLOO 中国 20↑ 步枪手 0 1↑ 现役', ['TYLOO', '中国', '20↑', '步枪手', '0', '1↑', '现役']),
  'Zero (中国)',
  'nicknames containing spaces must be preserved',
);
assert.strictEqual(patch.extractNickname('frozen', trailing), 'frozen');

const fakeCells = [
  { innerText: 'twist Alliance 瑞典 31↑ 步枪手 0 5↓ 现役' },
  ...trailing.map(innerText => ({ innerText })),
];
const baseAdapter = Object.freeze({
  normalizeText: value => String(value || '').trim(),
  readFeedbackRow: () => ({
    valid: true,
    errors: [],
    nickname: fakeCells[0].innerText,
    cells: fakeCells,
    reading: { age: { color: 'close', direction: 'up' } },
  }),
});
const installed = patch.install(baseAdapter);
const parsed = installed.readFeedbackRow({});
assert.strictEqual(parsed.nickname, 'twist');
assert.strictEqual(parsed.valid, true);
assert.strictEqual(installed.FEEDBACK_PARSER_PATCH_VERSION, '1.0.0');
assert.strictEqual(patch.install(installed), installed, 'install must be idempotent');

console.log(JSON.stringify({ suite: 'feedback-parser-patch', status: 'passed' }));
