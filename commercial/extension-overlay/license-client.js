(function initFribergOfflineLicenseClient(global) {
  'use strict';

  const ROOT_ID = 'friberg-license-gate';
  const config = global.FribergLicenseConfig;
  let activeLicense = null;
  let monitorTimer = 0;
  let gatePromise = null;

  function send(action, extra = {}) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'friberg-offline-license', action, ...extra }, response => {
        if (chrome.runtime.lastError) {
          resolve({ active: false, code: 'RUNTIME_ERROR', message: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { active: false, code: 'EMPTY_RESPONSE', message: '许可证模块没有响应。' });
      });
    });
  }

  function formatExpiry(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '未知';
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(date);
  }

  function remainingText() {
    if (!activeLicense) return '未激活';
    const seconds = Math.max(0, Math.floor((Date.parse(activeLicense.expiresAt) - Date.now()) / 1000));
    if (seconds <= 0) return '已到期';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return days ? `${days}天 ${hours}小时` : hours ? `${hours}小时 ${minutes}分钟` : `${minutes}分钟`;
  }

  function isActive() {
    return Boolean(activeLicense && Date.now() < Date.parse(activeLicense.expiresAt));
  }

  function notify(name, detail) {
    global.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function removeGate() {
    document.getElementById(ROOT_ID)?.remove();
    gatePromise = null;
  }

  function copyText(value) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
    const field = document.createElement('textarea');
    field.value = value;
    field.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.documentElement.append(field);
    field.select();
    document.execCommand('copy');
    field.remove();
    return Promise.resolve();
  }

  function downloadCompatibilityDiagnostic() {
    const adapter = global.FribergLiveDomAdapter;
    if (!adapter) throw new Error('页面诊断模块尚未加载。');
    const scanResult = adapter.scan(document);
    const report = adapter.diagnostic({
      scanResult,
      activeBoard: null,
      recentMutations: [],
      errors: [],
      extensionVersion: config.adapterVersion,
      gamePoolSize: 646,
      adapterState: {
        listening: false,
        licenseGate: true,
        licenseTextExcluded: true,
      },
    });
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `friberg-license-diagnostic-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function gateStyles() {
    return `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .backdrop { position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;background:rgba(5,11,20,.86);color:#edf4ff;font-family:"Segoe UI","Microsoft YaHei",sans-serif;backdrop-filter:blur(7px); }
      .card { width:min(680px,100%);border:1px solid #34506e;background:#0c1725;box-shadow:0 24px 80px rgba(0,0,0,.58); }
      .stripe { height:7px;background:linear-gradient(90deg,#276fff 0 62%,#ffd84d 62%); }
      .body { padding:28px; }
      .eyebrow { color:#78a7ff;font:700 12px/1.3 ui-monospace,Consolas,monospace;letter-spacing:.16em; }
      h1 { margin:8px 0 4px;color:#fff;font-size:26px; }
      .sub { margin:0 0 20px;color:#9fb0c4;font-size:14px;line-height:1.7; }
      label { display:block;margin:15px 0 7px;color:#d9e6f7;font-weight:700;font-size:13px; }
      .row { display:grid;grid-template-columns:1fr auto;gap:10px; }
      code,textarea { width:100%;border:1px solid #3c526d;background:#07111d;color:#fff;padding:12px 13px;font:600 13px/1.45 ui-monospace,Consolas,monospace; }
      code { display:block;overflow-wrap:anywhere;color:#9fe5ff; }
      textarea { min-height:112px;resize:vertical;outline:none; }
      textarea:focus { border-color:#6f9eff;box-shadow:0 0 0 3px rgba(39,111,255,.18); }
      button { min-width:112px;border:0;cursor:pointer;padding:0 16px;background:#ffd84d;color:#111b27;font-weight:800; }
      button.secondary { background:#26445e;color:#dceeff; }
      button:disabled { cursor:wait;opacity:.58; }
      .message { min-height:24px;margin-top:12px;color:#ff8a83;font-size:13px;line-height:1.55; }
      .active { color:#82e5bf; }
      .rules { margin-top:18px;border-top:1px solid #25384d;padding-top:15px;display:grid;gap:7px;color:#9fb0c4;font-size:12px;line-height:1.55; }
      .rules b { color:#dbe9fb; }
    `;
  }

  async function mountGate(initialResult = null) {
    const existing = document.getElementById(ROOT_ID);
    if (existing && gatePromise) return gatePromise;
    const deviceResult = initialResult?.device ? initialResult : await send('device');
    const deviceCode = deviceResult.device?.deviceCode || '设备码读取失败';
    const host = document.createElement('div');
    host.id = ROOT_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = gateStyles();
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    backdrop.innerHTML = `
      <section class="card" role="dialog" aria-modal="true" aria-labelledby="friberg-license-title">
        <div class="stripe"></div>
        <div class="body">
          <div class="eyebrow">FRIBERG ASSISTANT / OFFLINE LICENSE</div>
          <h1 id="friberg-license-title">弗一把助手 · 付费测试版</h1>
          <p class="sub">这是绑定当前浏览器安装实例的离线许可证。先复制设备码发给卖家，再粘贴卖家签发的完整许可证。</p>
          <label>当前设备码</label>
          <div class="row"><code id="friberg-device-code">${deviceCode}</code><button class="secondary" id="friberg-copy-device" type="button">复制设备码</button></div>
          <label for="friberg-license-text">许可证</label>
          <textarea id="friberg-license-text" autocomplete="off" spellcheck="false" placeholder="FRIBERG1.……"></textarea>
          <div class="row" style="margin-top:10px"><button class="secondary" id="friberg-download-diagnostic" type="button">下载页面诊断</button><button id="friberg-activate" type="button">激活并进入</button></div>
          <div class="message" id="friberg-message">${initialResult?.message || ''}</div>
          <div class="rules">
            <div><b>自然时间计时</b> · 从卖家生成许可证时开始，到期后停止核心功能。</div>
            <div><b>安装实例绑定</b> · 清除扩展数据或重新安装可能改变设备码。</div>
            <div><b>离线验证</b> · 不连接卡密服务器；离线许可无法远程撤销，也不承诺绝对防破解。</div>
          </div>
        </div>
      </section>`;
    shadow.append(style, backdrop);
    document.documentElement.append(host);

    const copyButton = shadow.getElementById('friberg-copy-device');
    const input = shadow.getElementById('friberg-license-text');
    const activateButton = shadow.getElementById('friberg-activate');
    const diagnosticButton = shadow.getElementById('friberg-download-diagnostic');
    const message = shadow.getElementById('friberg-message');
    copyButton.addEventListener('click', async () => {
      await copyText(deviceCode);
      copyButton.textContent = '已复制';
      setTimeout(() => { copyButton.textContent = '复制设备码'; }, 1200);
    });
    diagnosticButton.addEventListener('click', () => {
      try {
        downloadCompatibilityDiagnostic();
        message.className = 'message active';
        message.textContent = '页面诊断已下载；许可证内容不会写入诊断文件。';
      } catch (cause) {
        message.className = 'message';
        message.textContent = cause.message || '页面诊断下载失败。';
      }
    });

    gatePromise = new Promise(resolve => {
      activateButton.addEventListener('click', async () => {
        const licenseText = input.value.trim();
        if (!licenseText) {
          message.textContent = '请粘贴完整许可证。';
          return;
        }
        activateButton.disabled = true;
        message.className = 'message';
        message.textContent = '正在验证 Ed25519 签名、设备码和有效期…';
        const result = await send('activate', { licenseText });
        input.value = '';
        if (!result.active) {
          message.textContent = result.message || '许可证激活失败。';
          activateButton.disabled = false;
          input.focus();
          return;
        }
        activeLicense = Object.freeze(result.license);
        message.className = 'message active';
        message.textContent = `许可证 ${result.license.id} 已激活，有效至 ${formatExpiry(result.license.expiresAt)}。`;
        setTimeout(() => {
          removeGate();
          startMonitor();
          notify('friberg:license-activated', result);
          resolve(result);
        }, 500);
      });
    });
    setTimeout(() => input.focus(), 0);
    return gatePromise;
  }

  async function recheck() {
    const result = await send('status', { force: true });
    if (result.active) {
      activeLicense = Object.freeze(result.license);
      notify('friberg:license-status', result);
      return result;
    }
    activeLicense = null;
    notify('friberg:license-invalidated', result);
    document.getElementById('friberg-assistant-overlay')?.remove();
    void mountGate(result);
    return result;
  }

  function startMonitor() {
    clearInterval(monitorTimer);
    monitorTimer = setInterval(() => { void recheck(); }, Math.max(10000, Number(config.verificationIntervalMs || 30000)));
  }

  async function requireActiveLicense() {
    const result = await send('status');
    if (result.active) {
      activeLicense = Object.freeze(result.license);
      startMonitor();
      return result;
    }
    activeLicense = null;
    return mountGate(result);
  }

  function requireValidLicense() {
    if (isActive()) return true;
    activeLicense = null;
    void recheck();
    return false;
  }

  async function clearAndLock() {
    clearInterval(monitorTimer);
    activeLicense = null;
    const result = await send('clear');
    notify('friberg:license-invalidated', result);
    location.reload();
    return result;
  }

  function view() {
    if (!activeLicense) return null;
    return Object.freeze({
      id: activeLicense.id,
      expiresAt: activeLicense.expiresAt,
      expiryText: formatExpiry(activeLicense.expiresAt),
      remainingText: remainingText(),
      deviceCode: activeLicense.deviceCode,
      releaseLabel: config.releaseLabel,
      datasetVersion: config.datasetVersion,
      adapterVersion: config.adapterVersion,
    });
  }

  global.FribergLicenseClient = Object.freeze({
    initializeLicense: requireActiveLicense,
    getLicenseStatus: recheck,
    activateLicense: licenseText => send('activate', { licenseText }),
    clearLicense: clearAndLock,
    requireValidLicense,
    requireActiveLicense,
    getRemainingTime: remainingText,
    isActive,
    current: () => activeLicense,
    view,
    showGate: result => mountGate(result),
    recheck,
  });
}(globalThis));
