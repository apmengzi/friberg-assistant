(() => {
  'use strict';

  const BaseAdapter = globalThis.FribergLiveDomAdapter;
  const BaseOverlay = globalThis.FribergOverlay;
  const GameSolver = globalThis.GameSolver;
  if (!BaseAdapter || !BaseOverlay || !GameSolver) return;

  const SETTINGS_KEY = 'fribergLiveQolSettingsV1';
  const AUTO_READY_WINDOW_MS = 30 * 60 * 1000;
  const CONTROL_TIMEOUT_MS = 4200;
  const MATCH_POLL_MS = 350;
  const READY_BUTTON_RE = /^(准备|准备就绪|确认准备|接受|接受对局|进入对局|ready|accept|accept match)$/i;
  const MATCH_FOUND_RE = /(匹配成功|找到对局|对局已找到|等待玩家准备|请准备|match found|ready check|match ready)/i;
  const MATCHMAKING_RE = /(正在匹配|匹配中|寻找对手|搜索对局|等待匹配|waiting for match|matchmaking|searching for opponent)/i;
  const OVERLAY_SELECTOR = '#friberg-assistant-overlay,#friberg-scriptcat-assistant';

  const state = {
    notificationEnabled: true,
    autoReadyUntil: 0,
    readyClickedFingerprint: '',
    notifiedFingerprint: '',
    lastFoundAt: 0,
    lastVisibleSelfBoard: null,
    hasSeenSelfBoard: false,
    playersPromise: null,
    actionBusy: false,
    overlayCallbacks: null,
    uiTimer: null,
    monitorTimer: null,
  };

  const normalize = value => typeof GameSolver.normalize === 'function'
    ? GameSolver.normalize(value)
    : String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function isVisible(element) {
    if (!(element instanceof Element) || element.closest(OVERLAY_SELECTOR)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && rect.width > 0
      && rect.height > 0;
  }

  function visiblePageText() {
    let text = document.body?.innerText || '';
    document.querySelectorAll(OVERLAY_SELECTOR).forEach(element => {
      const own = element.innerText || '';
      if (own) text = text.replace(own, ' ');
    });
    return text.replace(/\s+/g, ' ').trim();
  }

  function visibleReadyButtons() {
    return Array.from(document.querySelectorAll('button,[role="button"]'))
      .filter(isVisible)
      .filter(element => READY_BUTTON_RE.test((element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()));
  }

  function currentScan() {
    try {
      return globalThis.FribergLiveDomAdapter.scan(document);
    } catch {
      return null;
    }
  }

  function currentInput(scan = currentScan()) {
    return scan?.inputCandidates?.[0]?.element || null;
  }

  function currentVisibleSelfBoard(scan = currentScan()) {
    return scan?.autoBoard?.element || null;
  }

  function currentBoardRowCount(scan = currentScan()) {
    const board = currentVisibleSelfBoard(scan);
    return board ? globalThis.FribergLiveDomAdapter.feedbackRows(board).length : null;
  }

  function forceLiveRebind(reason) {
    dispatchEvent(new CustomEvent('friberg:force-rescan', { detail: { reason } }));
  }

  function patchRouteWatcher() {
    const originalRouteWatcher = BaseAdapter.routeWatcher;
    const patched = Object.freeze({
      ...BaseAdapter,
      routeWatcher(onChange) {
        const stopOriginal = originalRouteWatcher(onChange);
        const onForced = event => onChange?.({
          previous: location.href,
          current: location.href,
          route: location.pathname,
          forced: true,
          reason: event.detail?.reason || 'external-visible-board-change',
        });
        addEventListener('friberg:force-rescan', onForced);
        return () => {
          stopOriginal?.();
          removeEventListener('friberg:force-rescan', onForced);
        };
      },
    });
    globalThis.FribergLiveDomAdapter = patched;
  }

  patchRouteWatcher();

  async function loadSettings() {
    try {
      const saved = await chrome.storage.sync.get({
        [SETTINGS_KEY]: { notificationEnabled: true },
      });
      state.notificationEnabled = saved?.[SETTINGS_KEY]?.notificationEnabled !== false;
    } catch {
      state.notificationEnabled = true;
    }
  }

  async function saveSettings() {
    try {
      await chrome.storage.sync.set({
        [SETTINGS_KEY]: { notificationEnabled: state.notificationEnabled },
      });
    } catch { /* settings persistence is optional */ }
  }

  function sendDesktopNotification(title, message, requireInteraction = false) {
    if (!state.notificationEnabled) return;
    try {
      chrome.runtime.sendMessage({
        type: 'friberg:desktop-notification',
        title,
        message,
        requireInteraction,
      });
    } catch { /* the overlay remains the fallback */ }
  }

  function updateOverlayMessage(status, detail, error = '') {
    const host = document.querySelector('#friberg-assistant-overlay');
    if (!host) return;
    const statusNode = host.querySelector('[data-fa-status]');
    const detailNode = host.querySelector('[data-fa-detail]');
    const errorNode = host.querySelector('[data-fa-error]');
    if (statusNode && status) statusNode.textContent = status;
    if (detailNode && detail) detailNode.textContent = detail;
    if (errorNode) errorNode.textContent = error;
  }

  function matchFingerprint(text, readyButtons) {
    const buttonText = readyButtons.map(button => (button.innerText || button.textContent || '').trim()).join('|');
    return `${location.pathname}|${buttonText}|${text.match(MATCH_FOUND_RE)?.[0] || 'ready-control'}`;
  }

  function monitorVisibleBoard() {
    const board = currentVisibleSelfBoard();
    if (!board) return;
    if (!state.hasSeenSelfBoard) {
      state.hasSeenSelfBoard = true;
      state.lastVisibleSelfBoard = board;
      return;
    }
    if (board !== state.lastVisibleSelfBoard) {
      state.lastVisibleSelfBoard = board;
      forceLiveRebind('检测到 BO3 新的可见“我的猜测”棋盘；已切换小局并清空旧历史。');
    }
  }

  function autoReadyButtonLabel() {
    if (state.autoReadyUntil <= Date.now()) return '本次匹配自动准备：关';
    const seconds = Math.max(0, Math.ceil((state.autoReadyUntil - Date.now()) / 1000));
    const minutes = Math.floor(seconds / 60);
    const rest = String(seconds % 60).padStart(2, '0');
    return `本次匹配自动准备：开 ${minutes}:${rest}`;
  }

  function monitorMatchmaking() {
    monitorVisibleBoard();
    const text = visiblePageText();
    const readyButtons = visibleReadyButtons();
    const matchFound = readyButtons.length === 1 || MATCH_FOUND_RE.test(text);
    const matchmaking = MATCHMAKING_RE.test(text);

    if (!matchFound) {
      if (matchmaking && Date.now() - state.lastFoundAt > 2500) {
        state.notifiedFingerprint = '';
        state.readyClickedFingerprint = '';
      }
      return;
    }

    const fingerprint = matchFingerprint(text, readyButtons);
    state.lastFoundAt = Date.now();
    if (state.notifiedFingerprint !== fingerprint) {
      state.notifiedFingerprint = fingerprint;
      sendDesktopNotification('弗一把匹配成功', '已经找到对局，请回到浏览器确认准备。', true);
      updateOverlayMessage('匹配成功', '已发送电脑通知；点击通知可切回当前弗一把标签页。');
    }

    if (state.autoReadyUntil <= Date.now() || state.readyClickedFingerprint === fingerprint) return;
    if (readyButtons.length !== 1) {
      updateOverlayMessage('自动准备未执行', `检测到 ${readyButtons.length} 个准备候选，必须唯一确认才会点击。`);
      return;
    }
    const button = readyButtons[0];
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') return;
    state.readyClickedFingerprint = fingerprint;
    state.autoReadyUntil = 0;
    button.click();
    sendDesktopNotification('弗一把已自动准备', '本次匹配的一次性自动准备已执行，请尽快回到电脑。');
    updateOverlayMessage('已自动准备', '只执行了一次；本次自动准备授权已自动关闭。');
  }

  async function loadPlayers() {
    if (!state.playersPromise) {
      state.playersPromise = fetch(chrome.runtime.getURL('data/game-players-646.json'))
        .then(response => {
          if (!response.ok) throw new Error(`题库读取失败：${response.status}`);
          return response.json();
        })
        .then(raw => typeof GameSolver.normalizeGamePlayers === 'function'
          ? GameSolver.normalizeGamePlayers(raw).filter(player => player.enabled !== false)
          : raw);
    }
    return state.playersPromise;
  }

  async function uniquePlayerByNickname(nickname) {
    const players = await loadPlayers();
    const wanted = normalize(nickname);
    const matches = players.filter(player => normalize(player.nick || player.nickname) === wanted);
    if (matches.length !== 1) throw new Error(`题库中无法唯一确认 ${nickname}（匹配 ${matches.length} 人）。`);
    return { player: matches[0], players };
  }

  function uniqueInputPlayer(input, players) {
    const value = normalize(input?.value);
    if (!value) return null;
    const matches = players.filter(player => normalize(player.nick || player.nickname) === value);
    return matches.length === 1 ? matches[0] : null;
  }

  async function waitFor(predicate, timeoutMs = CONTROL_TIMEOUT_MS, intervalMs = 50) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await sleep(intervalMs);
    }
    return null;
  }

  async function fillSpecificPlayer(nickname, label) {
    const { player, players } = await uniquePlayerByNickname(nickname);
    const scan = currentScan();
    const input = currentInput(scan);
    if (!input) throw new Error('没有发现可写入的选手搜索框。');
    const result = await globalThis.FribergLiveDomAdapter.fillAndSelectUniqueOption({
      input,
      player,
      players,
      documentRef: document,
      timeoutMs: 2200,
    });
    if (result.status !== 'selected') throw new Error(result.message || `${label}未能唯一选择下拉项。`);
    return { player, players, input };
  }

  async function submitAfterSelection(callbacks, expectedPlayer, players) {
    const selected = await waitFor(() => {
      const input = currentInput();
      const player = uniqueInputPlayer(input, players);
      return player && normalize(player.nick) === normalize(expectedPlayer.nick) ? player : null;
    });
    if (!selected) throw new Error('填入后未能确认搜索框中的唯一选手，未提交。');
    callbacks.onSubmitGuess?.();
  }

  async function runRefrezhFirst(callbacks) {
    if (state.actionBusy) return;
    state.actionBusy = true;
    try {
      const scan = currentScan();
      const rows = currentBoardRowCount(scan);
      if (rows !== 0) throw new Error('当前可见小局不是 0/8，已拒绝首猜 refrezh。');
      forceLiveRebind('首猜 refrezh 前重新绑定当前可见小局。');
      await sleep(180);
      updateOverlayMessage('正在首猜 refrezh', '正在唯一选择 refrezh，随后复用现有网页 CD 排队提交。');
      const { player, players } = await fillSpecificPlayer('refrezh', '首猜 refrezh');
      await submitAfterSelection(callbacks, player, players);
    } catch (cause) {
      updateOverlayMessage('首猜 refrezh 已停止', '没有执行不确定的提交。', cause instanceof Error ? cause.message : String(cause));
    } finally {
      state.actionBusy = false;
      refreshInjectedButtons();
    }
  }

  async function runFillAndSubmit(callbacks) {
    if (state.actionBusy) return;
    state.actionBusy = true;
    try {
      const players = await loadPlayers();
      const beforeInput = currentInput();
      const beforeValue = normalize(beforeInput?.value);
      callbacks.onFillNext?.();
      const selected = await waitFor(() => {
        const host = document.querySelector('#friberg-assistant-overlay');
        const status = host?.querySelector('[data-fa-status]')?.textContent || '';
        const input = currentInput();
        const player = uniqueInputPlayer(input, players);
        if (!player || !/已选中，等待提交/.test(status)) return null;
        if (beforeValue && normalize(player.nick) === beforeValue) return null;
        return player;
      });
      if (!selected) throw new Error('未确认“填入下一猜”已经选中了新的唯一选手，未提交。');
      callbacks.onSubmitGuess?.();
    } catch (cause) {
      updateOverlayMessage('填入并提交已停止', '没有提交旧输入或不确定的下拉项。', cause instanceof Error ? cause.message : String(cause));
    } finally {
      state.actionBusy = false;
      refreshInjectedButtons();
    }
  }

  function makeButton(action, text, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.faQolAction = action;
    button.textContent = text;
    if (className) button.className = className;
    return button;
  }

  function refreshInjectedButtons() {
    const host = document.querySelector('#friberg-assistant-overlay');
    if (!host) return;
    const scan = currentScan();
    const rows = currentBoardRowCount(scan);
    const input = currentInput(scan);
    const refrezh = host.querySelector('[data-fa-qol-action="refrezh-first"]');
    const combined = host.querySelector('[data-fa-qol-action="fill-submit"]');
    const notify = host.querySelector('[data-fa-qol-action="notifications"]');
    const autoReady = host.querySelector('[data-fa-qol-action="auto-ready"]');
    const fill = host.querySelector('[data-fa-action="fill"]');
    if (refrezh) {
      refrezh.disabled = state.actionBusy || rows !== 0 || !input;
      refrezh.title = rows === 0 ? '填入 refrezh 并复用现有 CD 队列提交一次。' : '仅在当前可见小局 0/8 时可用。';
    }
    if (combined) {
      combined.disabled = state.actionBusy || !fill || fill.disabled;
      combined.title = '先执行现有“填入下一猜”，确认新选手后再进入现有提交/CD队列。';
    }
    if (notify) notify.textContent = `匹配通知：${state.notificationEnabled ? '开' : '关'}`;
    if (autoReady) {
      if (state.autoReadyUntil <= Date.now()) state.autoReadyUntil = 0;
      autoReady.textContent = autoReadyButtonLabel();
      autoReady.dataset.armed = String(state.autoReadyUntil > Date.now());
    }
  }

  function injectControls(callbacks) {
    const host = document.querySelector('#friberg-assistant-overlay');
    const actions = host?.querySelector('.fa-actions');
    if (!actions || actions.querySelector('[data-fa-qol-action]')) return;

    const random = actions.querySelector('[data-fa-action="random-first"]');
    const fill = actions.querySelector('[data-fa-action="fill"]');
    const pause = actions.querySelector('[data-fa-action="pause"]');
    const refrezh = makeButton('refrezh-first', '首猜 refrezh', 'fa-refrezh');
    const combined = makeButton('fill-submit', '填入并提交下一猜', 'fa-combined');
    const notify = makeButton('notifications', '匹配通知：开', 'fa-notify');
    const autoReady = makeButton('auto-ready', '本次匹配自动准备：关', 'fa-auto-ready');

    if (random) actions.insertBefore(refrezh, random);
    else actions.append(refrezh);
    if (fill?.nextSibling) actions.insertBefore(combined, fill.nextSibling);
    else actions.append(combined);
    if (pause) {
      actions.insertBefore(notify, pause);
      actions.insertBefore(autoReady, pause);
    } else {
      actions.append(notify, autoReady);
    }

    refrezh.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      void runRefrezhFirst(callbacks);
    });
    combined.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      void runFillAndSubmit(callbacks);
    });
    notify.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      state.notificationEnabled = !state.notificationEnabled;
      void saveSettings();
      refreshInjectedButtons();
      updateOverlayMessage('匹配通知设置已更新', state.notificationEnabled ? '匹配成功时会发送浏览器桌面通知。' : '已关闭匹配成功桌面通知。');
    });
    autoReady.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (state.autoReadyUntil > Date.now()) {
        state.autoReadyUntil = 0;
        updateOverlayMessage('本次自动准备已取消', '之后匹配成功只通知，不会点击准备。');
      } else {
        state.autoReadyUntil = Date.now() + AUTO_READY_WINDOW_MS;
        state.readyClickedFingerprint = '';
        updateOverlayMessage('本次匹配自动准备已开启', '30 分钟内找到对局时，仅在唯一确认准备按钮后点击一次；之后自动关闭。');
      }
      refreshInjectedButtons();
    });
    refreshInjectedButtons();
  }

  function patchOverlay() {
    const originalMount = BaseOverlay.mount;
    globalThis.FribergOverlay = Object.freeze({
      ...BaseOverlay,
      mount(callbacks = {}) {
        state.overlayCallbacks = callbacks;
        const api = originalMount(callbacks);
        queueMicrotask(() => injectControls(callbacks));
        clearInterval(state.uiTimer);
        state.uiTimer = setInterval(refreshInjectedButtons, 300);
        return api;
      },
    });
  }

  patchOverlay();
  void loadSettings().then(refreshInjectedButtons);
  clearInterval(state.monitorTimer);
  state.monitorTimer = setInterval(monitorMatchmaking, MATCH_POLL_MS);
})();
