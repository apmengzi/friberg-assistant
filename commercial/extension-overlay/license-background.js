'use strict';

importScripts('license-config.js', 'license-core.js');

const INSTALLATION_KEY = 'fribergOfflineInstallationIdV1';
const LICENSE_KEY = 'fribergOfflineSignedLicenseV1';
const CLOCK_KEY = 'fribergOfflineClockStateV1';
const config = globalThis.FribergLicenseConfig;
const core = globalThis.FribergOfflineLicenseCore;

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function getInstallationId() {
  const saved = await chrome.storage.local.get({ [INSTALLATION_KEY]: '' });
  if (saved[INSTALLATION_KEY]) return saved[INSTALLATION_KEY];
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const installationId = base64url(bytes);
  await chrome.storage.local.set({ [INSTALLATION_KEY]: installationId });
  return installationId;
}

async function getDeviceInfo() {
  const installationId = await getInstallationId();
  const deviceCode = await core.deviceCodeFromInstallationId(installationId);
  return Object.freeze({
    deviceCode,
    deviceHash: await core.hashDeviceCode(deviceCode),
  });
}

async function readClockState() {
  const saved = await chrome.storage.local.get({ [CLOCK_KEY]: null });
  return saved[CLOCK_KEY] || {
    installedAtMs: Date.now(),
    maxObservedMs: Date.now(),
    lastVerifiedAtMs: 0,
  };
}

async function checkClock() {
  const nowMs = Date.now();
  const state = await readClockState();
  if (nowMs + Number(config.rollbackToleranceMs || 21600000) < Number(state.maxObservedMs || 0)) {
    return {
      ok: false,
      nowMs,
      code: 'CLOCK_ROLLBACK',
      message: '检测到系统时间明显倒退，请恢复正确时间后重新检查。',
      state,
    };
  }
  const updated = {
    installedAtMs: Number(state.installedAtMs || nowMs),
    maxObservedMs: Math.max(nowMs, Number(state.maxObservedMs || 0)),
    lastVerifiedAtMs: Number(state.lastVerifiedAtMs || 0),
  };
  await chrome.storage.local.set({ [CLOCK_KEY]: updated });
  return { ok: true, nowMs, state: updated };
}

function inactive(code, message, extra = {}) {
  return { active: false, code, message, ...extra };
}

function activeResult(verified, deviceInfo, source) {
  const payload = verified.payload;
  return {
    active: true,
    code: 'ACTIVE',
    source,
    message: '离线许可证有效。',
    license: {
      id: payload.licenseId,
      issuedAt: payload.issuedAt,
      notBefore: payload.notBefore,
      expiresAt: payload.expiresAt,
      features: payload.features,
      minVersion: payload.minVersion,
      maxVersion: payload.maxVersion,
      keyId: payload.keyId,
      deviceCode: deviceInfo.deviceCode,
      remainingSeconds: verified.remainingSeconds,
    },
  };
}

async function verifyStoredLicense(source = 'stored') {
  const deviceInfo = await getDeviceInfo();
  const clock = await checkClock();
  if (!clock.ok) return inactive(clock.code, clock.message, { device: deviceInfo });
  const saved = await chrome.storage.local.get({ [LICENSE_KEY]: '' });
  if (!saved[LICENSE_KEY]) {
    return inactive('NO_LICENSE', '请输入针对当前设备码签发的许可证。', { device: deviceInfo });
  }
  try {
    const verified = await core.verifyLicense(saved[LICENSE_KEY], {
      publicKeySpkiBase64: config.publicKeySpkiBase64,
      keyId: config.keyId,
      product: config.product,
      edition: config.edition,
      clientVersion: config.clientVersion,
      deviceCode: deviceInfo.deviceCode,
      nowMs: clock.nowMs,
    });
    await chrome.storage.local.set({
      [CLOCK_KEY]: {
        ...clock.state,
        maxObservedMs: Math.max(clock.nowMs, Number(clock.state.maxObservedMs || 0)),
        lastVerifiedAtMs: clock.nowMs,
      },
    });
    return activeResult(verified, deviceInfo, source);
  } catch (cause) {
    return inactive(cause.code || 'LICENSE_ERROR', cause.message || '许可证检查失败。', {
      device: deviceInfo,
    });
  }
}

async function activateLicense(licenseText) {
  const deviceInfo = await getDeviceInfo();
  const clock = await checkClock();
  if (!clock.ok) return inactive(clock.code, clock.message, { device: deviceInfo });
  try {
    const verified = await core.verifyLicense(String(licenseText || ''), {
      publicKeySpkiBase64: config.publicKeySpkiBase64,
      keyId: config.keyId,
      product: config.product,
      edition: config.edition,
      clientVersion: config.clientVersion,
      deviceCode: deviceInfo.deviceCode,
      nowMs: clock.nowMs,
    });
    await chrome.storage.local.set({
      [LICENSE_KEY]: verified.text,
      [CLOCK_KEY]: {
        ...clock.state,
        maxObservedMs: Math.max(clock.nowMs, Number(clock.state.maxObservedMs || 0)),
        lastVerifiedAtMs: clock.nowMs,
      },
    });
    return activeResult(verified, deviceInfo, 'activated');
  } catch (cause) {
    return inactive(cause.code || 'LICENSE_ERROR', cause.message || '许可证激活失败。', {
      device: deviceInfo,
    });
  }
}

async function clearLicense() {
  await chrome.storage.local.remove(LICENSE_KEY);
  const device = await getDeviceInfo();
  return inactive('CLEARED', '许可证已从当前安装实例清除。', { device });
}

async function handleMessage(message) {
  if (message.action === 'device') {
    return inactive('NO_LICENSE', '等待许可证。', { device: await getDeviceInfo() });
  }
  if (message.action === 'activate') return activateLicense(message.licenseText);
  if (message.action === 'status') return verifyStoredLicense(message.force ? 'rechecked' : 'stored');
  if (message.action === 'clear') return clearLicense();
  return inactive('UNKNOWN_ACTION', '未知许可证操作。');
}

chrome.runtime.onInstalled.addListener(() => {
  void getInstallationId();
  void readClockState().then(state => chrome.storage.local.set({ [CLOCK_KEY]: state }));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'friberg-offline-license') return undefined;
  handleMessage(message)
    .then(sendResponse)
    .catch(cause => sendResponse(inactive(
      cause.code || 'LICENSE_RUNTIME_ERROR',
      cause.message || '许可证服务发生错误。',
    )));
  return true;
});
