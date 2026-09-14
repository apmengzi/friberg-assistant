'use strict';

// Reproducible, offline-only inspection of the public client files captured
// under artifacts/live-site-assets. It never contacts the site itself.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const assetDir = path.join(root, 'artifacts', 'live-site-assets');
const targetFiles = fs.existsSync(assetDir)
  ? fs.readdirSync(assetDir).filter(name => /\.(?:js|css|html)$/i.test(name)).sort()
  : [];

const terms = [
  'multi', 'room', 'guess', 'player', 'feedback', 'correct', 'close', 'wrong',
  'green', 'yellow', 'gray', 'grey', 'age', 'major', 'status', 'rifler', 'awper', 'dir',
  '我的猜测', '正在获取房间状态', '多人联机', '/multi', '/room',
];

function compact(value, limit = 260) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function snippetsFor(source, term) {
  const lower = source.toLowerCase();
  const wanted = term.toLowerCase();
  const snippets = [];
  let offset = 0;
  while (snippets.length < 4) {
    const index = lower.indexOf(wanted, offset);
    if (index === -1) break;
    const start = Math.max(0, index - 110);
    const end = Math.min(source.length, index + term.length + 150);
    snippets.push(compact(source.slice(start, end)));
    offset = index + wanted.length;
  }
  return snippets;
}

const assets = targetFiles.map(name => {
  const full = path.join(assetDir, name);
  const source = fs.readFileSync(full, 'utf8');
  const hits = Object.fromEntries(terms
    .map(term => [term, snippetsFor(source, term)])
    .filter(([, snippets]) => snippets.length));
  return {
    name,
    bytes: Buffer.byteLength(source),
    sourceMapReference: /sourceMappingURL\s*=\s*([^\s*]+)/.exec(source)?.[1] || null,
    hits,
  };
});

const report = {
  generatedAt: new Date().toISOString(),
  assetDirectory: path.relative(root, assetDir).replace(/\\/g, '/'),
  assetCount: assets.length,
  assets,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
