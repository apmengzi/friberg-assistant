(function createFribergOverlay(root) {
  'use strict';

  const ROOT_ID = 'friberg-assistant-overlay';
  const LAYOUT_STORAGE_KEY = 'fribergAssistantOverlayLayoutV1';

  function mount(callbacks = {}) {
    document.getElementById(ROOT_ID)?.remove();
    const host = document.createElement('aside');
    host.id = ROOT_ID;
    host.className = 'friberg-assistant-overlay';
    host.setAttribute('aria-label', '弗一把助手');
    host.innerHTML = `
      <header class="fa-head" data-fa-drag-handle>
        <div class="fa-title"><p class="fa-eyebrow">FRIBERG / LIVE ASSIST</p><h1>弗一把助手</h1></div>
        <div class="fa-window-controls">
          <span class="fa-pool" data-fa-pool>646</span>
          <button type="button" class="fa-window-button" data-fa-window="reset" title="归位" aria-label="将悬浮窗归位">⌖</button>
          <button type="button" class="fa-window-button" data-fa-window="collapse" title="最小化" aria-label="最小化悬浮窗" aria-expanded="true">—</button>
        </div>
      </header>
      <div class="fa-signal"><i></i><i></i><i></i></div>
      <section class="fa-body">
        <p class="fa-status" data-fa-status>等待页面</p>
        <dl class="fa-metrics">
          <div><dt>题库</dt><dd data-fa-pool-metric>646</dd></div>
          <div><dt>监听</dt><dd data-fa-listener>启动中</dd></div>
          <div><dt>当前 URL</dt><dd data-fa-route>—</dd></div>
          <div><dt>自己的棋盘</dt><dd data-fa-board>尚未发现</dd></div>
          <div><dt>搜索框</dt><dd data-fa-search>未发现</dd></div>
          <div><dt>下拉菜单</dt><dd data-fa-dropdown>未发现</dd></div>
          <div><dt>剩余候选</dt><dd data-fa-candidates>646</dd></div>
          <div><dt>模式</dt><dd data-fa-mode>辅助</dd></div>
        </dl>
        <section class="fa-license-summary" data-fa-license-summary hidden>
          <div class="fa-license-title"><strong>离线许可证</strong><span data-fa-license-remaining>—</span></div>
          <dl class="fa-license-metrics">
            <div><dt>许可证</dt><dd data-fa-license-id>—</dd></div>
            <div><dt>到期</dt><dd data-fa-license-expiry>—</dd></div>
            <div><dt>版本</dt><dd data-fa-license-version>—</dd></div>
            <div><dt>题库 / 适配</dt><dd data-fa-license-components>—</dd></div>
          </dl>
          <div class="fa-license-actions">
            <button type="button" data-fa-license-action="recheck">重新检查</button>
            <button type="button" data-fa-license-action="clear">清除许可证</button>
          </div>
        </section>
        <div class="fa-next"><small>立即猜 / 最佳探针</small><strong data-fa-next>等待反馈</strong></div>
        <div class="fa-actions">
          <button type="button" data-fa-action="scan">扫描页面</button>
          <button type="button" data-fa-action="board">选择我的棋盘</button>
          <button type="button" data-fa-action="diagnostic">采集诊断</button>
          <button type="button" data-fa-action="copy-diagnostic">复制诊断</button>
          <button type="button" data-fa-action="download-diagnostic">下载诊断 JSON</button>
          <button type="button" data-fa-action="copy-next">复制下一猜</button>
          <button type="button" class="fa-fill" data-fa-action="fill">填入下一猜</button>
          <button type="button" class="fa-random" data-fa-action="random-first">随机首猜并填入</button>
          <button type="button" class="fa-submit" data-fa-action="submit">提交当前猜测</button>
          <button type="button" class="fa-local-action" data-fa-action="local-action">执行本地推荐</button>
          <button type="button" data-fa-action="mode">切换本地模式</button>
          <button type="button" class="fa-warn" data-fa-action="pause">暂停监听</button>
        </div>
        <p class="fa-detail" data-fa-detail>正在扫描公开页面。</p>
        <p class="fa-error" data-fa-error></p>
        <p class="fa-foot">填入与提交均只响应你的点击；提交前会再次核对选手、搜索框和原网页提交按钮。</p>
      </section>`;
    document.documentElement.append(host);
    const $ = selector => host.querySelector(selector);
    const readableMode = mode => ({ recommend: '辅助', semi: '本地半自动', auto: '本地全自动' })[mode] || mode || '辅助';
    let layout = { x: null, y: null, collapsed: false };
    let drag = null;

    const storage = globalThis.chrome?.storage?.sync;
    const saveLayout = async () => {
      try {
        await storage?.set?.({ [LAYOUT_STORAGE_KEY]: layout });
      } catch { /* layout persistence is optional */ }
    };
    const clampPoint = (x, y) => {
      const width = host.offsetWidth || 210;
      const height = host.offsetHeight || 48;
      return {
        x: Math.max(8, Math.min(Number(x) || 8, Math.max(8, innerWidth - width - 8))),
        y: Math.max(8, Math.min(Number(y) || 8, Math.max(8, innerHeight - height - 8))),
      };
    };
    const placeAt = (x, y) => {
      const point = clampPoint(x, y);
      host.style.left = `${Math.round(point.x)}px`;
      host.style.top = `${Math.round(point.y)}px`;
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      layout = { ...layout, ...point };
    };
    const setCollapsed = (collapsed, persist = true) => {
      layout = { ...layout, collapsed: Boolean(collapsed) };
      host.dataset.collapsed = String(layout.collapsed);
      const button = $('[data-fa-window="collapse"]');
      button.textContent = layout.collapsed ? '□' : '—';
      button.title = layout.collapsed ? '恢复' : '最小化';
      button.setAttribute('aria-label', layout.collapsed ? '恢复悬浮窗' : '最小化悬浮窗');
      button.setAttribute('aria-expanded', String(!layout.collapsed));
      if (layout.x !== null && layout.y !== null) requestAnimationFrame(() => placeAt(layout.x, layout.y));
      if (persist) void saveLayout();
    };
    const resetPosition = (persist = true) => {
      host.style.left = 'auto';
      host.style.top = '16px';
      host.style.right = '16px';
      host.style.bottom = 'auto';
      layout = { ...layout, x: null, y: null };
      if (persist) void saveLayout();
    };
    const restoreLayout = async () => {
      try {
        const saved = await storage?.get?.({ [LAYOUT_STORAGE_KEY]: null });
        const value = saved?.[LAYOUT_STORAGE_KEY];
        if (!value || typeof value !== 'object') return;
        layout = {
          x: Number.isFinite(value.x) ? value.x : null,
          y: Number.isFinite(value.y) ? value.y : null,
          collapsed: Boolean(value.collapsed),
        };
        setCollapsed(layout.collapsed, false);
        if (layout.x !== null && layout.y !== null) requestAnimationFrame(() => placeAt(layout.x, layout.y));
      } catch { /* keep the default top-right layout */ }
    };

    $('[data-fa-drag-handle]').addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const rect = host.getBoundingClientRect();
      drag = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      host.dataset.dragging = 'true';
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    $('[data-fa-drag-handle]').addEventListener('pointermove', event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      placeAt(event.clientX - drag.dx, event.clientY - drag.dy);
    });
    const finishDrag = event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag = null;
      delete host.dataset.dragging;
      void saveLayout();
    };
    $('[data-fa-drag-handle]').addEventListener('pointerup', finishDrag);
    $('[data-fa-drag-handle]').addEventListener('pointercancel', finishDrag);
    addEventListener('resize', () => {
      if (layout.x !== null && layout.y !== null) placeAt(layout.x, layout.y);
    });

    host.addEventListener('click', event => {
      const windowAction = event.target.closest('button')?.dataset.faWindow;
      if (windowAction === 'collapse') {
        setCollapsed(!layout.collapsed);
        return;
      }
      if (windowAction === 'reset') {
        resetPosition();
        return;
      }
      const licenseAction = event.target.closest('button')?.dataset.faLicenseAction;
      if (licenseAction === 'recheck') {
        void globalThis.FribergLicenseClient?.recheck?.().then(() => location.reload());
        return;
      }
      if (licenseAction === 'clear') {
        if (confirm('确定要清除当前许可证吗？设备码会保留。')) {
          void globalThis.FribergLicenseClient?.clearLicense?.();
        }
        return;
      }
      const action = event.target.closest('button')?.dataset.faAction;
      if (!action) return;
      const callback = {
        scan: callbacks.onScan,
        board: callbacks.onChooseBoard,
        diagnostic: callbacks.onDiagnostic,
        'copy-diagnostic': callbacks.onCopyDiagnostic,
        'download-diagnostic': callbacks.onDownloadDiagnostic,
        'copy-next': callbacks.onCopyNext,
        fill: callbacks.onFillNext,
        'random-first': callbacks.onRandomFirst,
        submit: callbacks.onSubmitGuess,
        'local-action': callbacks.onAction,
        mode: callbacks.onMode,
        pause: callbacks.onPause,
      }[action];
      callback?.();
    });
    void restoreLayout();

    return Object.freeze({
      update(view = {}) {
        const pool = view.pool ?? 646;
        $('[data-fa-pool]').textContent = `${pool}`;
        $('[data-fa-pool-metric]').textContent = `${pool}`;
        if (view.status !== undefined) $('[data-fa-status]').textContent = view.status;
        if (view.state !== undefined && view.status === undefined) $('[data-fa-status]').textContent = view.state;
        if (view.listener !== undefined) $('[data-fa-listener]').textContent = view.listener;
        if (view.route !== undefined) $('[data-fa-route]').textContent = view.route;
        if (view.board !== undefined) $('[data-fa-board]').textContent = view.board;
        if (view.search !== undefined) $('[data-fa-search]').textContent = view.search;
        if (view.dropdown !== undefined) $('[data-fa-dropdown]').textContent = view.dropdown;
        if (view.candidates !== undefined) $('[data-fa-candidates]').textContent = view.candidates === null ? '—' : String(view.candidates);
        if (view.mode !== undefined) $('[data-fa-mode]').textContent = readableMode(view.mode);
        if (view.next !== undefined) $('[data-fa-next]').textContent = view.next || '等待反馈';
        if (view.detail !== undefined) $('[data-fa-detail]').textContent = view.detail;
        if (view.error !== undefined) $('[data-fa-error]').textContent = view.error || '';
        if (view.fillEnabled !== undefined) $('[data-fa-action="fill"]').disabled = !view.fillEnabled;
    if (view.randomEnabled !== undefined) $('[data-fa-action="random-first"]').disabled = !view.randomEnabled;
    if (view.randomLabel !== undefined) $('[data-fa-action="random-first"]').textContent = view.randomLabel;
    if (view.randomTitle !== undefined) $('[data-fa-action="random-first"]').title = view.randomTitle;
        if (view.submitEnabled !== undefined) $('[data-fa-action="submit"]').disabled = !view.submitEnabled;
        if (view.submitLabel !== undefined) $('[data-fa-action="submit"]').textContent = view.submitLabel || '提交当前猜测';
        if (view.actionLabel !== undefined) $('[data-fa-action="local-action"]').textContent = view.actionLabel;
        if (view.actionEnabled !== undefined) $('[data-fa-action="local-action"]').disabled = !view.actionEnabled;
        if (view.localModeEnabled !== undefined) $('[data-fa-action="mode"]').disabled = !view.localModeEnabled;
        if (view.paused) host.dataset.paused = 'true'; else delete host.dataset.paused;
        host.dataset.originKind = view.originKind || host.dataset.originKind || 'public';
        const license = globalThis.FribergLicenseClient?.view?.();
        const licenseSection = $('[data-fa-license-summary]');
        if (license) {
          licenseSection.hidden = false;
          $('[data-fa-license-id]').textContent = license.id;
          $('[data-fa-license-expiry]').textContent = license.expiryText;
          $('[data-fa-license-version]').textContent = license.releaseLabel;
          $('[data-fa-license-components]').textContent = `${license.datasetVersion} / ${license.adapterVersion}`;
          $('[data-fa-license-remaining]').textContent = license.remainingText;
        } else {
          licenseSection.hidden = true;
        }
      },
      setCollapsed,
      resetPosition,
      destroy() { host.remove(); },
    });
  }

  root.FribergOverlay = Object.freeze({ mount });
}(globalThis));
