(() => {
  'use strict';

  const Solver = globalThis.GameSolver;
  const Policy = globalThis.FribergUltimatePolicy;
  const Dom = globalThis.FribergUltimateDom;
  const Ui = globalThis.FribergUltimateUi;
  if (!Solver || !Policy || !Dom || !Ui || !globalThis.chrome?.runtime) return;

  const MODES = Object.freeze({
    OFF: 'off',
    ASSIST: 'assist',
    SINGLE_ONCE: 'single-once',
    SINGLE_LOOP: 'single-loop',
    MULTI_SAFE: 'multi-safe',
    MULTI_RACE: 'multi-race',
  });
  const PREF_KEY = 'fribergUltimatePreferencesV1';
  const LOOP_LIMIT_MS = 60 * 60 * 1000;
  const SINGLE_LIMIT_MS = 30 * 60 * 1000;
  const MULTI_LIMIT_MS = 45 * 60 * 1000;
  const MULTI_COOLDOWN_MS = 2_000;
  const COOLDOWN_EARLY_MS = 15;
  const SUBMIT_RETRY_MS = 12;
  const SUBMIT_TIMEOUT_MS = 3_500;
  const MAX_SUBMIT_ATTEMPTS = 180;
  const DRIVE_INTERVAL_MS = 12;

  const state = {
    mode: MODES.OFF,
    armedUntil: 0,
    players: [],
    ready: false,
    route: 'other',
    roundEpoch: 0,
    lastRoundBase: '',
    roundKey: '',
    previousCount: null,
    cooldownReadyAt: 0,
    pendingActionKey: '',
    pendingStartedAt: 0,
    pendingAttemptAt: 0,
    pendingAttempts: 0,
    lastRecommendation: null,
    lastError: '',
    oneShot: false,
    autoReadyFingerprint: '',
    notificationFingerprint: '',
    restartPending: false,
    restartAt: 0,
    completedRoundKey: '',
    observer: null,
    timer: null,
    queued: false,
    driving: false,
    preferences: {
      autoReady: true,
      notifications: true,
      collapseAfterStart: false,
    },
    stats: {
      rounds: 0,
      guesses: 0,
      wins: 0,
      errors: 0,
    },
  };

  const modeLabel = mode => ({
    [MODES.OFF]: '待机（只读）',
    [MODES.ASSIST]: '只推荐',
    [MODES.SINGLE_ONCE]: '单人本局自动',
    [MODES.SINGLE_LOOP]: '单人连续循环',
    [MODES.MULTI_SAFE]: '多人稳健托管',
    [MODES.MULTI_RACE]: '多人竞速托管',
  }[mode] || mode);

  const activeAuto = () => [
    MODES.SINGLE_ONCE,
    MODES.SINGLE_LOOP,
    MODES.MULTI_SAFE,
    MODES.MULTI_RACE,
  ].includes(state.mode);
  const isSingleMode = mode => [MODES.SINGLE_ONCE, MODES.SINGLE_LOOP].includes(mode);
  const isMultiMode = mode => [MODES.MULTI_SAFE, MODES.MULTI_RACE].includes(mode);
  const strategy = () => state.mode === MODES.MULTI_RACE
    ? Policy.strategies.RACE
    : Policy.strategies.SAFE;

  function storageGet(key) {
    return new Promise(resolve => chrome.storage.sync.get(key, result => resolve(result?.[key])));
  }

  function storageSet(key, value) {
    return new Promise(resolve => chrome.storage.sync.set({ [key]: value }, resolve));
  }

  async function loadPreferences() {
    const saved = await storageGet(PREF_KEY).catch(() => null);
    if (saved && typeof saved === 'object') {
      state.preferences = {
        ...state.preferences,
        autoReady: saved.autoReady !== false,
        notifications: saved.notifications !== false,
        collapseAfterStart: Boolean(saved.collapseAfterStart),
      };
    }
  }

  function savePreferences() {
    void storageSet(PREF_KEY, state.preferences).catch(() => undefined);
  }

  function clearPending() {
    state.pendingActionKey = '';
    state.pendingStartedAt = 0;
    state.pendingAttemptAt = 0;
    state.pendingAttempts = 0;
  }

  function clearRoundTracking() {
    state.roundEpoch += 1;
    state.lastRoundBase = '';
    state.roundKey = '';
    state.previousCount = null;
    state.cooldownReadyAt = 0;
    state.completedRoundKey = '';
    state.restartPending = false;
    state.restartAt = 0;
    state.lastRecommendation = null;
    clearPending();
  }

  function compatible(mode, route) {
    if (mode === MODES.OFF || mode === MODES.ASSIST) return route === 'single' || route === 'multi';
    if (isSingleMode(mode)) return route === 'single';
    if (isMultiMode(mode)) return route === 'multi';
    return false;
  }

  function arm(mode) {
    const route = Dom.routeKind();
    if (!compatible(mode, route)) {
      state.lastError = route === 'other'
        ? '请先进入弗一把单人或多人页面。'
        : `当前页面不能开启“${modeLabel(mode)}”。`;
      render({ status: '未开启', detail: state.lastError, error: state.lastError });
      return;
    }
    state.mode = mode;
    state.armedUntil = Date.now() + (mode === MODES.SINGLE_LOOP
      ? LOOP_LIMIT_MS
      : isSingleMode(mode)
        ? SINGLE_LIMIT_MS
        : isMultiMode(mode)
          ? MULTI_LIMIT_MS
          : 0);
    state.lastError = '';
    state.oneShot = false;
    clearRoundTracking();
    if (state.preferences.collapseAfterStart && activeAuto()) Ui.collapse();
    render({
      status: `${modeLabel(mode)}已开启`,
      detail: mode === MODES.SINGLE_LOOP
        ? '自动完成当前局，并在结算后继续“再来一局”；离开页面、超时或异常时停止。'
        : mode === MODES.MULTI_RACE
          ? '固定 refrezh 首猜；CD 内提前计算和预填，CD 到点立即提交下一猜。'
          : '固定 refrezh 首猜，读取可见反馈并自动完成。',
    });
    schedule();
  }

  function stop(reason = '已停止自动操作。', error = '') {
    state.mode = MODES.OFF;
    state.armedUntil = 0;
    state.oneShot = false;
    state.lastError = error;
    clearPending();
    render({ status: '自动化已停止', detail: reason, error });
  }

  function requestOneShot() {
    const route = Dom.routeKind();
    if (route !== 'single' && route !== 'multi') {
      render({ status: '无法提交', detail: '请先进入单人或多人对局。', error: '当前页面没有猜测输入栏。' });
      return;
    }
    state.oneShot = true;
    schedule();
  }

  function statsText() {
    return `本次会话：${state.stats.rounds} 局 · ${state.stats.guesses} 猜 · ${state.stats.wins} 次完成`;
  }

  function render(overrides = {}) {
    const recommendation = state.lastRecommendation;
    Ui.setSnapshot({
      mode: state.mode,
      modeLabel: modeLabel(state.mode),
      route: state.route,
      status: overrides.status || (state.ready ? '等待页面状态' : '正在加载题库'),
      detail: overrides.detail || '',
      next: overrides.next || recommendation?.player?.nick || '—',
      progress: overrides.progress || '进度 —',
      candidates: overrides.candidates || (recommendation ? `候选 ${recommendation.candidateCount}` : '候选 —'),
      strategy: overrides.strategy || `策略 ${recommendation?.strategy === Policy.strategies.RACE ? '竞速' : '稳健'}`,
      error: overrides.error ?? state.lastError,
      stats: statsText(),
      autoReady: state.preferences.autoReady,
      notifications: state.preferences.notifications,
      collapseAfterStart: state.preferences.collapseAfterStart,
      busy: false,
    });
  }

  function sendNotification(title, message) {
    if (!state.preferences.notifications) return;
    void chrome.runtime.sendMessage({
      type: 'friberg:desktop-notification',
      title,
      message,
      requireInteraction: true,
    }).catch(() => undefined);
  }

  function handleReadyCheck() {
    if (state.route !== 'multi') {
      state.autoReadyFingerprint = '';
      state.notificationFingerprint = '';
      return;
    }
    const ready = Dom.readyButton();
    if (!ready) {
      state.autoReadyFingerprint = '';
      state.notificationFingerprint = '';
      return;
    }
    const fingerprint = `${location.href}|${Dom.compact(ready.innerText || ready.textContent)}`;
    if (state.notificationFingerprint !== fingerprint) {
      state.notificationFingerprint = fingerprint;
      sendNotification('弗一把匹配已找到', '准备确认已经出现，点击通知可返回房间。');
    }
    if (isMultiMode(state.mode) && state.preferences.autoReady && state.autoReadyFingerprint !== fingerprint) {
      state.autoReadyFingerprint = fingerprint;
      ready.click();
      render({ status: '已自动准备', detail: '等待双方确认并开始比赛。' });
    }
  }

  function updateRound(count, base) {
    const oldCount = state.previousCount;
    const baseChanged = Boolean(state.lastRoundBase && state.lastRoundBase !== base);
    const reset = Number.isInteger(oldCount) && oldCount > 0 && count === 0;
    if (baseChanged || reset) {
      state.roundEpoch += 1;
      state.completedRoundKey = '';
      state.cooldownReadyAt = 0;
      clearPending();
    }
    if (Number.isInteger(oldCount) && count > oldCount) {
      state.stats.guesses += count - oldCount;
      state.oneShot = false;
      clearPending();
      state.cooldownReadyAt = state.route === 'multi'
        ? performance.now() + MULTI_COOLDOWN_MS - COOLDOWN_EARLY_MS
        : 0;
    }
    if (count === 0) state.cooldownReadyAt = 0;
    state.lastRoundBase = base;
    state.previousCount = count;
    state.roundKey = `${base}|${state.roundEpoch}`;
  }

  function markRoundComplete(won = true) {
    if (!state.roundKey || state.completedRoundKey === state.roundKey) return;
    state.completedRoundKey = state.roundKey;
    state.stats.rounds += 1;
    if (won) state.stats.wins += 1;
  }

  function handleTerminal() {
    if (state.route === 'single' && Dom.terminalSingle()) {
      markRoundComplete(true);
      if (state.mode === MODES.SINGLE_ONCE) {
        stop('单人本局已经结束；按设计停止，没有继续操作下一局。');
        return true;
      }
      if (state.mode === MODES.SINGLE_LOOP) {
        const button = Dom.againButton();
        if (!button) {
          render({ status: '等待下一局按钮', detail: '已经完成本局，但结算区的“再来一局”按钮尚未出现。' });
          return true;
        }
        const now = Date.now();
        if (!state.restartPending) {
          state.restartPending = true;
          state.restartAt = now;
        }
        if (now - state.restartAt >= 250) {
          button.click();
          clearRoundTracking();
          render({ status: '正在开始下一局', detail: '连续循环仍然开启。' });
        }
        return true;
      }
      render({ status: '单人本局已结束', detail: '可查看答案，或开启单人连续循环。' });
      return true;
    }

    if (state.route === 'multi' && Dom.terminalMulti(document.getElementById('friberg-ultimate-panel'))) {
      markRoundComplete(true);
      if (isMultiMode(state.mode)) stop('本场多人比赛已经结束，托管自动关闭。');
      else render({ status: '多人比赛已结束', detail: '本场比赛不再提交猜测。' });
      return true;
    }
    return false;
  }

  function currentContext() {
    const kind = state.route;
    const board = Dom.ownBoard(kind);
    const count = Dom.guessCount(kind, board);
    if (!Number.isInteger(count) || count < 0 || count > 8) {
      return { ok: false, reason: '尚未识别到 0–8 的猜测进度。' };
    }
    const base = Dom.roundToken(kind, document.getElementById('friberg-ultimate-panel'));
    updateRound(count, base);
    if (count >= 8) return { ok: false, terminalProgress: true, count, reason: '本局已用完 8 次猜测。' };

    let parsed = { ok: true, guesses: [], history: [] };
    if (count > 0) {
      parsed = Dom.parseHistory({ board, players: state.players, expectedCount: count });
      if (!parsed.ok) return { ok: false, count, reason: parsed.reason };
    }
    const guessedKeys = new Set(parsed.guesses.map(Solver.playerKey));
    try {
      const recommendation = Policy.recommend({
        players: state.players,
        history: parsed.history,
        guessedKeys,
        remainingGuesses: 8 - count,
        strategy: strategy(),
      });
      return {
        ok: true,
        kind,
        board,
        count,
        parsed,
        guessedKeys,
        recommendation,
        roundKey: state.roundKey,
      };
    } catch (cause) {
      return {
        ok: false,
        count,
        reason: cause instanceof Error ? cause.message : String(cause),
        error: cause,
      };
    }
  }

  function shouldAct() {
    return activeAuto() || state.oneShot;
  }

  function pendingAccepted(actionKey, nickname, count) {
    if (state.pendingActionKey !== actionKey) return false;
    const surface = Dom.inputSurface();
    if (surface && !Dom.compact(surface.input.value)) {
      state.oneShot = false;
      render({
        status: `网页已接受 ${nickname}`,
        detail: `输入框已经由官方组件清空，等待棋盘从 ${count}/8 更新。`,
        progress: `进度 ${count}/8`,
      });
      return true;
    }
    return false;
  }

  function act(context) {
    const nickname = context.recommendation.player.nick;
    const actionKey = `${context.roundKey}|${context.count}|${Solver.normalize(nickname)}`;
    const perfNow = performance.now();

    if (pendingAccepted(actionKey, nickname, context.count)) return;
    if (state.pendingActionKey === actionKey) {
      if (perfNow - state.pendingStartedAt > SUBMIT_TIMEOUT_MS || state.pendingAttempts >= MAX_SUBMIT_ATTEMPTS) {
        state.stats.errors += 1;
        stop(
          '网页长时间没有确认这次猜测。',
          `提交 ${nickname} 已尝试 ${state.pendingAttempts} 次，进度仍是 ${context.count}/8。`,
        );
        return;
      }
      if (perfNow - state.pendingAttemptAt < SUBMIT_RETRY_MS) return;
    }

    const prepared = Dom.prepareExact(nickname);
    if (prepared.status === 'filled') {
      render({
        status: `已预填 ${nickname}`,
        detail: context.kind === 'multi' && context.count > 0
          ? '下一猜已在 2 秒 CD 内提前算好并写入。'
          : '不等待或点击下拉项；等待官方按钮识别准确昵称。',
        progress: `进度 ${context.count}/8`,
      });
      return;
    }
    if (prepared.status === 'waiting-react') {
      render({
        status: `等待网页识别 ${nickname}`,
        detail: '准确昵称已写入；只等待官方 React 提交按钮变为可用。',
        progress: `进度 ${context.count}/8`,
      });
      return;
    }
    if (prepared.status !== 'ready') {
      state.stats.errors += 1;
      state.lastError = `无法准备提交：${prepared.status}`;
      if (activeAuto()) stop('找不到可用的网页猜测表单。', state.lastError);
      else render({ status: '未提交', detail: state.lastError, error: state.lastError });
      return;
    }

    const cooldownLeft = context.kind === 'multi' && context.count > 0
      ? state.cooldownReadyAt - perfNow
      : 0;
    if (cooldownLeft > 0) {
      render({
        status: `已预填 ${nickname}，等待 CD`,
        detail: `约 ${(cooldownLeft / 1000).toFixed(2)} 秒后进入逐帧提交窗口。`,
        progress: `进度 ${context.count}/8`,
      });
      return;
    }

    const submitted = Dom.submitPrepared(prepared.surface);
    if (submitted.status === 'waiting-react') return;
    if (submitted.status !== 'submitted') {
      state.stats.errors += 1;
      state.lastError = `提交表单失败：${submitted.status}`;
      if (activeAuto()) stop('官方表单在提交前失效。', state.lastError);
      else render({ status: '未提交', detail: state.lastError, error: state.lastError });
      return;
    }

    if (state.pendingActionKey !== actionKey) {
      state.pendingActionKey = actionKey;
      state.pendingStartedAt = perfNow;
      state.pendingAttempts = 0;
    }
    state.pendingAttemptAt = perfNow;
    state.pendingAttempts += 1;
    render({
      status: `正在提交 ${nickname}`,
      detail: context.kind === 'multi' && context.count > 0
        ? `已到 CD 边界；第 ${state.pendingAttempts} 次走官方表单，网页接受后立即停止重试。`
        : '已走官方表单，等待可见反馈。',
      progress: `进度 ${context.count}/8`,
    });
  }

  function drive() {
    if (state.driving || !state.ready) return;
    state.driving = true;
    try {
      state.route = Dom.routeKind();
      handleReadyCheck();

      if (activeAuto() && state.armedUntil && Date.now() > state.armedUntil) {
        stop('自动化已达到本次运行时限，防止长时间无人看管。');
        return;
      }
      if (activeAuto() && !compatible(state.mode, state.route)) {
        stop('页面已经离开对应模式，自动化随即停止。');
        return;
      }
      if (handleTerminal()) return;

      if (state.route !== 'single' && state.route !== 'multi') {
        render({ status: '等待进入游戏', detail: '支持单人模式、多人房间和多人匹配。' });
        return;
      }
      if (!Dom.playable(state.route)) {
        render({
          status: state.route === 'multi' ? '等待多人开局' : '等待单人对局加载',
          detail: state.route === 'multi'
            ? '匹配、准备和局间倒计时时不会误提交。'
            : '难度页或新局创建中不会误操作。',
        });
        return;
      }

      const context = currentContext();
      if (!context.ok) {
        if (context.terminalProgress) {
          render({ status: '等待本局结算', detail: context.reason, progress: `进度 ${context.count}/8` });
          return;
        }
        state.lastError = context.reason || '无法读取反馈。';
        render({
          status: '等待完整反馈',
          detail: state.lastError,
          progress: Number.isInteger(context.count) ? `进度 ${context.count}/8` : '进度 —',
          error: activeAuto() ? '' : state.lastError,
        });
        return;
      }

      state.lastError = '';
      state.lastRecommendation = context.recommendation;
      render({
        status: shouldAct() ? '自动求解进行中' : '推荐已更新',
        detail: context.recommendation.note || context.recommendation.reason || '严格候选已更新。',
        next: context.recommendation.player.nick,
        progress: `进度 ${context.count}/8`,
        candidates: `候选 ${context.recommendation.candidateCount}`,
        strategy: `策略 ${context.recommendation.strategy === Policy.strategies.RACE ? '竞速' : '稳健'}${context.recommendation.resolution === 'data-drift' ? ' · 漂移容错' : ''}`,
        error: '',
      });
      if (shouldAct()) act(context);
    } finally {
      state.driving = false;
    }
  }

  function schedule() {
    if (state.queued) return;
    state.queued = true;
    queueMicrotask(() => {
      state.queued = false;
      drive();
      requestAnimationFrame(drive);
    });
  }

  function handleAction(action) {
    switch (action) {
      case 'assist':
        state.mode === MODES.ASSIST ? stop('只推荐模式已关闭。') : arm(MODES.ASSIST);
        break;
      case 'fill-submit':
        requestOneShot();
        break;
      case 'single-once':
        state.mode === MODES.SINGLE_ONCE ? stop() : arm(MODES.SINGLE_ONCE);
        break;
      case 'single-loop':
        state.mode === MODES.SINGLE_LOOP ? stop() : arm(MODES.SINGLE_LOOP);
        break;
      case 'multi-safe':
        state.mode === MODES.MULTI_SAFE ? stop() : arm(MODES.MULTI_SAFE);
        break;
      case 'multi-race':
        state.mode === MODES.MULTI_RACE ? stop() : arm(MODES.MULTI_RACE);
        break;
      case 'stop':
        stop('已按你的点击停止；之后只读页面，不会提交。');
        break;
      case 'toggle-ready':
        state.preferences.autoReady = !state.preferences.autoReady;
        state.autoReadyFingerprint = '';
        savePreferences();
        render({ status: '设置已更新', detail: `多人自动准备已${state.preferences.autoReady ? '开启' : '关闭'}。` });
        break;
      case 'toggle-notify':
        state.preferences.notifications = !state.preferences.notifications;
        state.notificationFingerprint = '';
        savePreferences();
        render({ status: '设置已更新', detail: `匹配桌面通知已${state.preferences.notifications ? '开启' : '关闭'}。` });
        break;
      case 'toggle-collapse-after-start':
        state.preferences.collapseAfterStart = !state.preferences.collapseAfterStart;
        savePreferences();
        render({ status: '设置已更新', detail: `启动自动化后折叠已${state.preferences.collapseAfterStart ? '开启' : '关闭'}。` });
        break;
      default:
        return;
    }
    schedule();
  }

  async function loadPlayers() {
    const response = await fetch(chrome.runtime.getURL('data/game-players-646.json'));
    if (!response.ok) throw new Error(`题库读取失败：${response.status}`);
    const players = Solver.normalizeGamePlayers(await response.json()).filter(player => player.enabled !== false);
    if (players.length !== 646) throw new Error(`题库应有 646 人，实际为 ${players.length}。`);
    Policy.openingPlayer(players);
    state.players = players;
    state.ready = true;
  }

  async function boot() {
    Ui.create();
    state.route = Dom.routeKind();
    render({ status: '正在初始化', detail: '加载 646 人官方题库和稳健/竞速双策略。' });
    document.addEventListener(Ui.actionEvent, event => handleAction(event.detail?.action));
    await loadPreferences();
    await loadPlayers();
    render({ status: '插件已就绪', detail: '默认只读推荐；单人本局、单人循环、多人稳健和多人竞速均可独立开启。' });

    state.observer = new MutationObserver(records => {
      const panel = document.getElementById('friberg-ultimate-panel');
      if (records.every(record => panel?.contains(record.target))) return;
      schedule();
    });
    state.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'disabled', 'aria-disabled', 'aria-selected', 'aria-expanded', 'value'],
    });
    document.addEventListener('input', schedule, true);
    document.addEventListener('submit', schedule, true);
    document.addEventListener('click', schedule, true);
    state.timer = window.setInterval(drive, DRIVE_INTERVAL_MS);
    schedule();
  }

  void boot().catch(cause => {
    state.lastError = cause instanceof Error ? cause.message : String(cause);
    state.stats.errors += 1;
    state.ready = false;
    Ui.create();
    Ui.setSnapshot({
      mode: MODES.OFF,
      modeLabel: '初始化失败',
      route: Dom.routeKind(),
      status: '插件初始化失败',
      detail: '没有执行任何自动操作。',
      error: state.lastError,
      stats: statsText(),
      autoReady: state.preferences.autoReady,
      notifications: state.preferences.notifications,
      collapseAfterStart: state.preferences.collapseAfterStart,
    });
  });
})();
