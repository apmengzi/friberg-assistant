#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';

const apiBase = String(process.env.FRIBERG_LICENSE_API || '').replace(/\/+$/, '');
const adminToken = String(process.env.FRIBERG_LICENSE_ADMIN_TOKEN || '');
const [, , command, ...args] = process.argv;

function usage(message = '') {
  if (message) console.error(message);
  console.error(`
Usage:
  node commercial/tools/license-admin.mjs create <5h|12h|1d|3d|7d|30d> [quantity] [--order REF] [--note TEXT] [--out FILE]
  node commercial/tools/license-admin.mjs list [unused|active|expired|revoked]
  node commercial/tools/license-admin.mjs revoke <license-id>
  node commercial/tools/license-admin.mjs reset-device <license-id>

Environment:
  FRIBERG_LICENSE_API
  FRIBERG_LICENSE_ADMIN_TOKEN
`);
  process.exit(1);
}

if (!apiBase || !/^https?:\/\//i.test(apiBase)) usage('FRIBERG_LICENSE_API 未配置为 http(s) 地址。');
if (adminToken.length < 24) usage('FRIBERG_LICENSE_ADMIN_TOKEN 未配置或过短。');

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
  return payload;
}

async function main() {
  if (command === 'create') {
    const tier = args[0];
    const quantity = Number(args[1] || 1);
    if (!tier || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) usage('卡种或数量无效。');
    const payload = await request('/v1/admin/licenses/batch', {
      method: 'POST',
      body: {
        tier,
        quantity,
        orderRef: option('--order'),
        note: option('--note'),
      },
    });
    const text = [
      '# 明文卡密仅返回这一次；请逐单保存，不要公开截图。',
      ...payload.cards.map(card => `${card.cardKey}\t${card.tierLabel}\t${card.id}`),
      '',
    ].join('\n');
    const output = option('--out');
    if (output) {
      fs.writeFileSync(output, text, { encoding: 'utf8', mode: 0o600 });
      console.log(`已生成 ${payload.cards.length} 张卡，保存到 ${output}`);
    } else {
      process.stdout.write(text);
    }
    return;
  }

  if (command === 'list') {
    const status = args[0] ? `?status=${encodeURIComponent(args[0])}` : '';
    const payload = await request(`/v1/admin/licenses${status}`);
    console.table(payload.licenses.map(item => ({
      id: item.id,
      hint: item.keyHint,
      tier: item.tier,
      status: item.status,
      expiresAt: item.expiresAt ? new Date(item.expiresAt * 1000).toISOString() : '',
      device: item.deviceBound ? 'bound' : 'none',
      order: item.orderRef || '',
    })));
    return;
  }

  if (command === 'revoke' || command === 'reset-device') {
    if (!args[0]) usage('缺少 license-id。');
    const payload = await request(`/v1/admin/licenses/${encodeURIComponent(args[0])}/${command}`, { method: 'POST' });
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  usage();
}

main().catch(cause => {
  console.error(`操作失败：${cause.message}`);
  process.exit(1);
});
