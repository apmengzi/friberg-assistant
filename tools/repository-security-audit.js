'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root })
  .toString('utf8')
  .split('\0')
  .filter(Boolean);

const errors = [];
const warnings = [];

const normalized = value => value.replace(/\\/g, '/');
const add = (list, file, rule, detail) => list.push({ file: normalized(file), rule, detail });

for (const relative of tracked) {
  const file = normalized(relative);
  const lower = file.toLowerCase();
  const base = path.posix.basename(lower);

  if (
    base === '.env' ||
    base.startsWith('.env.') ||
    lower.includes('/seller-secrets/') ||
    lower.startsWith('seller-secrets/') ||
    lower.includes('/license-records/') ||
    lower.startsWith('license-records/') ||
    /(^|\/)private[^/]*\.pem$/.test(lower) ||
    /(^|\/)private-license-key\.pem$/.test(lower)
  ) {
    add(errors, file, 'forbidden-secret-path', 'Secret-bearing paths must never be tracked.');
  }

  if (
    lower.startsWith('.playwright-mcp/') ||
    lower.includes('/__pycache__/') ||
    lower.endsWith('.pyc') ||
    lower === 'work/server.err' ||
    lower === 'work/server.out'
  ) {
    add(warnings, file, 'runtime-artifact-tracked', 'Move runtime artifacts out of version control.');
  }

  const absolute = path.join(root, relative);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue;

  let text;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch {
    continue;
  }

  // Build the markers at runtime so this audit file does not flag its own rules.
  const begin = '-----BEGIN';
  const end = 'KEY-----';
  const privateKeyMarkers = [
    `${begin} PRIVATE ${end}`,
    `${begin} RSA PRIVATE ${end}`,
    `${begin} EC PRIVATE ${end}`,
    `${begin} OPENSSH PRIVATE ${end}`,
  ];
  for (const marker of privateKeyMarkers) {
    if (text.includes(marker)) add(errors, file, 'private-key-block', marker);
  }

  const tokenPatterns = [
    /\bghp_[A-Za-z0-9]{30,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
    /\bsk-[A-Za-z0-9_-]{32,}\b/g,
  ];
  for (const pattern of tokenPatterns) {
    const match = text.match(pattern);
    if (match) add(errors, file, 'credential-pattern', `${match[0].slice(0, 8)}…`);
  }

  if (/C:\\Users\\[^\\\r\n]+/i.test(text)) {
    add(warnings, file, 'local-absolute-path', 'Replace developer-machine paths with portable placeholders.');
  }

  if (lower.includes('commercial') && text.includes('http://127.0.0.1:8787')) {
    add(warnings, file, 'legacy-local-license-endpoint', 'Do not distribute this build as a buyer-ready package.');
  }
}

const report = {
  trackedFiles: tracked.length,
  errors,
  warnings,
  status: errors.length ? 'failed' : 'passed',
};

console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;
