import path from 'node:path';
import process from 'node:process';
import { mkdir } from 'node:fs/promises';
import { createSigningKeys, isInside } from './license-format.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

const keyDirectory = path.resolve(argument('--key-dir') || '');
const projectRoot = path.resolve(import.meta.dirname, '..', '..');
if (!argument('--key-dir')) throw new Error('必须使用 --key-dir 指定项目目录外的密钥文件夹。');
if (isInside(projectRoot, keyDirectory)) throw new Error('拒绝在项目目录内生成私钥，请选择项目外的专用文件夹。');

await mkdir(keyDirectory, { recursive: true });
const privateKeyPath = path.join(keyDirectory, 'private-license-key.pem');
const publicKeyPath = path.join(keyDirectory, 'public-license-key.pem');
const info = await createSigningKeys({ privateKeyPath, publicKeyPath });

process.stdout.write(`${JSON.stringify({
  status: 'created',
  privateKeyPath,
  publicKeyPath,
  keyId: info.keyId,
}, null, 2)}\n`);

