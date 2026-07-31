import assert from 'node:assert/strict';
import { handleRequest } from '../commercial/license-worker/src/worker.js';

class MemoryD1 {
  constructor() {
    this.licenses = new Map();
    this.events = [];
  }

  prepare(sql) {
    const db = this;
    const normalized = sql.replace(/\s+/g, ' ').trim();
    let values = [];
    return {
      bind(...args) {
        values = args;
        return this;
      },
      async first() {
        if (normalized.includes('WHERE key_hash = ?')) {
          return [...db.licenses.values()].find(row => row.key_hash === values[0]) || null;
        }
        if (normalized.includes('WHERE id = ?')) return db.licenses.get(values[0]) || null;
        throw new Error(`Unsupported first SQL: ${normalized}`);
      },
      async run() {
        if (normalized.startsWith('INSERT INTO license_events')) {
          db.events.push({
            license_id: values[0],
            event_type: values[1],
            created_at: values[2],
            detail_json: values[3],
          });
          return { meta: { changes: 1 } };
        }
        if (normalized.startsWith('INSERT INTO license_keys')) {
          const [id, productId, keyHash, keyPrefix, keyLast4, tier, durationSeconds, createdAt, note, orderRef] = values;
          db.licenses.set(id, {
            id,
            product_id: productId,
            key_hash: keyHash,
            key_prefix: keyPrefix,
            key_last4: keyLast4,
            tier,
            duration_seconds: durationSeconds,
            status: 'unused',
            created_at: createdAt,
            activated_at: null,
            expires_at: null,
            device_hash: null,
            refresh_hash: null,
            last_seen_at: null,
            note,
            order_ref: orderRef,
          });
          return { meta: { changes: 1 } };
        }
        if (normalized.includes("SET status = 'active', activated_at = ?")) {
          const [activatedAt, expiresAt, deviceHash, refreshHash, lastSeenAt, id] = values;
          const row = db.licenses.get(id);
          if (!row || row.activated_at) return { meta: { changes: 0 } };
          Object.assign(row, {
            status: 'active',
            activated_at: activatedAt,
            expires_at: expiresAt,
            device_hash: deviceHash,
            refresh_hash: refreshHash,
            last_seen_at: lastSeenAt,
          });
          return { meta: { changes: 1 } };
        }
        if (normalized.includes("SET status = 'active', device_hash = ?")) {
          const [deviceHash, refreshHash, lastSeenAt, id] = values;
          Object.assign(db.licenses.get(id), {
            status: 'active',
            device_hash: deviceHash,
            refresh_hash: refreshHash,
            last_seen_at: lastSeenAt,
          });
          return { meta: { changes: 1 } };
        }
        if (normalized.includes("SET status = 'expired'")) {
          db.licenses.get(values[0]).status = 'expired';
          return { meta: { changes: 1 } };
        }
        if (normalized.includes("SET status = 'revoked'")) {
          Object.assign(db.licenses.get(values[0]), { status: 'revoked', refresh_hash: null });
          return { meta: { changes: 1 } };
        }
        if (normalized.includes('SET status = ?, device_hash = NULL')) {
          const [status, id] = values;
          Object.assign(db.licenses.get(id), { status, device_hash: null, refresh_hash: null });
          return { meta: { changes: 1 } };
        }
        if (normalized.includes('SET last_seen_at = ?')) {
          const [lastSeenAt, id] = values;
          db.licenses.get(id).last_seen_at = lastSeenAt;
          return { meta: { changes: 1 } };
        }
        throw new Error(`Unsupported run SQL: ${normalized}`);
      },
      async all() {
        return { results: [...db.licenses.values()] };
      },
    };
  }
}

const env = {
  DB: new MemoryD1(),
  PRODUCT_ID: 'friberg-assistant-pro',
  LICENSE_PEPPER: 'integration-test-pepper-with-more-than-32-bytes',
  ADMIN_TOKEN: 'integration-test-admin-token-more-than-32-bytes',
};

async function call(path, { method = 'POST', body, admin = false } = {}) {
  const response = await handleRequest(new Request(`https://license.test${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(admin ? { authorization: `Bearer ${env.ADMIN_TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  return { status: response.status, body: await response.json() };
}

const created = await call('/v1/admin/licenses/batch', {
  admin: true,
  body: { tier: '5h', quantity: 1, orderRef: 'ORDER-1' },
});
assert.equal(created.status, 201);
assert.equal(created.body.cards.length, 1);
const card = created.body.cards[0];

const activatedA = await call('/v1/licenses/activate', {
  body: { cardKey: card.cardKey, deviceId: 'device-a-identifier-123456', clientVersion: '0.9.0' },
});
assert.equal(activatedA.status, 200);
assert.equal(activatedA.body.active, true);
assert.equal(activatedA.body.license.tier, '5h');
assert.ok(activatedA.body.refreshToken.length >= 40);

const refreshedA = await call('/v1/licenses/refresh', {
  body: {
    licenseId: card.id,
    deviceId: 'device-a-identifier-123456',
    refreshToken: activatedA.body.refreshToken,
  },
});
assert.equal(refreshedA.status, 200);
assert.equal(refreshedA.body.active, true);

const rejectedB = await call('/v1/licenses/activate', {
  body: { cardKey: card.cardKey, deviceId: 'device-b-identifier-123456', clientVersion: '0.9.0' },
});
assert.equal(rejectedB.status, 409);
assert.equal(rejectedB.body.code, 'DEVICE_MISMATCH');

const reset = await call(`/v1/admin/licenses/${card.id}/reset-device`, { admin: true });
assert.equal(reset.status, 200);
assert.equal(reset.body.license.deviceBound, false);

const activatedB = await call('/v1/licenses/activate', {
  body: { cardKey: card.cardKey, deviceId: 'device-b-identifier-123456', clientVersion: '0.9.0' },
});
assert.equal(activatedB.status, 200);
assert.equal(activatedB.body.active, true);

const revoked = await call(`/v1/admin/licenses/${card.id}/revoke`, { admin: true });
assert.equal(revoked.status, 200);
assert.equal(revoked.body.license.status, 'revoked');

const refreshAfterRevoke = await call('/v1/licenses/refresh', {
  body: {
    licenseId: card.id,
    deviceId: 'device-b-identifier-123456',
    refreshToken: activatedB.body.refreshToken,
  },
});
assert.equal(refreshAfterRevoke.status, 403);
assert.equal(refreshAfterRevoke.body.code, 'REVOKED');

assert.ok(env.DB.events.some(event => event.event_type === 'activated'));
assert.ok(env.DB.events.some(event => event.event_type === 'activation_rejected'));
assert.ok(env.DB.events.some(event => event.event_type === 'device_reset'));
assert.ok(env.DB.events.some(event => event.event_type === 'revoked'));

console.log(JSON.stringify({
  suite: 'license-worker-integration',
  firstActivation: true,
  refresh: true,
  deviceBinding: true,
  deviceReset: true,
  revocation: true,
  rawKeysStored: false,
  status: 'passed',
}));
