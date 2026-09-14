(() => {
  'use strict';

  const { GameSolver, FribergAutomation, FribergOverlay, FribergLiveDomAdapter } = globalThis;
  if (!GameSolver || !FribergAutomation || !FribergOverlay || !FribergLiveDomAdapter) return;

  const state = {
    players: [],
    matrix: null,
    privateOrigins: [],
    policy: null,
    adapter: null,
    session: null,
    mode: FribergAutomation.MODES.RECOMMEND,
    roundId: null,
    seenRows: new Set(),
    rowQueue: Promise.resolve(),
    autoRunning: false,
    busy: false,
    matrixLatency: null,
    overlay: null,
    live: null,
  };

  const modeLabel = mode => ({ recommend: '推荐', semi: '半自动', auto: '全自动' })[mode] || mode;
  const playerId = player => GameSolver.playerKey(player);
  const isTerminalState = value => ['won', 'lost'].includes(value);
  const licenseAllowsCore = () => !globalThis.FribergLicenseClient
    || globalThis.FribergLicenseClient.requireValidLicense();
  // The deployed client currently enforces a 2,000 ms guess interval before it
  // emits game:guess. Keep a small safety margin and also read its visible
  // countdown so an early assistant click is queued instead of swallowed.
  const SUBMIT_COOLDOWN_MS = 2100;
  const SUBMIT_RETRY_INTERVAL_MS = 100;
  const SUBMIT_QUEUE_TIMEOUT_MS = 10000;
  const SUBMIT_FEEDBACK_TIMEOUT_MS = 6000;
  // This exact opt-in exists solely for the repository's local browser
  // fixture. It neither broadens the production manifest nor changes the
  // public-origin policy used on shnlfriberg.online.
  const isLocalLiveFixture = () => location.hostname === '127.0.0.1'
    && document.documentElement.dataset.fribergLiveFixture === 'true';
  const isLiveAssistSurface = () => state.policy?.kind === 'public' || isLocalLiveFixture();

  function getMirrorAdapter() {
    const root = document.querySelector('[data-friberg-app="mirror"][data-friberg-automation="authorized"]');
    if (!root) return null;
    const input = root.querySelector('[data-friberg-guess-input]');
    const dropdown = root.querySelector('[data-friberg-option]')?.parentElement || root.querySelector('#playerDropdown');
    const submit = root.querySelector('[data-friberg-submit]');
    const board = root.querySelector('[data-friberg-board="self"]');
    const consent = root.querySelector('#automationConsent');
    if (!input || !dropdown || !submit || !board || !consent) return null;
    return Object.freeze({ root, input, dropdown, submit, board, consent, type: 'localMirror' });
  }

  function readRowFeedback(row) {
    const cell = field => row.querySelector(`[data-friberg-field="${field}"]`);
    const color = field => cell(field)?.dataset.fribergColor;
    const direction = field => cell(field)?.dataset.fribergDirection || 'none';
    return {
      team: color('team'),
      country: color('country'),
      age: { color: color('age'), direction: direction('age') },
      role: color('role'),
      majorWins: { color: color('majorWins'), direction: direction('majorWins') },
      majorAppearances: { color: color('majorApps'), direction: direction('majorApps') },
      status: color('status'),
    };
  }

  function roundIdFor(row) {
    const full = row.dataset.fribergRowId || '';
    return full.split(':')[0] || state.adapter?.root?.dataset?.fribergRoundId || `visible-${Date.now()}`;
  }

  function setNativeInputValue(element, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('本地镜像输入框不可写。');
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function recommendationText() {
    const recommendation = state.session?.lastRecommendation;
    if (!recommendation) return '—';
    return `${recommendation.player.nick} · ${recommendation.purpose === 'probe' ? '探针' : '直接猜'}`;
  }

  function updateOverlay(detail) {
    const recommendation = state.session?.lastRecommendation;
    const actionCapable = FribergAutomation.canPerformPageAction(
      state.policy,
      state.mode,
      Boolean(state.adapter && state.adapter.type === 'localMirror'),
    );
    const hasConsent = Boolean(state.adapter?.consent?.checked);
    const roundPlaying = state.adapter?.root?.dataset?.roundStatus === 'playing';
    const actionEnabled = Boolean(actionCapable && hasConsent && roundPlaying && recommendation && !state.busy && !isTerminalState(state.session?.state));
    const actionLabel = state.mode === FribergAutomation.MODES.AUTO ? '启动全自动' : '提交推荐';
    const baseDetail = detail || (state.policy.kind === 'public'
      ? '公开站点没有已审计的 DOM 合约：此扩展不会读取、填写或提交。'
      : !state.adapter
        ? '未找到已授权的本地镜像合约，因此不会进行页面操作。'
        : !hasConsent
          ? '勾选页面内的“授权本地测试”后，才可执行推荐。'
          : recommendation
            ? `最坏分区 ${recommendation.worstGroup}；期望剩余 ${recommendation.expectedRemaining.toFixed(2)}。`
            : '等待可见反馈。');
    state.overlay?.update({
      mode: state.mode,
      state: state.session?.state || '只读',
      candidates: state.session ? GameSolver.filterCandidates(state.players, state.session.history, state.session.guessedKeys).length : null,
      next: recommendationText(),
      latency: state.matrixLatency,
      detail: baseDetail,
      actionLabel,
      actionEnabled,
      paused: state.session?.state === FribergAutomation.STATES.PAUSED,
    });
  }

  function createSession(roundId) {
    state.session = new FribergAutomation.AssistantSession({
      players: state.players,
      matrix: state.matrix,
      origin: location.origin,
      privateOrigins: state.privateOrigins,
      mode: state.mode,
    });
    state.roundId = roundId;
    state.seenRows.clear();
    state.session.startRound(roundId);
    return state.session;
  }

  function synchronizeRound() {
    const currentRoundId = state.adapter?.root?.dataset?.fribergRoundId;
    if (!currentRoundId || state.roundId === currentRoundId) return;
    createSession(currentRoundId);
    state.adapter.board.querySelectorAll('[data-friberg-feedback-row]').forEach(scheduleVisibleRow);
  }

  function stopWithError(cause) {
    state.autoRunning = false;
    state.busy = false;
    try {
      if (state.session && !isTerminalState(state.session.state) && state.session.state !== FribergAutomation.STATES.PAUSED) state.session.pause(cause.message);
    } catch { /* keep the original error visible */ }
    updateOverlay(`已暂停：${cause.message}`);
  }

  function processVisibleRow(row) {
    if (!licenseAllowsCore()) return;
    const rowId = row.dataset.fribergRowId;
    if (!rowId || state.seenRows.has(rowId)) return;
    const roundId = roundIdFor(row);
    if (!state.session || state.roundId !== roundId) createSession(roundId);
    if (state.session.state === FribergAutomation.STATES.PAUSED) return;

    const guess = state.players.find(player => playerId(player) === row.dataset.fribergPlayerId);
    if (!guess) throw new Error('可见反馈行没有匹配题库 playerId。');
    const roundStatus = state.adapter.root.dataset.roundStatus;
    const visibleRows = Array.from(state.adapter.board.querySelectorAll('[data-friberg-feedback-row]'));
    const isLatestVisibleRow = visibleRows[visibleRows.length - 1] === row;
    const options = {
      won: isLatestVisibleRow && roundStatus === 'won',
      lost: isLatestVisibleRow && roundStatus === 'lost',
      maxGuesses: 8,
    };
    const response = state.session.state === FribergAutomation.STATES.WAITING_FOR_FEEDBACK
      ? state.session.recordVisibleFeedback(guess, readRowFeedback(row), options)
      : state.session.recordObservedVisibleFeedback(guess, readRowFeedback(row), options);
    state.seenRows.add(rowId);
    state.busy = false;

    if (response.won || response.lost) {
      state.autoRunning = false;
      updateOverlay(response.won ? '本地回合已胜利。' : '本地回合结束。');
      return;
    }
    updateOverlay();
    if (state.autoRunning && state.mode === FribergAutomation.MODES.AUTO) queueMicrotask(() => performRecommendedAction(true));
  }

  function scheduleVisibleRow(row) {
    state.rowQueue = state.rowQueue
      .then(() => processVisibleRow(row))
      .catch(stopWithError);
  }

  function observeVisibleRows() {
    const observer = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches('[data-friberg-feedback-row]')) scheduleVisibleRow(node);
          node.querySelectorAll?.('[data-friberg-feedback-row]').forEach(scheduleVisibleRow);
        }
      }
    });
    observer.observe(state.adapter.board, { childList: true, subtree: true });
    state.adapter.board.querySelectorAll('[data-friberg-feedback-row]').forEach(scheduleVisibleRow);
  }

  function performRecommendedAction(automatic = false) {
    if (!licenseAllowsCore()) return;
    if (!state.session || !state.adapter || state.busy) return;
    synchronizeRound();
    const recommendation = state.session.lastRecommendation;
    const actionAllowed = FribergAutomation.canPerformPageAction(state.policy, state.mode, state.adapter.type === 'localMirror');
    if (!actionAllowed || !recommendation) return;
    if (!state.adapter.consent.checked) {
      updateOverlay('请先在本地镜像中勾选“我确认这是授权的本地测试”。');
      return;
    }
    if (automatic) state.autoRunning = true;
    state.busy = true;
    try {
      state.session.beginPageAction(true);
      setNativeInputValue(state.adapter.input, recommendation.player.nick);
      const option = Array.from(state.adapter.dropdown.querySelectorAll('[data-friberg-option]'))
        .find(item => item.dataset.playerId === playerId(recommendation.player));
      if (!option) throw new Error('已授权镜像未给出对应 playerId 的下拉选项。');
      option.click();
      if (state.adapter.submit.disabled) throw new Error('镜像拒绝提交：选择状态未就绪。');
      state.adapter.submit.click();
      updateOverlay(`已${automatic ? '自动' : ''}提交 ${recommendation.player.nick}，等待可见反馈。`);
    } catch (cause) {
      stopWithError(cause);
    }
  }

  function cycleMode() {
    if (!state.policy || state.policy.allowedModes.length < 2) return;
    const allowed = state.policy.allowedModes;
    const next = allowed[(allowed.indexOf(state.mode) + 1) % allowed.length];
    state.autoRunning = false;
    state.mode = next;
    if (state.session) {
      if (state.session.state === FribergAutomation.STATES.PAUSED) {
        state.session = null;
        state.roundId = null;
        state.seenRows.clear();
        const firstRow = state.adapter?.board?.querySelector('[data-friberg-feedback-row]');
        createSession(firstRow ? roundIdFor(firstRow) : state.adapter?.root?.dataset?.fribergRoundId || `mirror-${Date.now()}`);
        state.adapter?.board?.querySelectorAll('[data-friberg-feedback-row]').forEach(scheduleVisibleRow);
      } else {
        state.session.setMode(next);
      }
    }
    updateOverlay(`已切换为${modeLabel(next)}模式。`);
  }

  function pause() {
    state.autoRunning = false;
    try {
      if (state.session && !isTerminalState(state.session.state) && state.session.state !== FribergAutomation.STATES.PAUSED) state.session.pause('USER_PAUSED');
    } catch { /* UI pause remains idempotent */ }
    updateOverlay('已暂停；切换模式可按当前可见棋盘重新同步。');
  }

  async function loadPlayersAndMatrix() {
    const response = await fetch(chrome.runtime.getURL('data/game-players-646.json'));
    if (!response.ok) throw new Error(`题库读取失败：${response.status}`);
    state.players = GameSolver.normalizeGamePlayers(await response.json()).filter(player => player.enabled !== false);
    const started = performance.now();
    state.matrix = FribergAutomation.buildFeedbackMatrix(state.players);
    state.matrixLatency = Math.round(performance.now() - started);
  }

  function pushLiveError(cause) {
    const live = state.live;
    if (!live) return;
    const message = cause instanceof Error ? cause.message : String(cause);
    live.errors.push(message);
    if (live.errors.length > 20) live.errors.shift();
    live.error = message;
  }

  function liveRecommendationText() {
    if (state.live?.feedbackPaused) return '最新反馈待识别';
    const recommendation = state.live?.session?.lastRecommendation;
    if (!recommendation) return '等待反馈';
    const drift = state.live.session.lastResolution?.mode === 'data-drift' ? ' · 数据漂移恢复' : '';
    return `${recommendation.player.nick} · ${recommendation.purpose === 'probe' ? '最佳探针' : '立即猜'}${drift}`;
  }

  function liveCandidateCount() {
    const live = state.live;
    if (!live?.session) return state.players.length;
    return live.session.lastCandidates?.length ?? null;
  }

  function uniqueLivePlayerForText(value) {
    const wanted = GameSolver.normalize(value);
    if (!wanted) return null;
    const matches = state.players.filter(player => GameSolver.normalize(player.nick) === wanted);
    return matches.length === 1 ? matches[0] : null;
  }

  function visiblePageGuessCooldownMs() {
    const text = document.body?.innerText || '';
    const patterns = [
      /猜测间隔[：:\s]*还需等待\s*([\d.]+)\s*秒/i,
      /guess cooldown[：:\s]*([\d.]+)\s*s(?:econds?)?\s*remaining/i,
      /次の予想まで\s*([\d.]+)\s*秒/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      const seconds = Number(match?.[1]);
      if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
    }
    return 0;
  }

  function visibleRoundMarker() {
    const text = document.body?.innerText || '';
    const match = text.match(/第\s*(\d+)\s*局(?:\s*[·•]\s*先胜\s*(\d+)\s*局)?/);
    return match ? `round-${match[1]}-first-${match[2] || '?'}` : null;
  }

  function visibleBoardGuessCount(board) {
    if (!(board instanceof Element)) return null;
    let node = board;
    for (let level = 0; node instanceof Element && level < 6; level += 1, node = node.parentElement) {
      const structures = node.querySelectorAll('table,[role="grid"],.game-table');
      if (level > 0 && structures.length > 1) break;
      const headings = Array.from(node.querySelectorAll('h1,h2,h3,h4,[class*="title" i],[class*="heading" i]'));
      const ownHeading = headings.find(element => /我的猜测|my guesses?/i.test(element.textContent || ''));
      if (!ownHeading) continue;
      const match = (ownHeading.textContent || '').match(/(\d+)\s*\/\s*8\b/);
      const count = Number(match?.[1]);
      if (Number.isInteger(count) && count >= 0 && count <= 8) return count;
    }
    return null;
  }

  function updateLiveOverlay(detail) {
    const live = state.live;
    if (!live || !state.overlay) return;
    const scan = live.scan;
    const input = scan?.inputCandidates?.[0];
    const dropdown = scan?.dropdownCandidates?.[0];
    const recommendation = live.session?.lastRecommendation;
    const inputPlayer = uniqueLivePlayerForText(input?.element?.value);
    const submitCandidate = input?.element
      ? FribergLiveDomAdapter.uniqueSubmitButton({ scanResult: scan, input: input.element, documentRef: document })
      : null;
    const submitButtonFound = submitCandidate?.status === 'unique';
    const firstGuessAvailable = (live.session?.history.length || 0) === 0
      && !isTerminalState(live.session?.state);
    const randomEnabled = Boolean(
      live.listening
      && !live.feedbackPaused
      && input
      && firstGuessAvailable
      && !live.submissionInFlight,
    );
    const randomBlockedReason = randomEnabled
      ? ''
      : !live.listening
        ? '监听已暂停'
        : live.feedbackPaused
          ? '等待换局重置'
          : !input
            ? '未发现输入框'
            : live.submissionInFlight
              ? '等待上一猜反馈'
              : isTerminalState(live.session?.state)
                ? '等待下一小局'
                : '本局已有反馈';
    const status = live.status || '等待对局';
    state.overlay.update({
      originKind: 'public',
      pool: state.players.length || 646,
      status,
      listener: live.listening ? '运行中' : '已暂停',
      route: location.href,
      board: live.activeBoard ? '已绑定自己的棋盘' : '尚未发现',
      search: input ? '已发现' : '未发现',
      dropdown: dropdown ? '已发现' : '未发现',
      candidates: liveCandidateCount(),
      mode: 'recommend',
      next: liveRecommendationText(),
      detail: detail || live.detail || (live.activeBoard
        ? '正在只读取自己的可见反馈；页面尚未渲染完整时会自动重试。'
        : '等待对局。出现棋盘后会自动重新扫描；也可以手动选择自己的棋盘。'),
      error: live.error || '',
      fillEnabled: Boolean(live.listening && !live.feedbackPaused && live.activeBoard && input && recommendation),
      randomEnabled,
      randomLabel: randomEnabled ? '随机首猜并填入' : `随机首猜（${randomBlockedReason}）`,
      randomTitle: randomEnabled ? '随机选择一名尚未猜过的选手并填入原网页。' : randomBlockedReason,
      submitEnabled: Boolean(
        live.listening
        && !live.feedbackPaused
        && inputPlayer
        && submitButtonFound
        && !live.submissionInFlight
        && !live.submitQueue,
      ),
      submitLabel: live.submitQueue ? '等待网页 CD…' : '提交当前猜测',
      actionEnabled: false,
      actionLabel: '执行本地推荐',
      localModeEnabled: false,
      paused: !live.listening,
    });
  }

  function playerForLiveNickname(nickname) {
    const normalized = GameSolver.normalize(nickname);
    const matches = state.players.filter(player => GameSolver.normalize(player.nick) === normalized);
    if (matches.length !== 1) {
      throw new Error(matches.length
        ? `昵称“${nickname}”在 646 人题库中不唯一，未读取该行。`
        : `题库中没有昵称“${nickname}”，未读取该行。`);
    }
    return matches[0];
  }

  function createLiveSession(reason, { resetSubmitCooldown = false } = {}) {
    const live = state.live;
    const previousSubmitAt = live.lastSubmitAt || 0;
    clearLiveSubmitQueue();
    clearLiveSubmissionWatchdog();
    live.session = new FribergAutomation.AssistantSession({
      players: state.players,
      matrix: state.matrix,
      origin: location.origin,
      mode: FribergAutomation.MODES.RECOMMEND,
      dataDriftMaxScore: 1,
    });
    live.session.startRound(`live-${Date.now()}`);
    live.processedRows = new WeakSet();
    live.processedFingerprints = new Set();
    live.feedbackPaused = false;
    live.pendingFeedback = null;
    live.lastFill = null;
    live.lastFilledPlayer = null;
    live.lastSubmit = null;
    live.submissionInFlight = false;
    live.lastSubmitAt = resetSubmitCooldown ? 0 : previousSubmitAt;
    live.lastObservedRowCount = 0;
    live.lastBoardGuessCount = visibleBoardGuessCount(live.activeBoard);
    live.lastFeedbackAt = 0;
    live.roundMarker = visibleRoundMarker() || live.roundMarker || null;
    live.error = '';
    live.detail = reason;
  }

  function synchronizeLiveFeedback() {
    const live = state.live;
    if (!licenseAllowsCore()) return;
    if (!live?.activeBoard || !live.session || !live.listening) return;
    const marker = visibleRoundMarker();
    const markerChanged = Boolean(marker && live.roundMarker && marker !== live.roundMarker);
    if (marker) live.roundMarker = marker;
    let rows = FribergLiveDomAdapter.feedbackRows(live.activeBoard);
    const fingerprints = rows.map(row => FribergLiveDomAdapter.feedbackRowFingerprint(row));
    const boardGuessCount = visibleBoardGuessCount(live.activeBoard);
    const terminal = isTerminalState(live.session.state);
    const hadRoundEvidence = Boolean(
      live.session.history.length
      || live.processedFingerprints.size
      || live.feedbackPaused
      || live.pendingFeedback
      || terminal,
    );
    const boardCleared = rows.length === 0 && hadRoundEvidence;
    const rowCountRewound = rows.length < (live.lastObservedRowCount || 0);
    const guessCountRewound = boardGuessCount !== null
      && live.lastBoardGuessCount !== null
      && boardGuessCount < live.lastBoardGuessCount;
    const counterReturnedToZero = boardGuessCount === 0 && hadRoundEvidence;
    const allRowsReplacedAfterTerminal = terminal
      && rows.length > 0
      && fingerprints.every(fingerprint => !live.processedFingerprints.has(fingerprint));
    if (markerChanged || boardCleared || rowCountRewound || guessCountRewound || counterReturnedToZero || allRowsReplacedAfterTerminal) {
      createLiveSession(
        markerChanged
          ? `检测到 ${marker}；已清除上一小局状态并开放随机首猜。`
          : '检测到棋盘已进入新一小局；已清除上一局状态并开放随机首猜。',
        { resetSubmitCooldown: true },
      );
      rows = FribergLiveDomAdapter.feedbackRows(live.activeBoard);
      if (!rows.length) {
        updateLiveOverlay();
        return;
      }
    }
    live.lastObservedRowCount = rows.length;
    live.lastBoardGuessCount = visibleBoardGuessCount(live.activeBoard);
    live.feedbackPaused = false;
    live.pendingFeedback = null;
    for (const row of rows) {
      const fingerprint = FribergLiveDomAdapter.feedbackRowFingerprint(row);
      if (live.processedRows.has(row) || live.processedFingerprints.has(fingerprint)) continue;
      const parsed = FribergLiveDomAdapter.readFeedbackRow(row);
      if (!parsed.valid) {
        live.feedbackPaused = true;
        live.pendingFeedback = { fingerprint, errors: parsed.errors.slice() };
        live.status = '最新反馈尚未识别';
        live.error = parsed.errors.join(' ');
        live.detail = '监听没有停止：正在等待该行 DOM 渲染完整并自动重试。若持续不恢复，请采集诊断。';
        updateLiveOverlay();
        return;
      }
      try {
        const baseGuess = playerForLiveNickname(parsed.nickname);
        const visibleGuess = FribergAutomation.guessFromVisibleReading(baseGuess, parsed.reading, state.players);
        const result = live.session.recordObservedVisibleFeedback(visibleGuess, parsed.reading, { maxGuesses: 8 });
        live.processedRows.add(row);
        live.processedFingerprints.add(fingerprint);
        live.lastFill = null;
        live.lastFilledPlayer = null;
        clearLiveSubmitQueue();
        clearLiveSubmissionWatchdog();
        live.submissionInFlight = false;
        live.lastFeedbackAt = Date.now();
        live.lastObservedRowCount = rows.length;
        live.lastBoardGuessCount = visibleBoardGuessCount(live.activeBoard);
        live.feedbackPaused = false;
        live.pendingFeedback = null;
        live.status = result.won ? '本局胜利' : result.lost ? '本局结束' : '已读取自己的新反馈';
        live.error = '';
        const driftConflict = result.dataDrift?.conflicts
          ?.find(conflict => conflict.playerKey === GameSolver.playerKey(result.recommendation?.player));
        live.detail = result.won || result.lost
          ? '页面状态需要人工核对；插件未读取隐藏答案。'
          : result.dataDrift
            ? `严格候选归零；按资料稳定性加权恢复 ${result.candidates.length} 名候选。当前推荐 ${result.recommendation.player.nick}，疑似漂移：${driftConflict?.fields.join('、') || '待核对'}。`
          : `已合并 ${live.session.history.length} 次可见猜测；剩余 ${liveCandidateCount()} 名候选。`;
      } catch (cause) {
        pushLiveError(cause);
        live.feedbackPaused = true;
        live.pendingFeedback = { fingerprint, errors: [cause instanceof Error ? cause.message : String(cause)] };
        live.status = '最新反馈尚未识别';
        live.detail = '已保留此前全部历史；监听会在页面变化或手动扫描时重试这一行。';
        updateLiveOverlay();
        return;
      }
    }
    updateLiveOverlay();
  }

  function bindLiveBoard(candidate, source) {
    const live = state.live;
    if (!live || !candidate?.element) return;
    live.boardObserver?.disconnect();
    live.activeBoard = candidate.element;
    live.activeCandidate = candidate;
    FribergLiveDomAdapter.clearMarks();
    createLiveSession(source === 'automatic'
      ? '已通过“我的猜测”标签自动绑定自己的棋盘。'
      : '已按你的点击绑定自己的棋盘。');
    live.boardObserver = new MutationObserver(records => {
      const meaningful = records.filter(record => !record.target.closest?.('#friberg-assistant-overlay,#friberg-scriptcat-assistant'));
      FribergLiveDomAdapter.appendMutations(live.recentMutations, meaningful);
      synchronizeLiveFeedback();
      queueLiveScan();
    });
    live.boardObserver.observe(live.activeBoard, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'data-feedback', 'data-state', 'aria-label'],
    });
    live.status = '已发现自己的棋盘';
    synchronizeLiveFeedback();
  }

  function resetLiveBinding(reason) {
    const live = state.live;
    if (!live) return;
    clearLiveSubmitQueue();
    clearLiveSubmissionWatchdog();
    live.boardObserver?.disconnect();
    live.boardObserver = null;
    live.activeBoard = null;
    live.activeCandidate = null;
    live.session = null;
    live.processedRows = new WeakSet();
    live.processedFingerprints = new Set();
    live.lastFill = null;
    live.lastFilledPlayer = null;
    live.lastSubmit = null;
    live.submissionInFlight = false;
    live.lastSubmitAt = 0;
    live.lastObservedRowCount = 0;
    live.lastBoardGuessCount = null;
    live.lastFeedbackAt = 0;
    live.roundMarker = null;
    FribergLiveDomAdapter.clearMarks();
    if (reason) {
      live.status = '等待对局';
      live.detail = reason;
    }
  }

  function scanLivePage(reason) {
    const live = state.live;
    if (!live || !live.listening) return;
    try {
      live.scan = FribergLiveDomAdapter.scan(document);
      if (live.activeBoard && !document.documentElement.contains(live.activeBoard)) resetLiveBinding('先前绑定的棋盘已从页面移除，正在重新扫描。');
      if (!live.activeBoard && live.scan.autoBoard) bindLiveBoard(live.scan.autoBoard, 'automatic');
      if (!live.activeBoard) {
        live.status = '等待对局';
        const selectableBoards = live.scan.boardCandidates.filter(candidate => candidate.ownership !== 'opponent');
        if (selectableBoards.length > 1) FribergLiveDomAdapter.markBoardCandidates(selectableBoards);
        live.detail = reason || (selectableBoards.length > 1
          ? '发现多个可能棋盘；请点击“选择我的棋盘”，再点击有边框的自己的棋盘。'
          : '尚未发现可确认的自己的猜测棋盘；监听仍在运行。');
      } else {
        synchronizeLiveFeedback();
      }
      updateLiveOverlay();
    } catch (cause) {
      pushLiveError(cause);
      live.status = '页面扫描失败';
      live.detail = '请点击“采集诊断”导出当前页面结构。';
      updateLiveOverlay();
    }
  }

  function queueLiveScan(reason) {
    const live = state.live;
    if (!live || live.scanTimer || !live.listening) return;
    live.scanTimer = setTimeout(() => {
      live.scanTimer = null;
      scanLivePage(reason);
    }, 120);
  }

  function startLiveHealthMonitor() {
    const live = state.live;
    if (!live) return;
    clearInterval(live.healthTimer);
    live.healthTimer = setInterval(() => {
      const current = state.live;
      if (!current?.listening) return;
      try {
        const marker = visibleRoundMarker();
        const count = visibleBoardGuessCount(current.activeBoard);
        const markerChanged = Boolean(marker && current.roundMarker && marker !== current.roundMarker);
        const countRewound = count !== null
          && current.lastBoardGuessCount !== null
          && count < current.lastBoardGuessCount;
        const staleAtFreshBoard = count === 0 && Boolean(
          current.feedbackPaused
          || current.pendingFeedback
          || current.session?.history.length
          || current.processedFingerprints.size
          || isTerminalState(current.session?.state),
        );
        if (current.activeBoard && current.session && (markerChanged || countRewound || staleAtFreshBoard)) {
          synchronizeLiveFeedback();
          current.scan = FribergLiveDomAdapter.scan(document);
          updateLiveOverlay();
          return;
        }
        const input = current.scan?.inputCandidates?.[0]?.element;
        if (!current.activeBoard || !input?.isConnected || current.feedbackPaused) {
          queueLiveScan('状态巡检发现页面已变化，正在重新同步。');
        }
      } catch (cause) {
        pushLiveError(cause);
      }
    }, 350);
  }

  function stopLiveBoardCapture() {
    const live = state.live;
    if (!live?.choosingBoard) return;
    live.choosingBoard = false;
    document.removeEventListener('click', captureLiveBoardClick, true);
    FribergLiveDomAdapter.clearMarks();
  }

  function captureLiveBoardClick(event) {
    const live = state.live;
    if (!live?.choosingBoard) return;
    if (event.target.closest?.('#friberg-assistant-overlay,#friberg-scriptcat-assistant')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const candidate = FribergLiveDomAdapter.findBoardForTarget(event.target, live.scan);
    stopLiveBoardCapture();
    if (!candidate) {
      live.status = '未选择到棋盘';
      live.error = '被点击区域不符合八字段棋盘结构。请点击结果表或其表头。';
      updateLiveOverlay();
      return;
    }
    if (candidate.ownership === 'opponent') {
      live.status = '已拒绝对方棋盘';
      live.error = '该棋盘带有对方标记或 masked-cell，只允许绑定“我的猜测”。';
      updateLiveOverlay();
      return;
    }
    bindLiveBoard(candidate, 'manual');
  }

  function beginLiveBoardCapture() {
    const live = state.live;
    if (!live) return;
    if (!live.scan) scanLivePage();
    const candidates = live.scan?.boardCandidates || [];
    const selectableBoards = candidates.filter(candidate => candidate.ownership !== 'opponent');
    if (!selectableBoards.length) {
      live.status = '等待对局';
      live.error = '当前页面还没有可选择的猜测棋盘。';
      updateLiveOverlay();
      return;
    }
    stopLiveBoardCapture();
    live.choosingBoard = true;
    FribergLiveDomAdapter.markBoardCandidates(selectableBoards, live.activeBoard);
    live.status = '请选择自己的棋盘';
    live.detail = '可能棋盘已加临时边框；点击自己的表格区域即可绑定。本次点击不会触发游戏操作。';
    document.addEventListener('click', captureLiveBoardClick, true);
    updateLiveOverlay();
  }

  function copyText(value) {
    if (!value) return Promise.resolve(false);
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value).then(() => true).catch(() => false);
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.documentElement.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return Promise.resolve(copied);
  }

  function diagnosticTimestamp() {
    return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  }

  function collectLiveDiagnostic() {
    const live = state.live;
    if (!live) return null;
    live.scan = FribergLiveDomAdapter.scan(document);
    live.lastDiagnostic = FribergLiveDomAdapter.diagnostic({
      scanResult: live.scan,
      activeBoard: live.activeBoard,
      recentMutations: live.recentMutations,
      errors: live.errors,
      extensionVersion: FribergLiveDomAdapter.VERSION,
      gamePoolSize: state.players.length || 646,
      adapterState: {
        listening: live.listening,
        choosingBoard: live.choosingBoard,
        activeBoardSource: live.activeCandidate?.selfEvidence ? 'automatic-self-label' : live.activeBoard ? 'manual' : null,
        activeBoardOwnership: live.activeCandidate?.ownership || null,
        feedbackRowsObserved: live.session?.history.length || 0,
        pendingFeedback: live.pendingFeedback || null,
        lastFill: live.lastFill || null,
        lastSubmit: live.lastSubmit || null,
        submitQueued: live.submitQueue ? {
          nickname: live.submitQueue.nickname,
          createdAt: live.submitQueue.createdAt,
          deadline: live.submitQueue.deadline,
        } : null,
      },
    });
    return live.lastDiagnostic;
  }

  function diagnoseLivePage() {
    const live = state.live;
    const report = collectLiveDiagnostic();
    if (!report || !live) return;
    live.status = '诊断已采集';
    live.detail = `已记录 ${report.candidateBoards.length} 个候选棋盘、${report.candidateInputs.length} 个输入框和 ${report.candidateButtons.length} 个按钮。`;
    live.error = '';
    updateLiveOverlay();
  }

  function copyLiveDiagnostic() {
    const live = state.live;
    const report = collectLiveDiagnostic();
    if (!live || !report) return;
    void copyText(JSON.stringify(report, null, 2)).then(ok => {
      live.status = ok ? '诊断已复制' : '复制诊断失败';
      live.detail = ok ? '可直接把完整 JSON 粘贴到此任务。' : '请改用“下载诊断 JSON”。';
      updateLiveOverlay();
    });
  }

  function downloadLiveDiagnostic() {
    const live = state.live;
    const report = collectLiveDiagnostic();
    if (!live || !report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `friberg-diagnostic-${diagnosticTimestamp()}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    live.status = '诊断已下载';
    live.detail = '文件已脱敏：不含 Cookie、Token、浏览器存储、房间密码或聊天内容。';
    updateLiveOverlay();
  }

  function copyLiveRecommendation() {
    const live = state.live;
    const nickname = live?.session?.lastRecommendation?.player?.nick;
    if (!live || !nickname) return;
    void copyText(nickname).then(ok => {
      live.status = ok ? '下一猜已复制' : '复制下一猜失败';
      live.detail = nickname;
      updateLiveOverlay();
    });
  }

  async function fillLivePlayer(player, sourceLabel) {
    if (!licenseAllowsCore()) return;
    const live = state.live;
    if (live) live.scan = FribergLiveDomAdapter.scan(document);
    const input = live?.scan?.inputCandidates?.[0]?.element;
    if (!live || live.feedbackPaused || !input || !player || live.submissionInFlight) {
      if (live) {
        live.status = '无法填入选手';
        live.error = live.feedbackPaused
          ? '最新反馈尚未识别；监听仍会自动重试，也可点击“扫描页面”。'
          : live.submissionInFlight
            ? '上一猜已经提交，正在等待反馈行。'
            : '需要可用选手和已发现的搜索框。';
        updateLiveOverlay();
      }
      return;
    }
    live.status = sourceLabel === '随机首猜' ? '正在生成随机首猜' : '正在填入下一猜';
    live.error = '';
    live.detail = `正在寻找 ${player.nick} 的唯一候选；选中后仍需点击“提交当前猜测”。`;
    updateLiveOverlay();
    try {
      const result = await FribergLiveDomAdapter.fillAndSelectUniqueOption({ input, player, players: state.players, documentRef: document });
      live.lastFill = result;
      live.lastFilledPlayer = result.status === 'selected' ? player : null;
      live.lastSubmit = null;
      live.status = result.status === 'selected'
        ? `${sourceLabel || '下一猜'}已选中，等待提交`
        : '未自动选择下拉项';
      live.detail = result.message || '下拉项未能唯一确认，已停止。';
      live.error = result.status === 'selected' ? '' : result.message || '';
    } catch (cause) {
      pushLiveError(cause);
      live.status = '填入已停止';
      live.detail = '请检查搜索框和下拉候选后，再采集诊断。';
    }
    updateLiveOverlay();
  }

  function fillLiveRecommendation() {
    const live = state.live;
    const player = live?.session?.lastRecommendation?.player;
    if (!live?.activeBoard || !player) {
      if (live) {
        live.status = '无法填入下一猜';
        live.error = '需要已绑定自己的棋盘并产生下一猜推荐。';
        updateLiveOverlay();
      }
      return;
    }
    void fillLivePlayer(player, '下一猜');
  }

  function fillRandomFirstGuess() {
    const live = state.live;
    if (!live) return;
    if ((live.session?.history.length || 0) > 0) {
      live.status = '随机首猜已停用';
      live.error = '本局已有反馈；请使用求解器给出的“填入下一猜”。';
      updateLiveOverlay();
      return;
    }
    const player = FribergAutomation.pickRandomPlayer({
      players: state.players,
      guessedKeys: live.session?.guessedKeys || new Set(),
    });
    if (!player) {
      live.status = '没有可用的随机首猜';
      live.error = '题库中没有尚未猜过的启用选手。';
      updateLiveOverlay();
      return;
    }
    void fillLivePlayer(player, '随机首猜');
  }

  function clearLiveSubmitQueue() {
    const live = state.live;
    if (!live) return;
    clearTimeout(live.submitQueueTimer);
    live.submitQueueTimer = null;
    live.submitQueue = null;
  }

  function clearLiveSubmissionWatchdog() {
    const live = state.live;
    if (!live) return;
    clearTimeout(live.submissionWatchdogTimer);
    live.submissionWatchdogTimer = null;
  }

  function beginLiveSubmissionWatchdog(player) {
    const live = state.live;
    if (!live) return;
    clearLiveSubmissionWatchdog();
    live.submissionWatchdogTimer = setTimeout(() => {
      if (!state.live || !state.live.submissionInFlight) return;
      state.live.submissionInFlight = false;
      state.live.lastSubmit = {
        status: 'feedback-timeout',
        submitted: false,
        player: player.nick,
        message: '提交后未检测到新的反馈行。',
      };
      state.live.status = '提交后未收到反馈';
      state.live.detail = '原网页可能吞掉了冷却期间的点击；按钮已恢复，可确认输入框后再次提交。';
      state.live.error = '';
      state.live.scan = FribergLiveDomAdapter.scan(document);
      updateLiveOverlay();
    }, SUBMIT_FEEDBACK_TIMEOUT_MS);
  }

  function scheduleLiveSubmitRetry(delay = SUBMIT_RETRY_INTERVAL_MS) {
    const live = state.live;
    if (!live?.submitQueue || live.submitQueueTimer) return;
    live.submitQueueTimer = setTimeout(() => {
      if (!state.live) return;
      state.live.submitQueueTimer = null;
      attemptQueuedLiveSubmit();
    }, Math.max(20, delay));
  }

  function stopQueuedLiveSubmit(result, detail) {
    const live = state.live;
    if (!live) return;
    clearLiveSubmitQueue();
    live.lastSubmit = result;
    live.status = '提交已停止';
    live.detail = detail || '没有点击原网页按钮；请确认搜索框内容后重试。';
    live.error = result?.message || '提交前校验失败。';
    updateLiveOverlay();
  }

  function attemptQueuedLiveSubmit() {
    const live = state.live;
    const queued = live?.submitQueue;
    if (!live || !queued || live.submissionInFlight) return;
    if (!live.listening || live.feedbackPaused || Date.now() >= queued.deadline) {
      stopQueuedLiveSubmit(
        { status: 'queue-timeout', submitted: false, message: '等待网页提交冷却超时。' },
        '网页提交按钮在 10 秒内没有恢复；本次没有点击原网页按钮。',
      );
      return;
    }

    live.scan = FribergLiveDomAdapter.scan(document);
    const input = live.scan.inputCandidates?.[0]?.element;
    const player = uniqueLivePlayerForText(input?.value);
    if (!player || GameSolver.playerKey(player) !== queued.playerKey) {
      stopQueuedLiveSubmit(
        { status: 'mismatch', submitted: false, message: '等待期间搜索框内容发生变化。' },
        '已取消排队提交，没有点击原网页按钮。',
      );
      return;
    }

    const localCooldownRemaining = live.lastSubmitAt + SUBMIT_COOLDOWN_MS - Date.now();
    const pageCooldownRemaining = visiblePageGuessCooldownMs();
    const cooldownRemaining = Math.max(localCooldownRemaining, pageCooldownRemaining);
    if (cooldownRemaining > 0) {
      live.status = '等待网页提交冷却';
      live.detail = `已排队 ${player.nick}；约 ${Math.max(0.1, Math.ceil(cooldownRemaining / 100) / 10)} 秒后自动提交，无需再次点击。`;
      live.error = '';
      scheduleLiveSubmitRetry(Math.min(250, Math.max(SUBMIT_RETRY_INTERVAL_MS, cooldownRemaining)));
      updateLiveOverlay();
      return;
    }

    const result = FribergLiveDomAdapter.submitSelectedGuess({
      input,
      player,
      scanResult: live.scan,
      documentRef: document,
    });
    live.lastSubmit = result;
    if (result.status === 'submitted') {
      clearLiveSubmitQueue();
      live.submissionInFlight = true;
      live.lastSubmitAt = Date.now();
      live.status = '猜测已提交';
      live.detail = result.message;
      live.error = '';
      beginLiveSubmissionWatchdog(player);
      updateLiveOverlay();
      return;
    }

    if (['disabled', 'missing'].includes(result.status)) {
      live.status = '等待网页提交冷却';
      live.detail = `已排队 ${player.nick}；原网页按钮恢复后会自动提交，无需再次点击。`;
      live.error = '';
      scheduleLiveSubmitRetry();
      updateLiveOverlay();
      return;
    }

    stopQueuedLiveSubmit(result);
  }

  function submitCurrentLiveGuess() {
    if (!licenseAllowsCore()) return;
    const live = state.live;
    if (!live || live.submissionInFlight || live.submitQueue) return;
    live.scan = FribergLiveDomAdapter.scan(document);
    const input = live.scan.inputCandidates?.[0]?.element;
    const player = uniqueLivePlayerForText(input?.value);
    if (!input || !player) {
      stopQueuedLiveSubmit(
        { status: 'error', submitted: false, message: '搜索框中不是题库内唯一选手昵称。' },
        '没有点击原网页按钮；请先填入或选择一个唯一选手。',
      );
      return;
    }
    live.submitQueue = {
      playerKey: GameSolver.playerKey(player),
      nickname: player.nick,
      createdAt: Date.now(),
      deadline: Date.now() + SUBMIT_QUEUE_TIMEOUT_MS,
    };
    live.status = '正在检查网页提交冷却';
    live.detail = `已排队 ${player.nick}；满足冷却条件后自动提交一次。`;
    live.error = '';
    updateLiveOverlay();
    attemptQueuedLiveSubmit();
  }

  function pauseLiveListening() {
    const live = state.live;
    if (!live) return;
    clearLiveSubmitQueue();
    clearLiveSubmissionWatchdog();
    clearInterval(live.healthTimer);
    live.healthTimer = null;
    stopLiveBoardCapture();
    live.listening = false;
    live.pageObserver?.disconnect();
    live.boardObserver?.disconnect();
    live.routeStop?.();
    live.inputStop?.();
    live.inputStop = null;
    live.status = '监听已暂停';
    live.detail = '点击“扫描页面”可重新启动当前页面的监听。';
    updateLiveOverlay();
  }

  function startLiveAssistant() {
    if (!licenseAllowsCore()) return;
    state.live?.pageObserver?.disconnect();
    state.live?.boardObserver?.disconnect();
    state.live?.routeStop?.();
    state.live?.inputStop?.();
    clearInterval(state.live?.healthTimer);
    clearLiveSubmitQueue();
    clearLiveSubmissionWatchdog();
    state.live = {
      listening: true,
      status: '等待对局',
      detail: '正在监听 /multi 与 /multi/room；没有棋盘时不会停止。',
      error: '',
      scan: null,
      activeBoard: null,
      activeCandidate: null,
      session: null,
      recentMutations: [],
      errors: [],
      processedRows: new WeakSet(),
      processedFingerprints: new Set(),
      feedbackPaused: false,
      pendingFeedback: null,
      scanTimer: null,
      choosingBoard: false,
      lastDiagnostic: null,
      lastFill: null,
      lastFilledPlayer: null,
      lastSubmit: null,
      submissionInFlight: false,
      lastSubmitAt: 0,
      lastObservedRowCount: 0,
      lastBoardGuessCount: null,
      lastFeedbackAt: 0,
      roundMarker: visibleRoundMarker(),
      submitQueue: null,
      submitQueueTimer: null,
      submissionWatchdogTimer: null,
      pageObserver: null,
      boardObserver: null,
      routeStop: null,
      inputStop: null,
      healthTimer: null,
    };
    const handleLiveInput = event => {
      if (!state.live?.listening || event.target.closest?.('#friberg-assistant-overlay,#friberg-scriptcat-assistant')) return;
      if (state.live.submitQueue) {
        const player = uniqueLivePlayerForText(event.target?.value);
        if (!player || GameSolver.playerKey(player) !== state.live.submitQueue.playerKey) {
          clearLiveSubmitQueue();
          state.live.status = '已取消排队提交';
          state.live.detail = '搜索框内容发生变化，本次没有点击原网页按钮。';
          state.live.error = '';
        }
      }
      queueMicrotask(updateLiveOverlay);
    };
    document.addEventListener('input', handleLiveInput, true);
    state.live.inputStop = () => document.removeEventListener('input', handleLiveInput, true);
    state.live.pageObserver = new MutationObserver(records => {
      const meaningful = records.filter(record => !record.target.closest?.('#friberg-assistant-overlay,#friberg-scriptcat-assistant'));
      FribergLiveDomAdapter.appendMutations(state.live.recentMutations, meaningful);
      queueLiveScan('页面内容发生变化，已重新扫描。');
    });
    state.live.pageObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'disabled', 'data-state', 'data-feedback', 'aria-disabled', 'aria-label'],
    });
    state.live.routeStop = FribergLiveDomAdapter.routeWatcher(() => {
      resetLiveBinding('页面路由已变化，已重新校验棋盘绑定。');
      queueLiveScan('SPA 路由已变化，正在重新扫描。');
    });
    startLiveHealthMonitor();
    scanLivePage();
  }

  async function boot() {
    if (globalThis.FribergLicenseClient) {
      const license = await globalThis.FribergLicenseClient.requireActiveLicense();
      if (!license?.active) return;
    }
    const saved = await chrome.storage.sync.get({ privateOrigins: [] });
    state.privateOrigins = saved.privateOrigins || [];
    state.policy = FribergAutomation.originPolicy(location.origin, state.privateOrigins);
    state.adapter = state.policy.canAct ? getMirrorAdapter() : null;
    state.overlay = FribergOverlay.mount({
      onScan: () => {
        if (!isLiveAssistSurface()) {
          state.adapter = getMirrorAdapter();
          updateOverlay();
          return;
        }
        if (!state.live?.listening) startLiveAssistant();
        else scanLivePage('已按你的点击重新扫描页面。');
      },
      onChooseBoard: beginLiveBoardCapture,
      onDiagnostic: diagnoseLivePage,
      onCopyDiagnostic: copyLiveDiagnostic,
      onDownloadDiagnostic: downloadLiveDiagnostic,
      onCopyNext: copyLiveRecommendation,
      onFillNext: () => {
        if (isLiveAssistSurface()) fillLiveRecommendation();
        else performRecommendedAction(false);
      },
      onRandomFirst: () => {
        if (isLiveAssistSurface()) fillRandomFirstGuess();
      },
      onSubmitGuess: () => {
        if (isLiveAssistSurface()) submitCurrentLiveGuess();
      },
      onMode: cycleMode,
      onPause: () => isLiveAssistSurface() ? pauseLiveListening() : pause(),
      onAction: () => performRecommendedAction(state.mode === FribergAutomation.MODES.AUTO),
    });

    if (isLiveAssistSurface()) {
      await loadPlayersAndMatrix();
      startLiveAssistant();
      return;
    }
    if (!state.adapter) {
      updateOverlay();
      return;
    }
    await loadPlayersAndMatrix();
    createSession(state.adapter.root.dataset.fribergRoundId || `mirror-${Date.now()}`);
    observeVisibleRows();
    updateOverlay(`已载入 ${state.players.length} 人矩阵；仅识别带稳定 data 合约的本地镜像。`);
  }

  addEventListener('friberg:license-invalidated', () => {
    clearLiveSubmitQueue();
    clearLiveSubmissionWatchdog();
    stopLiveBoardCapture();
    state.live?.pageObserver?.disconnect();
    state.live?.boardObserver?.disconnect();
    state.live?.routeStop?.();
    state.live?.inputStop?.();
    clearInterval(state.live?.healthTimer);
    if (state.live) {
      state.live.listening = false;
      state.live.session = null;
    }
    state.session = null;
    state.overlay?.destroy?.();
    state.overlay = null;
  });

  boot().catch(stopWithError);
})();
