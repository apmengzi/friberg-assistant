(function initFribergLicenseClient(global) {
  'use strict';

  const ROOT_ID = 'friberg-license-gate';
  const config = global.FribergLicenseConfig;
  let activeLicense = null;
  let monitorTimer = 0;

  function send(action, extra = {}) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'friberg-license', action, ...extra }, response => {
        if (chrome.runtime.lastError) {
          resolve({ active: false, code: 'RUNTIME_ERROR', message: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { active: false, code: 'EMPTY_RESPONSE', message: '卡密服务没有响应。' });
      });
    });
  }

  function formatExpiry(seconds) {
    if (!seconds) return '未知';
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(seconds * 1000));
  }

  function removeGate() {
    document.getElementById(ROOT_ID)?.remove();
  }

  function gateStyles() {
    return `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .backdrop {
        position: fixed; inset: 0; z-index: 2147483647;
        display: grid; place-items: center; padding: 24px;
        background: rgba(5, 11, 20, .82);
        color: #edf4ff; font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
        backdrop-filter: blur(7px);
      }
      .pass {
        width: min(560px, 100%); border: 1px solid #34506e;
        background: #0c1725; box-shadow: 0 24px 80px rgba(0,0,0,.55);
      }
      .stripe { height: 7px; background: linear-gradient(90deg, #276fff 0 62%, #ffd84d 62%); }
      .body { padding: 28px; }
      .eyebrow { color: #78a7ff; font: 700 12px/1.3 ui-monospace, Consolas, monospace; letter-spacing: .16em; }
      h1 { margin: 8px 0 4px; color: #fff; font-size: 26px; }
      .sub { margin: 0 0 22px; color: #9fb0c4; font-size: 14px; line-height: 1.7; }
      label { display: block; margin-bottom: 7px; color: #d9e6f7; font-weight: 700; font-size: 13px; }
      .row { display: grid; grid-template-columns: 1fr auto; gap: 10px; }
      input {
        width: 100%; border: 1px solid #3c526d; outline: none;
        background: #07111d; color: #fff; padding: 13px 14px;
        font: 600 14px/1.2 ui-monospace, Consolas, monospace; letter-spacing: .04em;
      }
      input:focus { border-color: #6f9eff; box-shadow: 0 0 0 3px rgba(39,111,255,.18); }
      button {
        min-width: 110px; border: 0; cursor: pointer; padding: 0 18px;
        background: #ffd84d; color: #111b27; font-weight: 800;
      }
      button:disabled { cursor: wait; opacity: .58; }
      .message { min-height: 23px; margin-top: 12px; color: #ff8a83; font-size: 13px; }
      .tiers { display: flex; flex-wrap: wrap; gap: 7px; margin: 10px 0 20px; }
      .tier { border: 1px solid #2c4159; padding: 6px 9px; color: #b9c8da; font: 700 11px/1 ui-monospace, Consolas, monospace; }
      .rules { border-top: 1px solid #25384d; padding-top: 17px; display: grid; gap: 8px; }
      .rule { color: #9fb0c4; font-size: 12px; }
      .rule b { color: #dbe9fb; }
      .active { color: #82e5bf; }
    `;
  }

  function mountGate(initialMessage = '') {
    let host = document.getElementById(ROOT_ID);
    if (host) return host.__licensePromise;
    host = document.createElement('div');
    host.id = ROOT_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = gateStyles();
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    backdrop.innerHTML = `
      <section class="pass" role="dialog" aria-modal="true" aria-labelledby="friberg-license-title">
        <div class="stripe"></div>
        <div class="body">
          <div class="eyebrow">FRIBERG ASSISTANT / ACCESS PASS</div>
          <h1 id="friberg-license-title">激活卡密版</h1>
          <p class="sub">时长从首次成功激活开始计算。卡密绑定当前浏览器设备，到期、撤销或转移到其他设备后将停止运行。</p>
          <label for="friberg-card-key">卡密</label>
          <div class="row">
            <input id="friberg-card-key" autocomplete="off" spellcheck="false" placeholder="FRB-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX">
            <button id="friberg-activate" type="button">验证并进入</button>
          </div>
          <div class="message" id="friberg-message">${initialMessage}</div>
          <div class="tiers">
            <span class="tier">5H</span><span class="tier">12H</span><span class="tier">1D</span>
            <span class="tier">3D</span><span class="tier">7D</span><span class="tier">30D</span>
          </div>
          <div class="rules">
            <div class="rule"><b>单设备授权</b> · 禁止共享、转卖或拆分出租</div>
            <div class="rule"><b>服务端计时</b> · 修改本机时间不能延长有效期</div>
            <div class="rule"><b>不保存明文卡密</b> · 激活后仅保留受限会话</div>
          </div>
        </div>
      </section>`;
    shadow.append(style, backdrop);
    document.documentElement.appendChild(host);

    const input = shadow.getElementById('friberg-card-key');
    const button = shadow.getElementById('friberg-activate');
    const message = shadow.getElementById('friberg-message');
    host.__licensePromise = new Promise(resolve => {
      const activate = async () => {
        const cardKey = input.value.trim();
        if (!cardKey) {
          message.textContent = '请输入卡密。';
          return;
        }
        button.disabled = true;
        message.textContent = '正在连接卡密服务器…';
        const result = await send('activate', { cardKey });
        input.value = '';
        if (!result.active) {
          message.textContent = result.message || '激活失败。';
          button.disabled = false;
          input.focus();
          return;
        }
        activeLicense = result.license;
        message.className = 'message active';
        message.textContent = `${result.license.tierLabel} 已激活，有效至 ${formatExpiry(result.license.expiresAt)}`;
        setTimeout(() => {
          removeGate();
          startMonitor();
          resolve(result);
        }, 550);
      };
      button.addEventListener('click', activate);
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') activate();
      });
    });
    setTimeout(() => input.focus(), 0);
    return host.__licensePromise;
  }

  function startMonitor() {
    clearInterval(monitorTimer);
    monitorTimer = setInterval(async () => {
      const result = await send('status', { force: true });
      if (result.active) {
        activeLicense = result.license;
        return;
      }
      activeLicense = null;
      document.getElementById('friberg-assistant-overlay')?.remove();
      document.getElementById('friberg-scriptcat-assistant')?.remove();
      clearInterval(monitorTimer);
      mountGate(result.message || '许可证已失效，请重新激活。');
    }, Math.max(30000, Number(config.verificationIntervalMs || 120000)));
  }

  async function requireActiveLicense() {
    const result = await send('status');
    if (result.active) {
      activeLicense = result.license;
      startMonitor();
      return result;
    }
    return mountGate(result.message || '');
  }

  global.FribergLicenseClient = Object.freeze({
    requireActiveLicense,
    current: () => activeLicense,
    clear: () => send('clear'),
  });
})(globalThis);
