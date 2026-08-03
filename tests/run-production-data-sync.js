const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../extension/production-data-sync.js'), 'utf8');
const storedOverrides = {
  old_player: {
    id: 1,
    nickname: 'old_player',
    nationality: '丹麦',
    region: '欧洲',
    team: 'NAVI',
    age: 30,
    role: 'Coach',
    major_championships: 1,
    major_appearances: 9,
    is_active: true,
    difficulties: ['normal'],
    source: 'public-player-search',
    production_verified_at: '2026-08-03T00:00:00.000Z',
  },
  new_live_player: {
    id: 9999,
    nickname: 'new_live_player',
    nationality: '法国',
    region: '欧洲',
    team: 'Vitality',
    age: 21,
    role: 'Rifler',
    major_championships: 0,
    major_appearances: 1,
    is_active: true,
    difficulties: ['normal', 'easy'],
    source: 'public-player-search',
    production_verified_at: '2026-08-03T00:00:00.000Z',
  },
};

class MutationObserver {
  observe() {}
  disconnect() {}
}

const document = {
  visibilityState: 'hidden',
  documentElement: {},
  addEventListener() {},
  dispatchEvent() {},
};

const context = vm.createContext({
  console,
  URL,
  Response,
  Request,
  Event,
  CustomEvent: class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
  MutationObserver,
  document,
  location: { hostname: 'shnlfriberg.online' },
  setTimeout: () => 1,
  clearTimeout() {},
  Math,
  Date,
  Promise,
  fetch: async () => { throw new Error('unexpected network request'); },
  chrome: {
    runtime: { getURL: relative => `chrome-extension://unit/${relative}` },
    storage: {
      local: {
        get(keys, callback) {
          callback({
            fribergProductionOverridesV1: storedOverrides,
            fribergProductionSyncMetaV1: {},
          });
        },
        set(values, callback) { callback?.(); },
      },
    },
  },
});
context.globalThis = context;
vm.runInContext(source, context, { filename: 'production-data-sync.js' });

(async () => {
  await context.FribergProductionData.ready;
  const base = [{
    id: 1,
    nickname: 'old_player',
    nationality: '丹麦',
    region: '欧洲',
    team: '退役',
    age: 29,
    role: 'Rifler',
    major_championships: 0,
    major_appearances: 8,
    difficulties: ['normal'],
    is_active: false,
    is_enabled: true,
  }];
  const merged = context.FribergProductionData.mergePool(base);
  assert.strictEqual(merged.length, 2, 'new production players must be appended to the local pool');
  const oldPlayer = merged.find(player => player.nickname === 'old_player');
  const newPlayer = merged.find(player => player.nickname === 'new_live_player');
  assert.strictEqual(oldPlayer.team, 'NAVI');
  assert.strictEqual(oldPlayer.role, 'Coach');
  assert.strictEqual(oldPlayer.major_championships, 1);
  assert.strictEqual(oldPlayer.is_active, true);
  assert.ok(newPlayer);
  assert.strictEqual(newPlayer.team, 'Vitality');
  assert.deepStrictEqual(Array.from(newPlayer.difficulties), ['normal', 'easy']);
  assert.strictEqual(newPlayer.is_enabled, true);
  console.log(JSON.stringify({
    suite: 'production-data-sync',
    updatedExisting: oldPlayer.nickname,
    appendedNew: newPlayer.nickname,
    status: 'passed',
  }));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
