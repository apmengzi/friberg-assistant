const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Automation = require('../automation-core.js');

const root = path.resolve(__dirname, '..');
const scriptPath = path.join(root, 'dist', 'friberg-assistant-scriptcat.user.js');
const script = fs.readFileSync(scriptPath, 'utf8');
const alternateScript = fs.readFileSync(path.join(root, 'dist', 'friberg-assistant.user.js'), 'utf8');

assert.ok(script.startsWith('// ==UserScript=='));
assert.ok(script.includes('// @match        https://shnlfriberg.online/multi*'));
assert.ok(script.includes('SCRIPT CAT / LIVE ASSIST'));
assert.ok(script.includes('选择自己的棋盘'));
assert.ok(script.includes('下载诊断 JSON'));
assert.ok(script.includes('复制诊断'));
assert.ok(script.includes('填入下一猜'));
assert.ok(script.includes('随机首猜并填入'));
assert.ok(script.includes('提交当前猜测'));
assert.ok(script.includes('FribergAutomation.buildFeedbackMatrix'));
assert.ok(script.includes('recordObservedVisibleFeedback'));
assert.ok(script.includes('FribergLiveDomAdapter'));
assert.ok(script.includes('fillAndSelectUniqueOption'));
assert.ok(script.includes('submitSelectedGuess'));
assert.ok(script.includes('SUBMIT_COOLDOWN_MS'));
assert.ok(script.includes('attemptQueuedSubmit'));
assert.ok(script.includes('scheduleSubmitRetry'));
assert.ok(script.includes("status: 'feedback-timeout'"));
assert.ok(script.includes("status: 'queue-timeout'"));
assert.ok(script.includes('等待网页 CD'));
assert.ok(script.includes('feedbackPaused'));
assert.ok(script.includes('data-drag-handle'));
assert.ok(script.includes('data-window="collapse"'));
assert.ok(script.includes('setPointerCapture'));
assert.ok(script.includes('friberg-scriptcat-layout-v1'));
assert.ok(script.includes('resetPanelPosition'));
assert.ok(script.includes('反馈未通过共享 DOM 适配器校验'));
assert.ok(!script.includes('校准绿色'));
assert.ok(!script.includes('submitGuess'));
assert.ok(!script.includes('WebSocket'));
assert.ok(!script.includes('localStorage'));
assert.ok(!script.includes('indexedDB'));
assert.strictEqual(script, alternateScript, 'the short and ScriptCat filenames must contain the same bundle');

const policy = Automation.originPolicy('https://shnlfriberg.online/multi/');
assert.strictEqual(policy.canAct, false);
assert.strictEqual(Automation.canPerformPageAction(policy, Automation.MODES.AUTO, true), false);

console.log(JSON.stringify({
  suite: 'scriptcat-contract',
  bytes: Buffer.byteLength(script),
  publicAutoSubmitPolicy: 'blocked-by-automation-core',
  status: 'passed',
}));
