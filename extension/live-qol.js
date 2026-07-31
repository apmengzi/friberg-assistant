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
  const WAITING_NEXT_RE = /^(等待反馈|最新反馈待识别|—)$/;

  const state = {
    notificationEnabled: true,
    autoReadyUntil: 0,
    readyClickedFingerprint: '',
    notifiedFingerprint: '',
    lastFoundAt: 0,
    lastVisibleSelfBoard: null,
    lastVisibleGuessCount: null,
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

  function guessCountFromText(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    const match = text.match(/(?:我的猜测|我的竞猜|my guesses?)[^0-9]{0,32}(\d+)\s*\/\s*8\b/i);
    const count = Number(match?.[1]);
    return Number.isInteger(count) && count >= 0 && count <= 8 ? count : null;
  }

  function currentVisibleGuessCount(scan = currentScan()) {
    const board = currentVisibleSelfBoard(scan);
    const inspected = new Set();
    const inspectRoot = root => {
      if (!(root instanceof Element) || inspected.has(root)) return null;
      inspected.add(root);
      const nodes = [
        root,
        ...Array.from(root.querySelectorAll('h1,h2,h3,h4,[class*="title" i],[class*="heading" i]')),
      ];
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        const count = guessCountFromText(node.innerText || node.textContent);
        if (count !== null) return count;
      }
      return null;
    };

    let node = board;
    for (let level = 0; node instanceof Element && level < 7; level += 1, node = node.parentElement) {
      const count = inspectRoot(node);
      if (count !== null) return count;
    }

    const globalNodes = Array.from(document.querySelectorAll('h1,h2,h3,h4,[class*="title" i],[class*="heading" i]'));
    for (const candidate of globalNodes) {
      if (!isVisible(candidate)) continue;
      const count = guessCountFromText(candidate.innerText || candidate.textContent);
      if (count !== null) return count;
    }

    if (!(board instanceof Element)) return null;
    const actualRows = globalThis.FribergLiveDomAdapter.feedbackRows(board).filter(row => {
      const firstCell = row.querySelector('td,th,[role="gridcell"],[role="cell"]') || row.firstElementChild;
      const nickname = String(firstCell?.innerText || firstCell?.textContent || '').replace(/\s+/g, ' ').trim();
      return Boolean(nickname && !/^[•·.\-—]+$/.test(nickname));
    });
    return actualRows.length <= 8 ? actualRows.length : null;
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

  function sendDesktopNotification(title, message, requireInteraction = false, { force = false } = {}) {
    if (!state.notificationEnabled && !force) return Promise.resolve({ ok: false, skipped: true });
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({
          type: 'friberg:desktop-notification',
          title,
          message,
          requireInteraction,
        }, response => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }
          if (!response?.ok) {
            reject(new Error(response?.message || '浏览器后台没有确认通知。'));
            return;
          }
          resolve(response);
        });
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
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

  function monitorVisibleRound() {
    const scan = currentScan();
    const board = currentVisibleSelfBoard(scan);
    const guessCount = currentVisibleGuessCount(scan);
    if (!board) return;

    if (!state.hasSeenSelfBoard) {
      state.hasSeenSelfBoard = true;
      state.lastVisibleSelfBoard = board;
      state.lastVisibleGuessCount = guessCount;
      return;
    }

    const boardChanged = board !== state.lastVisibleSelfBoard;
    const counterReturnedToZero = guessCount === 0
      && state.lastVisibleGuessCount !== null
      && state.lastVisibleGuessCount > 0;

    state.lastVisibleSelfBoard = board;
    state.lastVisibleGuessCount = guessCount;

    if (boardChanged || counterReturnedToZero) {
      forceLiveRebind(boardChanged
        ? '检测到 BO3 新的可见“我的猜测”棋盘；已切换小局并清空旧历史。'
        : '检测到当前小局猜测进度从非零回到 0/8；已清空上一小局历史。');
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
    monitorVisibleRound();
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
      void sendDesktopNotification('弗一把匹配成功', '已经找到对局，请回到浏览器确认准备。', true)
        .then(() => updateOverlayMessage(
          '匹配成功',
          '浏览器已接受桌面通知请求；若系统仍未弹窗，请检查 Windows“通知和操作”及 Edge 通知权限。',
        ))
        .catch(cause => updateOverlayMessage(
          '匹配通知失败',
          '匹配检测本身正常；自动准备不受影响。',
          cause instanceof Error ? cause.message : String(cause),
        ));
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
    void sendDesktopNotification('弗一把已自动准备', '本次匹配的一次性自动准备已执行，请尽快回到电脑。')
      .catch(() => undefined);
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

  function currentRecommendedNickname() {
    const text = document.querySelector('#friberg-assistant-overlay [data-fa-next]')?.textContent?.trim() || '';
    if (!text || WAITING_NEXT_RE.test(text)) return null;
    const nickname = text.split('·')[0].trim();
    return nickname && !WAITING_NEXT_RE.test(nickname) ? nickname : null;
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
      forceLiveRebind('首猜 refrezh 前重新绑定当前可见小局。');
      await sleep(260);
      const scan = currentScan();
      const guessCount = currentVisibleGuessCount(scan);
      if (guessCount !== 0) {
        throw new Error(guessCount === null
          ? '未能读取当前小局的“猜测次数/8”，为避免误提交已停止。'
          : `当前小局猜测进度为 ${guessCount}/8；首猜只能在 0/8 时使用。`);
      }
      updateOverlayMessage('正在首猜 refrezh', '当前小局为 0/8；正在唯一选择 refrezh，随后复用现有网页 CD 排队提交。');
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
      const expectedNickname = currentRecommendedNickname();
      if (!expectedNickname) throw new Error('当前还没有可提交的“下一猜”推荐。');
      const expectedMatches = players.filter(player => normalize(player.nick || player.nickname) === normalize(expectedNickname));
      if (expectedMatches.length !== 1) throw new Error(`无法在题库中唯一确认当前推荐 ${expectedNickname}。`);
      const expectedPlayer = expectedMatches[0];
      let input = currentInput();
      let selected = uniqueInputPlayer(input, players);

      if (!selected || normalize(selected.nick) !== normalize(expectedPlayer.nick)) {
        callbacks.onFillNext?.();
        selected = await waitFor(() => {
          input = currentInput();
          const player = uniqueInputPlayer(input, players);
          return player && normalize(player.nick) === normalize(expectedPlayer.nick) ? player : null;
        });
      }

      if (!selected) throw new Error(`未确认“填入下一猜”已经唯一选中 ${expectedPlayer.nick}，未提交。`);
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
    const guessCount = currentVisibleGuessCount(scan);
    const input = currentInput(scan);
    const refrezh = host.querySelector('[data-fa-qol-action="refrezh-first"]');
    const combined = host.querySelector('[data-fa-qol-action="fill-submit"]');
    const notify = host.querySelector('[data-fa-qol-action="notifications"]');
    const autoReady = host.querySelector('[data-fa-qol-action="auto-ready"]');
    const recommendation = currentRecommendedNickname();

    if (refrezh) {
      refrezh.disabled = state.actionBusy || guessCount !== 0 || !input;
      refrezh.title = guessCount === 0
        ? '当前小局猜测进度为 0/8：填入 refrezh 并复用现有 CD 队列提交一次。'
        : guessCount === null
          ? '未能读取当前小局的猜测进度；请先扫描页面。'
          : `当前小局猜测进度为 ${guessCount}/8；首猜只在 0/8 时可用。`;
    }
    if (combined) {
      combined.disabled = state.actionBusy || !input || !recommendation;
      combined.title = recommendation
        ? `填入并提交当前推荐 ${recommendation}；网页有 CD 时会排队且只提交一次。`
        : '需要插件先读取反馈并生成“下一猜”推荐。';
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

    const find = action => actions.querySelector(`[data-fa-action="${action}"]`);
    const scan = find('scan');
    const board = find('board');
    const diagnostic = find('diagnostic');
    const copyDiagnostic = find('copy-diagnostic');
    const downloadDiagnostic = find('download-diagnostic');
    const copyNext = find('copy-next');
    const fill = find('fill');
    const random = find('random-first');
    const submit = find('submit');
    const localAction = find('local-action');
    const mode = find('mode');
    const pause = find('pause');

    const refrezh = makeButton('refrezh-first', '首猜 refrezh', 'fa-refrezh');
    const combined = makeButton('fill-submit', '填入并提交下一猜', 'fa-combined');
    const notify = makeButton('notifications', '匹配通知：开', 'fa-notify');
    const testNotify = makeButton('test-notification', '测试匹配通知', 'fa-notify-test');
    const autoReady = makeButton('auto-ready', '本次匹配自动准备：关', 'fa-auto-ready');

    [
      scan, board,
      diagnostic, copyDiagnostic,
      downloadDiagnostic, copyNext,
      refrezh, random,
      fill, submit,
      combined,
      notify, testNotify,
      autoReady,
      localAction, mode,
      pause,
    ].filter(Boolean).forEach(element => actions.append(element));

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
      updateOverlayMessage('匹配通知设置已更新', state.notificationEnabled ? '匹配成功时会发送浏览器桌面通知；可点击“测试匹配通知”立即验证。' : '已关闭自动匹配通知；测试按钮仍可用于检查系统通知。');
    });
    testNotify.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      updateOverlayMessage('正在测试匹配通知', '正在请求 Edge/Windows 显示一条测试通知。');
      void sendDesktopNotification('弗一把通知测试', '如果你看到了这条通知，匹配成功通知链路可用。', true, { force: true })
        .then(() => updateOverlayMessage(
          '通知测试已提交',
          '浏览器已接受通知请求；若系统仍未弹窗，请检查 Windows“通知和操作”、专注助手以及 Edge 通知权限。',
        ))
        .catch(cause => updateOverlayMessage(
          '通知测试失败',
          '浏览器后台拒绝了通知请求。',
          cause instanceof Error ? cause.message : String(cause),
        ));
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
