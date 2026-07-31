(() => {
  'use strict';

  const BaseAdapter = globalThis.FribergLiveDomAdapter;
  const BaseOverlay = globalThis.FribergOverlay;
  const GameSolver = globalThis.GameSolver;
  if (!BaseAdapter || !BaseOverlay || !GameSolver) return;

  const SETTINGS_KEY = 'fribergLiveQolSettingsV2';
  const AUTO_READY_WINDOW_MS = 30 * 60 * 1000;
  const CONTROL_TIMEOUT_MS = 5000;
  const MATCH_POLL_MS = 300;
  const OVERLAY_SELECTOR = '#friberg-assistant-overlay,#friberg-scriptcat-assistant';
  const READY_BUTTON_RE = /^(准备|准备就绪|点击准备|确认准备|接受|接受对局|进入对局|ready|accept|accept match)$/i;
  const MATCH_FOUND_RE = /(匹配成功|找到对局|对局已找到|等待玩家准备|请准备|match found|ready check|match ready)/i;
  const MATCHMAKING_RE = /(正在匹配|匹配中|寻找对手|搜索对局|等待匹配|waiting for match|matchmaking|searching for opponent)/i;
  const WAITING_NEXT_RE = /^(等待反馈|最新反馈待识别|—)$/;

  const state = {
    notificationEnabled: true,
    autoReadyUntil: 0,
    readyClickedFingerprint: '',
    notifiedFingerprint: '',
    lastMatchFoundAt: 0,
    lastBoard: null,
    lastGuessCount: null,
    lastRoundToken: '',
    lastResetKey: '',
    boardIds: new WeakMap(),
    nextBoardId: 1,
    playersPromise: null,
    actionBusy: false,
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
      && Number(style.opacity || 1) !== 0
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
    return scan?.inputCandidates?.find(candidate => isVisible(candidate.element))?.element
      || scan?.inputCandidates?.[0]?.element
      || null;
  }

  function currentVisibleSelfBoard(scan = currentScan()) {
    if (isVisible(scan?.autoBoard?.element)) return scan.autoBoard.element;
    const self = scan?.boardCandidates?.find(candidate => candidate.ownership === 'self' && isVisible(candidate.element));
    return self?.element || null;
  }

  function parseGuessCount(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    const patterns = [
      /(?:我的猜测|我的竞猜)[^0-9]{0,40}(\d+)\s*\/\s*8\b/i,
      /my guesses?[^0-9]{0,40}(\d+)\s*\/\s*8\b/i,
    ];
    for (const pattern of patterns) {
      const count = Number(normalized.match(pattern)?.[1]);
      if (Number.isInteger(count) && count >= 0 && count <= 8) return count;
    }
    return null;
  }

  function currentVisibleGuessCount() {
    const globalCount = parseGuessCount(visiblePageText());
    if (globalCount !== null) return globalCount;
    const board = currentVisibleSelfBoard();
    if (!board) return null;
    let node = board;
    for (let level = 0; node instanceof Element && level < 8; level += 1, node = node.parentElement) {
      const count = parseGuessCount(node.innerText || node.textContent || '');
      if (count !== null) return count;
    }
    const rows = globalThis.FribergLiveDomAdapter.feedbackRows(board).filter(row => {
      const firstCell = row.querySelector('td,th,[role="gridcell"],[role="cell"]') || row.firstElementChild;
      const nickname = String(firstCell?.innerText || firstCell?.textContent || '').replace(/\s+/g, ' ').trim();
      return Boolean(nickname && !/^[•·.\-—]+$/.test(nickname));
    });
    return rows.length <= 8 ? rows.length : null;
  }

  function currentRoundToken() {
    const text = visiblePageText();
    const match = text.match(/第\s*(\d+)\s*局(?:\s*[·•]?\s*先胜\s*(\d+)\s*局)?/);
    if (match) return `round-${match[1]}-first-${match[2] || '?'}`;
    return '';
  }

  function boardKey(board) {
    if (!(board instanceof Element)) return 'no-board';
    if (!state.boardIds.has(board)) state.boardIds.set(board, state.nextBoardId++);
    return `board-${state.boardIds.get(board)}`;
  }

  function forceLiveRebind(reason) {
    dispatchEvent(new CustomEvent('friberg:force-rescan', { detail: { reason } }));
  }

  function patchRouteWatcher() {
    const originalRouteWatcher = BaseAdapter.routeWatcher;
    globalThis.FribergLiveDomAdapter = Object.freeze({
      ...BaseAdapter,
      routeWatcher(onChange) {
        const stopOriginal = originalRouteWatcher(onChange);
        const onForced = event => onChange?.({
          previous: location.href,
          current: location.href,
          route: location.pathname,
          forced: true,
          reason: event.detail?.reason || 'qol-force-rescan',
        });
        addEventListener('friberg:force-rescan', onForced);
        return () => {
          stopOriginal?.();
          removeEventListener('friberg:force-rescan', onForced);
        };
      },
    });
  }

  patchRouteWatcher();

  async function loadSettings() {
    try {
      const saved = await chrome.storage.sync.get({ [SETTINGS_KEY]: { notificationEnabled: true } });
      state.notificationEnabled = saved?.[SETTINGS_KEY]?.notificationEnabled !== false;
    } catch {
      state.notificationEnabled = true;
    }
  }

  async function saveSettings() {
    try {
      await chrome.storage.sync.set({ [SETTINGS_KEY]: { notificationEnabled: state.notificationEnabled } });
    } catch { /* optional */ }
  }

  function updateOverlayMessage(status, detail, error = '') {
    const host = document.querySelector('#friberg-assistant-overlay');
    if (!host) return;
    if (status) host.querySelector('[data-fa-status]')?.replaceChildren(document.createTextNode(status));
    if (detail) host.querySelector('[data-fa-detail]')?.replaceChildren(document.createTextNode(detail));
    const errorNode = host.querySelector('[data-fa-error]');
    if (errorNode) errorNode.textContent = error;
  }

  function sendDesktopNotification(title, message, requireInteraction = false, { force = false } = {}) {
    if (!state.notificationEnabled && !force) return Promise.resolve({ ok: false, skipped: true });
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'friberg:desktop-notification',
        title,
        message,
        requireInteraction,
      }, response => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) return reject(new Error(runtimeError.message));
        if (!response?.ok) return reject(new Error(response?.message || '通知后台未确认。'));
        resolve(response);
      });
    });
  }

  function monitorRound() {
    const board = currentVisibleSelfBoard();
    const guessCount = currentVisibleGuessCount();
    const roundToken = currentRoundToken();
    const identity = `${roundToken || 'round-unknown'}|${boardKey(board)}`;
    const roundChanged = Boolean(state.lastRoundToken && roundToken && state.lastRoundToken !== roundToken);
    const boardChanged = Boolean(state.lastBoard && board && state.lastBoard !== board);
    const counterReturnedToZero = guessCount === 0 && state.lastGuessCount !== null && state.lastGuessCount > 0;
    const firstZeroForIdentity = guessCount === 0 && state.lastResetKey !== identity;

    state.lastBoard = board || state.lastBoard;
    state.lastGuessCount = guessCount;
    if (roundToken) state.lastRoundToken = roundToken;

    if (roundChanged || boardChanged || counterReturnedToZero || firstZeroForIdentity) {
      state.lastResetKey = identity;
      forceLiveRebind(roundChanged
        ? `检测到 ${roundToken}；已按新的小局重置插件历史。`
        : '检测到当前小局处于 0/8 或可见棋盘已切换；已重置插件历史。');
    }
  }

  function matchFingerprint(text, readyButtons) {
    const buttonText = readyButtons.map(button => (button.innerText || button.textContent || '').trim()).join('|');
    return `${location.pathname}|${buttonText}|${text.match(MATCH_FOUND_RE)?.[0] || 'ready-control'}`;
  }

  function autoReadyButtonLabel() {
    if (state.autoReadyUntil <= Date.now()) return '本次匹配自动准备：关';
    const seconds = Math.ceil((state.autoReadyUntil - Date.now()) / 1000);
    return `本次匹配自动准备：开 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function monitorMatchmaking() {
    monitorRound();
    const text = visiblePageText();
    const readyButtons = visibleReadyButtons();
    const matchFound = readyButtons.length === 1 || MATCH_FOUND_RE.test(text);
    const matchmaking = MATCHMAKING_RE.test(text);

    if (!matchFound) {
      if (matchmaking && Date.now() - state.lastMatchFoundAt > 2500) {
        state.notifiedFingerprint = '';
        state.readyClickedFingerprint = '';
      }
      return;
    }

    const fingerprint = matchFingerprint(text, readyButtons);
    state.lastMatchFoundAt = Date.now();
    if (state.notifiedFingerprint !== fingerprint) {
      state.notifiedFingerprint = fingerprint;
      void sendDesktopNotification('弗一把匹配成功', '已经找到对局，请回到浏览器确认准备。', true)
        .then(response => updateOverlayMessage(
          '匹配成功',
          `桌面通知已创建${response.permissionLevel ? `（权限：${response.permissionLevel}）` : ''}；点击通知可切回本标签页。`,
        ))
        .catch(cause => updateOverlayMessage('匹配通知失败', '自动准备检测仍可用；请点击“测试匹配通知”查看具体原因。', cause.message));
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
    void sendDesktopNotification('弗一把已自动准备', '本次匹配的一次性自动准备已执行，请尽快回到电脑。').catch(() => undefined);
    updateOverlayMessage('已自动准备', '仅执行一次，本次自动准备授权已自动关闭。');
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
    const matches = players.filter(player => normalize(player.nick || player.nickname) === normalize(nickname));
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
    const input = currentInput();
    if (!input) throw new Error('没有发现可写入的选手搜索框。');
    const result = await globalThis.FribergLiveDomAdapter.fillAndSelectUniqueOption({
      input,
      player,
      players,
      documentRef: document,
      timeoutMs: 2400,
    });
    if (result.status !== 'selected') throw new Error(result.message || `${label}未能唯一选择下拉项。`);
    return { player, players };
  }

  async function confirmSelectedPlayer(expectedPlayer, players) {
    return waitFor(() => {
      const player = uniqueInputPlayer(currentInput(), players);
      return player && normalize(player.nick) === normalize(expectedPlayer.nick) ? player : null;
    });
  }

  async function runRefrezhFirst(callbacks) {
    if (state.actionBusy) return;
    state.actionBusy = true;
    try {
      const guessCount = currentVisibleGuessCount();
      if (guessCount !== 0) throw new Error(guessCount === null
        ? '未读取到当前小局的“我的猜测 0/8”，为避免误提交已停止。'
        : `当前小局已经使用 ${guessCount}/8 次猜测；首猜只在本小局 0/8 时可用。`);
      forceLiveRebind('首猜 refrezh：按当前小局 0/8 强制重置并重新绑定。');
      await sleep(350);
      const { player, players } = await fillSpecificPlayer('refrezh', '首猜 refrezh');
      if (!await confirmSelectedPlayer(player, players)) throw new Error('填入后未能确认 refrezh 已唯一选中。');
      callbacks.onSubmitGuess?.();
      updateOverlayMessage('已排队首猜 refrezh', '若网页处于提交 CD，插件会等待恢复后只提交一次。');
    } catch (cause) {
      updateOverlayMessage('首猜 refrezh 已停止', '没有执行不确定的提交。', cause.message);
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
      const inputBefore = currentInput();
      const beforeValue = normalize(inputBefore?.value);
      const recommended = currentRecommendedNickname();
      callbacks.onFillNext?.();
      const selected = await waitFor(() => {
        const input = currentInput();
        const player = uniqueInputPlayer(input, players);
        if (!player) return null;
        const changed = normalize(input.value) !== beforeValue;
        const matchesRecommendation = recommended && normalize(player.nick) === normalize(recommended);
        return changed || matchesRecommendation ? player : null;
      });
      if (!selected) throw new Error('“填入下一猜”没有产生可确认的新选手，未提交旧输入。');
      callbacks.onSubmitGuess?.();
      updateOverlayMessage('已填入并排队提交', `${selected.nick} 已唯一选中；网页有 CD 时会等待后只提交一次。`);
    } catch (cause) {
      updateOverlayMessage('填入并提交已停止', '没有提交旧输入或不确定的下拉项。', cause.message);
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
    button.className = className;
    return button;
  }

  function refreshInjectedButtons() {
    const host = document.querySelector('#friberg-assistant-overlay');
    if (!host) return;
    const input = currentInput();
    const guessCount = currentVisibleGuessCount();
    const refrezh = host.querySelector('[data-fa-qol-action="refrezh-first"]');
    const combined = host.querySelector('[data-fa-qol-action="fill-submit"]');
    const notify = host.querySelector('[data-fa-qol-action="notifications"]');
    const autoReady = host.querySelector('[data-fa-qol-action="auto-ready"]');
    const baseFill = host.querySelector('[data-fa-action="fill"]');

    if (refrezh) {
      refrezh.disabled = state.actionBusy || guessCount !== 0 || !input;
      refrezh.title = guessCount === 0
        ? '0/8 表示当前小局尚未使用八次猜测机会中的任何一次；点击后直接填入并提交 refrezh。'
        : guessCount === null
          ? '未读取到当前小局“我的猜测 x/8”，请先点击“扫描页面”。'
          : `当前小局已使用 ${guessCount}/8 次猜测，因此不再是首猜。`;
    }
    if (combined) {
      combined.disabled = state.actionBusy || !input || !baseFill || baseFill.disabled;
      combined.title = combined.disabled
        ? '需要原“填入下一猜”按钮可用，并且已生成下一猜推荐。'
        : '依次执行“填入下一猜”和“提交当前猜测”；网页有 CD 时自动排队且只提交一次。';
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
    const elements = {
      scan: find('scan'), board: find('board'), diagnostic: find('diagnostic'),
      copyDiagnostic: find('copy-diagnostic'), downloadDiagnostic: find('download-diagnostic'),
      copyNext: find('copy-next'), fill: find('fill'), random: find('random-first'),
      submit: find('submit'), localAction: find('local-action'), mode: find('mode'), pause: find('pause'),
    };
    const refrezh = makeButton('refrezh-first', '首猜 refrezh', 'fa-refrezh');
    const combined = makeButton('fill-submit', '填入并提交下一猜', 'fa-combined');
    const notify = makeButton('notifications', '匹配通知：开', 'fa-notify');
    const testNotify = makeButton('test-notification', '测试匹配通知', 'fa-notify-test');
    const autoReady = makeButton('auto-ready', '本次匹配自动准备：关', 'fa-auto-ready');

    [
      elements.scan, elements.board,
      elements.diagnostic, elements.copyDiagnostic,
      elements.downloadDiagnostic, elements.copyNext,
      refrezh, elements.random,
      elements.fill, elements.submit,
      combined,
      notify, testNotify,
      autoReady,
      elements.localAction, elements.mode,
      elements.pause,
    ].filter(Boolean).forEach(element => actions.append(element));

    refrezh.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation(); void runRefrezhFirst(callbacks);
    });
    combined.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation(); void runFillAndSubmit(callbacks);
    });
    notify.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      state.notificationEnabled = !state.notificationEnabled;
      void saveSettings();
      refreshInjectedButtons();
      updateOverlayMessage('匹配通知设置已更新', state.notificationEnabled
        ? '匹配成功时会发送桌面通知；可立即点击“测试匹配通知”。'
        : '已关闭自动匹配通知；测试按钮仍可用于诊断。');
    });
    testNotify.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      updateOverlayMessage('正在测试匹配通知', '正在请求 Edge/Windows 显示测试通知。');
      void sendDesktopNotification('弗一把通知测试', '看到此通知代表通知链路正常。', true, { force: true })
        .then(response => updateOverlayMessage('通知测试成功', `通知已创建；浏览器权限：${response.permissionLevel || '未知'}。`))
        .catch(cause => updateOverlayMessage('通知测试失败', '请根据下方错误检查 Edge 与 Windows 通知设置。', cause.message));
    });
    autoReady.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      if (state.autoReadyUntil > Date.now()) {
        state.autoReadyUntil = 0;
        updateOverlayMessage('本次自动准备已取消', '之后匹配成功只通知，不会点击准备。');
      } else {
        state.autoReadyUntil = Date.now() + AUTO_READY_WINDOW_MS;
        state.readyClickedFingerprint = '';
        updateOverlayMessage('本次匹配自动准备已开启', '30 分钟内只会在唯一确认准备按钮后点击一次。');
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
  state.monitorTimer = setInterval(monitorMatchmaking, MATCH_POLL_MS);
})();
