const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const digest = relative => crypto.createHash('sha256').update(read(relative)).digest('hex');
const manifest = JSON.parse(read('extension/manifest.json'));
const scripts = manifest.content_scripts[0].js;
const styles = manifest.content_scripts[0].css;
const matches = manifest.content_scripts[0].matches;

assert.strictEqual(manifest.manifest_version, 3);
assert.strictEqual(manifest.version, '0.9.8.2');
assert.ok(matches.includes('https://shnlfriberg.online/multi*'));
assert.ok(matches.includes('https://shnlfriberg.online/single*'));
assert.ok(matches.includes('http://127.0.0.1/*'));
assert.ok(manifest.host_permissions.includes('https://shnlfriberg.online/api/players*'));
assert.ok(manifest.permissions.includes('storage'));
assert.ok(manifest.permissions.includes('scripting'));
assert.ok(fs.existsSync(path.join(root, 'extension/data/game-players-646.json')));
assert.strictEqual(digest('solver.js'), digest('extension/solver.js'), 'extension must ship the audited solver');
assert.strictEqual(digest('automation-core.js'), digest('extension/automation-core.js'), 'extension must ship the audited automation core');
assert.strictEqual(digest('live-dom-adapter.js'), digest('extension/live-dom-adapter.js'), 'extension must ship the shared live DOM adapter');
assert.ok(scripts.includes('human-choice-policy.js'));
assert.ok(scripts.includes('production-data-sync.js'));
assert.ok(scripts.includes('data-sync-ui.js'));
assert.ok(scripts.includes('live-dom-adapter.js'));
assert.ok(scripts.includes('feedback-parser-patch.js'));
assert.ok(scripts.includes('autoplay.js'));
assert.ok(scripts.includes('autoplay-hotfix.js'));
assert.ok(styles.includes('autoplay.css'));
assert.ok(scripts.indexOf('automation-core.js') < scripts.indexOf('human-choice-policy.js'));
assert.ok(scripts.indexOf('live-dom-adapter.js') < scripts.indexOf('production-data-sync.js'));
assert.ok(scripts.indexOf('production-data-sync.js') < scripts.indexOf('content-script.js'));
assert.ok(scripts.indexOf('overlay.js') < scripts.indexOf('data-sync-ui.js'));
assert.ok(scripts.indexOf('feedback-parser-patch.js') < scripts.indexOf('content-script.js'));
assert.ok(scripts.indexOf('content-script.js') < scripts.indexOf('autoplay.js'));
assert.ok(scripts.indexOf('autoplay.js') < scripts.indexOf('autoplay-hotfix.js'));

const content = read('extension/content-script.js');
assert.ok(content.includes('isLiveAssistSurface'));
assert.ok(content.includes('isLocalLiveFixture'));
assert.ok(content.includes('startLiveAssistant'));
assert.ok(content.includes('FribergLiveDomAdapter.readFeedbackRow'));
assert.ok(content.includes('recordObservedVisibleFeedback'));
assert.ok(content.includes('fillAndSelectUniqueOption'));
assert.ok(content.includes('fillRandomFirstGuess'));
assert.ok(content.includes('submitCurrentLiveGuess'));
assert.ok(content.includes('SUBMIT_COOLDOWN_MS'));
assert.ok(content.includes('attemptQueuedLiveSubmit'));
assert.ok(content.includes('scheduleLiveSubmitRetry'));
assert.ok(content.includes("status: 'feedback-timeout'"));
assert.ok(content.includes("status: 'queue-timeout'"));
assert.ok(content.includes("'disabled', 'data-state'"));
assert.ok(content.includes('collectLiveDiagnostic'));
assert.ok(content.includes('feedbackPaused'));
assert.ok(content.includes("data-friberg-app=\"mirror\""));
assert.ok(content.includes('canPerformPageAction'));

const humanChoice = read('extension/human-choice-policy.js');
assert.ok(humanChoice.includes('HUMAN_ANSWER_THRESHOLD'));
assert.ok(humanChoice.includes('popularityScore'));
assert.ok(humanChoice.includes('chooseHumanCandidate'));
assert.ok(humanChoice.includes('__fribergHumanChoicePatched'));
assert.ok(humanChoice.includes('普通玩家更可能先想到的知名选手'));

const productionData = read('extension/production-data-sync.js');
assert.ok(productionData.includes('/api/players/list'));
assert.ok(productionData.includes('/api/players?search='));
assert.ok(productionData.includes('REQUEST_GAP_MS = 6500'));
assert.ok(productionData.includes('visible-feedback-row'));
assert.ok(productionData.includes('fribergProductionOverridesV1'));
assert.ok(productionData.includes('siteVersion'));

const syncUi = read('extension/data-sync-ui.js');
assert.ok(syncUi.includes('继续同步生产题库'));
assert.ok(syncUi.includes('friberg:production-sync'));
assert.ok(syncUi.includes('data-fa-production-sync-status'));

const overlay = read('extension/overlay.js');
assert.ok(overlay.includes('data-fa-drag-handle'));
assert.ok(overlay.includes('data-fa-window="collapse"'));
assert.ok(overlay.includes('setPointerCapture'));
assert.ok(overlay.includes('fribergAssistantOverlayLayoutV1'));
assert.ok(overlay.includes('resetPosition'));
assert.ok(overlay.includes('data-fa-action="random-first"'));
assert.ok(overlay.includes('data-fa-action="submit"'));
assert.ok(overlay.includes('view.submitLabel'));

const adapter = read('extension/live-dom-adapter.js');
assert.ok(adapter.includes('correct') && adapter.includes('close') && adapter.includes('wrong'));
assert.ok(adapter.includes('fillAndSelectUniqueOption'));
assert.ok(adapter.includes('uniqueSubmitButton'));
assert.ok(adapter.includes('submitSelectedGuess'));
assert.ok(adapter.includes('submitted: false'));
assert.ok(adapter.includes("row.closest('thead')"));
assert.ok(adapter.includes('nestedTables <= 1'));
assert.ok(adapter.includes('player-board-self'));
assert.ok(adapter.includes('player-board-opponent'));
assert.ok(adapter.includes('masked-cell'));
assert.ok(adapter.includes('[class*="arrow" i]'));
assert.ok(adapter.includes("node.getAttribute?.('class')"));
assert.ok(adapter.includes('feedbackRowFingerprint'));
assert.ok(!adapter.includes('WebSocket'));

const autoplayHotfix = read('extension/autoplay-hotfix.js');
assert.ok(autoplayHotfix.includes('Adapter.submitSelectedGuess'));
assert.ok(autoplayHotfix.includes('data-fa-single-loop-action'));
assert.ok(autoplayHotfix.includes("'/single/normal'"));
assert.ok(autoplayHotfix.includes('uniqueAgainButton'));

const parserPatch = read('extension/feedback-parser-patch.js');
assert.ok(parserPatch.includes('extractNickname'));
assert.ok(parserPatch.includes('trailingCellTexts'));
assert.ok(parserPatch.includes('FEEDBACK_PARSER_PATCH_VERSION'));
require('./run-feedback-parser-patch.js');

console.log(JSON.stringify({
  suite: 'extension-contract',
  version: manifest.version,
  files: scripts.length,
  routes: matches.filter(match => match.includes('shnlfriberg.online')),
  humanPriority: true,
  productionSync: true,
  productionSyncUi: true,
  firstGuessSubmitBridge: true,
  status: 'passed',
}));
