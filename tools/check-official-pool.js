const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const localPath = path.join(root, 'data/players.game-646.json');
const remoteUrl = 'https://raw.githubusercontent.com/shnlfriberg/csgo-major-db/main/players.json';
const outputPath = path.join(root, 'outputs/official-pool-check.json');

const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
};

const hash = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const setOutput = (key, value) => {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${String(value)}\n`);
};

(async () => {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const local = JSON.parse(fs.readFileSync(localPath, 'utf8').replace(/^\uFEFF/, ''));
  const report = {
    checkedAt: new Date().toISOString(),
    remoteUrl,
    localCount: Array.isArray(local) ? local.length : null,
    localHash: hash(local),
    status: 'unknown',
  };

  try {
    const response = await fetch(remoteUrl, {
      headers: { 'user-agent': 'friberg-assistant-pool-watcher' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const remote = await response.json();
    report.remoteCount = Array.isArray(remote) ? remote.length : null;
    report.remoteHash = hash(remote);
    report.changed = report.localHash !== report.remoteHash;
    report.status = report.changed ? 'changed' : 'current';
    if (report.changed) {
      const localByNick = new Map(local.map(row => [String(row.nickname || row.nick || '').toLocaleLowerCase(), row]));
      const remoteByNick = new Map(remote.map(row => [String(row.nickname || row.nick || '').toLocaleLowerCase(), row]));
      report.added = Array.from(remoteByNick.keys()).filter(key => !localByNick.has(key));
      report.removed = Array.from(localByNick.keys()).filter(key => !remoteByNick.has(key));
      report.changedNicknames = Array.from(remoteByNick.keys()).filter(key => (
        localByNick.has(key)
        && hash(localByNick.get(key)) !== hash(remoteByNick.get(key))
      ));
    }
  } catch (error) {
    report.status = 'unavailable';
    report.changed = false;
    report.error = error instanceof Error ? error.message : String(error);
  }

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  setOutput('status', report.status);
  setOutput('changed', Boolean(report.changed));
  setOutput('local_count', report.localCount ?? 'unknown');
  setOutput('remote_count', report.remoteCount ?? 'unknown');
  setOutput('local_hash', report.localHash || '');
  setOutput('remote_hash', report.remoteHash || '');
  console.log(JSON.stringify(report));
})();
