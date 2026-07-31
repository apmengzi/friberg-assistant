(function bootstrapFribergUltimateUi(root, factory) {
  const api = factory();
  root.FribergUltimateUi = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createUltimateUiApi() {
  'use strict';

  const PANEL_ID = 'friberg-ultimate-panel';
  const ACTION_EVENT = 'friberg:ultimate-action';
  let panel = null;

  function emit(action) {
    document.dispatchEvent(new CustomEvent(ACTION_EVENT, { detail: { action } }));
  }

  function button(action, label, options = {}) {
    const node = document.createElement('button');
    node.type = 'button';
    node.dataset.fuAction = action;
    node.textContent = label;
    if (options.danger) node.dataset.danger = 'true';
    node.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      emit(action);
    });
    return node;
  }

  function create() {
    if (panel?.isConnected) return panel;
    panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.dataset.collapsed = sessionStorage.getItem('fribergUltimateCollapsed') === '1' ? 'true' : 'false';
    panel.innerHTML = `
      <div class="fu-head">
        <span class="fu-title">Friberg Ultimate 1.1</span>
        <span class="fu-mode" data-fu-mode>待机</span>
        <button class="fu-collapse" type="button" aria-label="折叠">⌃</button>
      </div>
      <div class="fu-body">
        <div class="fu-status" data-fu-status>正在初始化</div>
        <div class="fu-detail" data-fu-detail>读取官方题库与页面结构。</div>
        <div class="fu-next">
          下一猜：<strong data-fu-next>—</strong>
          <div class="fu-meta">
            <span data-fu-progress>进度 —</span>
            <span data-fu-candidates>候选 —</span>
            <span data-fu-strategy>策略 —</span>
          </div>
        </div>
        <div class="fu-error" data-fu-error></div>
        <div class="fu-actions" data-fu-actions></div>
        <div class="fu-options" data-fu-options></div>
        <div class="fu-stats" data-fu-stats>本次会话：0 局 · 0 猜</div>
      </div>`;

    const actions = panel.querySelector('[data-fu-actions]');
    actions.append(
      button('assist', '只推荐'),
      button('fill-submit', '填入并提交'),
      button('single-once', '单人本局自动'),
      button('single-loop', '单人连续循环'),
      button('multi-safe', '多人稳健托管'),
      button('multi-race', '多人竞速托管'),
      button('stop', '立即停止', { danger: true }),
    );

    const options = panel.querySelector('[data-fu-options]');
    options.append(
      button('toggle-ready', '自动准备：开'),
      button('toggle-notify', '匹配通知：开'),
      button('toggle-collapse-after-start', '启动后折叠：关'),
    );

    const head = panel.querySelector('.fu-head');
    const collapse = panel.querySelector('.fu-collapse');
    const toggleCollapse = () => {
      const collapsed = panel.dataset.collapsed !== 'true';
      panel.dataset.collapsed = String(collapsed);
      sessionStorage.setItem('fribergUltimateCollapsed', collapsed ? '1' : '0');
      collapse.textContent = collapsed ? '⌄' : '⌃';
    };
    head.addEventListener('click', event => {
      if (event.target.closest('button')) return;
      toggleCollapse();
    });
    collapse.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      toggleCollapse();
    });
    collapse.textContent = panel.dataset.collapsed === 'true' ? '⌄' : '⌃';
    document.documentElement.append(panel);
    return panel;
  }

  function text(selector, value) {
    const node = create().querySelector(selector);
    if (node && node.textContent !== String(value ?? '')) node.textContent = String(value ?? '');
  }

  function setActive(mode) {
    const activeActions = {
      assist: 'assist',
      'single-once': 'single-once',
      'single-loop': 'single-loop',
      'multi-safe': 'multi-safe',
      'multi-race': 'multi-race',
    };
    create().querySelectorAll('[data-fu-action]').forEach(node => {
      node.dataset.active = String(activeActions[mode] === node.dataset.fuAction);
    });
  }

  function setDisabled(route, busy = false) {
    const host = create();
    const single = route === 'single';
    const multi = route === 'multi';
    const map = {
      'single-once': !single,
      'single-loop': !single,
      'multi-safe': !multi,
      'multi-race': !multi,
      'fill-submit': !(single || multi),
      assist: !(single || multi),
    };
    Object.entries(map).forEach(([action, disabled]) => {
      const node = host.querySelector(`[data-fu-action="${action}"]`);
      if (node) node.disabled = Boolean(disabled || busy);
    });
  }

  function setSnapshot(snapshot = {}) {
    create();
    text('[data-fu-mode]', snapshot.modeLabel || '待机');
    text('[data-fu-status]', snapshot.status || '等待页面');
    text('[data-fu-detail]', snapshot.detail || '');
    text('[data-fu-next]', snapshot.next || '—');
    text('[data-fu-progress]', snapshot.progress || '进度 —');
    text('[data-fu-candidates]', snapshot.candidates || '候选 —');
    text('[data-fu-strategy]', snapshot.strategy || '策略 —');
    text('[data-fu-error]', snapshot.error || '');
    text('[data-fu-stats]', snapshot.stats || '本次会话：0 局 · 0 猜');
    setActive(snapshot.mode || 'off');
    setDisabled(snapshot.route || 'other', Boolean(snapshot.busy));

    const ready = panel.querySelector('[data-fu-action="toggle-ready"]');
    const notify = panel.querySelector('[data-fu-action="toggle-notify"]');
    const collapseAfter = panel.querySelector('[data-fu-action="toggle-collapse-after-start"]');
    if (ready) ready.textContent = `自动准备：${snapshot.autoReady === false ? '关' : '开'}`;
    if (notify) notify.textContent = `匹配通知：${snapshot.notifications === false ? '关' : '开'}`;
    if (collapseAfter) collapseAfter.textContent = `启动后折叠：${snapshot.collapseAfterStart ? '开' : '关'}`;
  }

  function collapse() {
    const host = create();
    host.dataset.collapsed = 'true';
    sessionStorage.setItem('fribergUltimateCollapsed', '1');
    const node = host.querySelector('.fu-collapse');
    if (node) node.textContent = '⌄';
  }

  return Object.freeze({
    version: 1,
    actionEvent: ACTION_EVENT,
    create,
    setSnapshot,
    collapse,
  });
}));
