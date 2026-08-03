(() => {
  'use strict';

  const STORAGE_KEY = 'fribergProductionSyncMetaV1';
  const OVERLAY = '#friberg-assistant-overlay';
  let latest = null;

  function compactVersion(value) {
    const text = String(value || '未知');
    return text.length > 12 ? `${text.slice(0, 6)}…${text.slice(-4)}` : text;
  }

  function statusText(meta = latest || {}) {
    const completed = Number(meta.completed) || 0;
    const total = Number(meta.total) || 646;
    const pending = Number.isFinite(Number(meta.pending)) ? Number(meta.pending) : Math.max(0, total - completed);
    const version = compactVersion(meta.siteVersion);
    if (pending === 0 && completed > 0) return `生产题库：已同步 ${completed}/${total} · 版本 ${version}`;
    if (meta.lastError) return `生产题库：${completed}/${total} · 暂停于 ${meta.lastNickname || '未知'} · ${meta.lastError}`;
    return `生产题库：${completed}/${total} · 待同步 ${pending} · 版本 ${version}`;
  }

  function render() {
    const overlay = document.querySelector(OVERLAY);
    const actions = overlay?.querySelector('.fa-actions');
    if (!actions) return false;

    let status = overlay.querySelector('[data-fa-production-sync-status]');
    if (!status) {
      status = document.createElement('div');
      status.dataset.faProductionSyncStatus = 'true';
      status.style.gridColumn = '1 / -1';
      status.style.fontSize = '11px';
      status.style.lineHeight = '1.35';
      status.style.padding = '6px 8px';
      status.style.border = '1px solid rgba(148, 210, 189, .28)';
      status.style.background = 'rgba(12, 41, 48, .55)';
      status.style.wordBreak = 'break-word';
      actions.append(status);
    }
    status.textContent = statusText();
    status.title = '插件会尊重公开查选手接口的限流，约每 6.5 秒同步一名，并在下次打开页面时续传。';

    let button = actions.querySelector('[data-fa-production-sync-action="resume"]');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.dataset.faProductionSyncAction = 'resume';
      button.style.gridColumn = '1 / -1';
      button.textContent = '继续同步生产题库';
      button.title = '从公开“查选手”接口继续低频同步；不会读取隐藏答案。';
      button.addEventListener('click', () => {
        button.disabled = true;
        button.textContent = '生产题库同步运行中…';
        Promise.resolve(globalThis.FribergProductionData?.runGentleSync?.())
          .finally(() => {
            button.disabled = false;
            button.textContent = '继续同步生产题库';
          });
      });
      actions.append(button);
    }
    return true;
  }

  function loadMeta() {
    chrome.storage.local.get([STORAGE_KEY], result => {
      latest = result?.[STORAGE_KEY] || {};
      render();
    });
  }

  document.addEventListener('friberg:production-sync', event => {
    latest = { ...(latest || {}), ...(event.detail || {}) };
    render();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    latest = changes[STORAGE_KEY].newValue || {};
    render();
  });

  const observer = new MutationObserver(() => {
    if (render()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  loadMeta();
})();
