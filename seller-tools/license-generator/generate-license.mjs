import { createHash, createPublicKey } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  createLicensePayload,
  publicKeyInfo,
  readSigningKey,
  signLicense,
  validateDeviceCode,
} from './license-format.mjs';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const privateKeyPath = path.resolve(argument('--private-key'));
const deviceCode = validateDeviceCode(argument('--device-code'));
const licenseId = argument('--license-id');
const days = Number(argument('--days', '0'));
const hours = Number(argument('--hours', '0'));
const minVersion = argument('--min-version', '0.9.2');
const maxVersion = argument('--max-version') || null;
const note = argument('--note');
const outPath = argument('--out') ? path.resolve(argument('--out')) : '';

if (!argument('--private-key')) throw new Error('必须通过 --private-key 指定项目外的私钥。');
if (!licenseId) throw new Error('必须通过 --license-id 指定许可证编号。');
if ((!Number.isFinite(days) || days < 0) || (!Number.isFinite(hours) || hours < 0) || days + hours <= 0) {
  throw new Error('请指定正数 --days 或 --hours。');
}

const privateKey = await readSigningKey(privateKeyPath);
const publicKey = createPublicKey(privateKey);
const keyInfo = publicKeyInfo(publicKey);
const issuedAt = new Date();
const expiresAt = new Date(issuedAt.getTime() + ((days * 24) + hours) * 60 * 60 * 1000);
const payload = createLicensePayload({
  licenseId,
  deviceCode,
  issuedAt,
  expiresAt,
  minVersion,
  maxVersion,
  keyId: keyInfo.keyId,
});
const license = signLicense(payload, privateKey);
const report = {
  licenseId,
  deviceCode,
  issuedAt: payload.issuedAt,
  expiresAt: payload.expiresAt,
  keyId: payload.keyId,
  minVersion,
  maxVersion,
  note: note || null,
  sha256: createHash('sha256').update(license, 'utf8').digest('hex'),
  license,
};

if (outPath) {
  await mkdir(path.dirname(outPath), { recursive: true });
  const text = [
    `许可证编号: ${licenseId}`,
    `设备码: ${deviceCode}`,
    `签发时间: ${payload.issuedAt}`,
    `到期时间: ${payload.expiresAt}`,
    `SHA-256: ${report.sha256}`,
    note ? `备注: ${note}` : '',
    '',
    license,
    '',
  ].filter((line, index, lines) => line || lines[index - 1]).join('\n');
  await writeFile(outPath, text, { encoding: 'utf8', flag: 'wx' });
  report.outputFile = outPath;
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
