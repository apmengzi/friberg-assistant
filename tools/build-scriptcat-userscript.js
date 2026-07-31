'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const write = (relative, contents) => {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, 'utf8');
};

const template = read('userscript/friberg-assistant-scriptcat.template.js');
const solver = read('solver.js');
const automation = read('automation-core.js');
const liveAdapter = read('live-dom-adapter.js');
const players = read('data/players.game-646.json');
const built = template
  .replace('/*__GAME_SOLVER__*/', () => solver)
  .replace('/*__AUTOMATION_CORE__*/', () => automation)
  .replace('/*__LIVE_DOM_ADAPTER__*/', () => liveAdapter)
  .replace('/*__PLAYER_ROWS__*/', () => players);

const placeholders = ['/*__GAME_SOLVER__*/', '/*__AUTOMATION_CORE__*/', '/*__LIVE_DOM_ADAPTER__*/', '/*__PLAYER_ROWS__*/'];
const unresolved = placeholders.filter(token => built.includes(token));
if (unresolved.length) {
  throw new Error(`userscript placeholders were not fully replaced: ${unresolved.join(', ')}`);
}

write('dist/friberg-assistant-scriptcat.user.js', built);
write('dist/friberg-assistant.user.js', built);
console.log(JSON.stringify({
  output: ['dist/friberg-assistant-scriptcat.user.js', 'dist/friberg-assistant.user.js'],
  bytes: Buffer.byteLength(built),
  roster: JSON.parse(players).length,
  status: 'built',
}));
