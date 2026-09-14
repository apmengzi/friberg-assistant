// ==UserScript==
// @name         弗一把助手 · 真实页面只读诊断
// @namespace    local.friberg-assistant
// @version      0.9.3
// @description  Edge / ScriptCat：识别自己的可见棋盘、严格求解、随机首猜、用户触发的安全填入与提交。
// @match        https://shnlfriberg.online/multi*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// ==/UserScript==

/*__GAME_SOLVER__*/
/*__AUTOMATION_CORE__*/
/*__LIVE_DOM_ADAPTER__*/

(() => {
  'use strict';

  const RAW_PLAYERS = /*__PLAYER_ROWS__*/;
  const { GameSolver, FribergAutomation, FribergLiveDomAdapter } = globalThis;
  if (!GameSolver || !FribergAutomation || !FribergLiveDomAdapter || document.getElementById('friberg-scriptcat-assistant')) return;

  const VERSION = '0.9.3';
  const ROOT_ID = 'friberg-scriptcat-assistant';
  const STORAGE_KEY = 'friberg-scriptcat-calibration-v2';
  const LAYOUT_STORAGE_KEY = 'friberg-scriptcat-layout-v1';
  const FIELD_NAMES = ['nickname', 'team', 'country', 'age', 'role', 'majorWins', 'majorApps', 'status'];
  const NUMERIC_FIELDS = new Set(['age', 'majorWins', 'majorApps']);
  const SUBMIT_COOLDOWN_MS = 2100;
  const SUBMIT_RETRY_INTERVAL_MS = 100;
  const SUBMIT_QUEUE_TIMEOUT_MS = 10000;
  const SUBMIT_FEEDBACK_TIMEOUT_MS = 6000;

  const state = {
    players: GameSolver.normalizeGamePlayers(RAW_PLAYERS).filter(player => player.enabled !== false),
    matrix: null,
    session: null,
    board: null,
    rowSeed: null,
    rowParent: null,
    rowShape: null,
    observer: null,
    processedRows: new WeakSet(),
    processedFingerprints: new Set(),
    captureMode: null,
    calibration: { colors: {}, arrows: {} },
    lastError: '',
    lastFeedback: null,
    lastRow: '',
    lastCandidates: [],
    route: location.href,
    status: '等待对局',
    scan: null,
    recentMutations: [],
    errors: [],
    pageObserver: null,
    routeStop: null,
    listening: true,
    choosingBoard: false,
    scanTimer: null,
    lastDiagnostic: null,
    lastFill: null,
    lastFilledPlayer: null,
    lastSubmit: null,
    submissionInFlight: false,
    lastSubmitAt: 0,
    lastObservedRowCount: 0,
    lastBoardGuessCount: null,
    lastFeedbackAt: 0,
    roundMarker: null,
    submitQueue: null,
    submitQueueTimer: null,
    submissionWatchdogTimer: null,
    healthTimer: null,
    feedbackPaused: false,
    layout: { x: null, y: null, collapsed: false },
  };

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  const isTerminalState = value => ['WON', 'LOST'].includes(value);

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

  function visible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function visibleChildren(element) {
    return Array.from(element.children).filter(visible);
  }

  function elementSummary(element) {
    if (!element) return null;
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || '',
      className: typeof element.className === 'string' ? element.className : '',
      role: element.getAttribute('role') || '',
      childCount: visibleChildren(element).length,
      text: normalizeText(element.innerText).slice(0, 260),
    };
  }

  function describePath(element, limit = 5) {
    const parts = [];
    let node = element;
    while (node instanceof Element && parts.length < limit) {
      const id = node.id ? `#${CSS.escape(node.id)}` : '';
      const classes = typeof node.className === 'string'
        ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(name => `.${CSS.escape(name)}`).join('')
        : '';
      parts.unshift(`${node.tagName.toLowerCase()}${id || classes}`);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function cellSignal(cell) {
    const candidates = [cell, ...Array.from(cell.querySelectorAll(':scope > *')).slice(0, 3)];
    for (const element of candidates) {
      const style = getComputedStyle(element);
      const opaque = style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent';
      if (opaque || style.backgroundImage !== 'none') {
        return JSON.stringify({
          bg: style.backgroundColor,
          image: style.backgroundImage,
          border: style.borderColor,
          classes: typeof element.className === 'string' ? element.className.split(/\s+/).filter(Boolean).sort() : [],
        });
      }
    }
    const style = getComputedStyle(cell);
    return JSON.stringify({
      bg: style.backgroundColor,
      image: style.backgroundImage,
      border: style.borderColor,
      classes: typeof cell.className === 'string' ? cell.className.split(/\s+/).filter(Boolean).sort() : [],
    });
  }

  function arrowSignal(cell) {
    const arrow = cell.querySelector('svg, [class*="arrow" i], [aria-label*="up" i], [aria-label*="down" i], [aria-label*="上"], [aria-label*="下"]');
    if (!arrow) return '';
    return JSON.stringify({
      tag: arrow.tagName.toLowerCase(),
      classes: typeof arrow.className === 'string' ? arrow.className.split(/\s+/).filter(Boolean).sort() : [],
      aria: arrow.getAttribute('aria-label') || '',
      path: arrow.querySelector('path')?.getAttribute('d') || '',
      text: normalizeText(arrow.textContent),
    });
  }

  function directionFor(cell) {
    const text = normalizeText(cell.innerText);
    if (/[↑↑]/.test(text)) return 'up';
    if (/[↓↓]/.test(text)) return 'down';
    const hint = [cell, ...cell.querySelectorAll('[aria-label], [class]')]
      .map(element => `${element.getAttribute('aria-label') || ''} ${typeof element.className === 'string' ? element.className : ''}`.toLowerCase())
      .join(' ');
    if (/\b(up|increase|higher)\b|上/.test(hint)) return 'up';
    if (/\b(down|decrease|lower)\b|下/.test(hint)) return 'down';
    const signal = arrowSignal(cell);
    if (signal && signal === state.calibration.arrows.up) return 'up';
    if (signal && signal === state.calibration.arrows.down) return 'down';
    return 'none';
  }

  function hasUnknownArrow(cell) {
    return Boolean(arrowSignal(cell)) && directionFor(cell) === 'none';
  }

  function colorFor(cell) {
    const signal = cellSignal(cell);
    return Object.entries(state.calibration.colors).find(([, known]) => known === signal)?.[0] || '';
  }

  function looksLikeBoard(element) {
    const scan = state.scan || FribergLiveDomAdapter.scan(document);
    return scan.boardCandidates.some(candidate => candidate.element === element);
  }

  function findBoard(target) {
    const scan = FribergLiveDomAdapter.scan(document);
    state.scan = scan;
    return FribergLiveDomAdapter.findBoardForTarget(target, scan)?.element || null;
  }

  function cellsFor(row) {
    return visibleChildren(row).filter(cell => normalizeText(cell.innerText) || cell.querySelector('svg, img'));
  }

  function findRow(target) {
    let element = target instanceof Element ? target : null;
    while (element && element !== state.board) {
      const cells = cellsFor(element);
      if (cells.length === FIELD_NAMES.length) return element;
      element = element.parentElement;
    }
    return null;
  }

  function rowSignature(row) {
    return cellsFor(row).map(cell => cell.tagName).join('|');
  }

  function rowCandidates() {
    return state.board ? FribergLiveDomAdapter.feedbackRows(state.board) : [];
  }

  function playerForNickname(value) {
    const wanted = GameSolver.normalize(value);
    const matches = state.players.filter(player => GameSolver.normalize(player.nick) === wanted);
    if (matches.length !== 1) {
      throw new Error(matches.length ? `昵称“${value}”在题库中不唯一，已停止。` : `题库中没有昵称“${value}”，已停止。`);
    }
    return matches[0];
  }

  function readingFromRow(row) {
    const knownReading = FribergLiveDomAdapter.readFeedbackRow(row);
    if (knownReading.valid) return knownReading.reading;
    throw new Error(`反馈未通过共享 DOM 适配器校验：${knownReading.errors.join(' ')}`);
  }

  function resetSession(reason, { resetSubmitCooldown = false } = {}) {
    const previousSubmitAt = state.lastSubmitAt || 0;
    clearQueuedSubmit();
    clearSubmissionWatchdog();
    state.session = new FribergAutomation.AssistantSession({
      players: state.players,
      matrix: state.matrix,
      origin: location.origin,
      mode: FribergAutomation.MODES.RECOMMEND,
      dataDriftMaxScore: 1,
    });
    state.session.startRound(`scriptcat-${Date.now()}`);
    state.processedRows = new WeakSet();
    state.processedFingerprints = new Set();
    state.lastCandidates = state.players.slice();
    state.lastFeedback = null;
    state.lastRow = '';
    state.lastFill = null;
    state.lastFilledPlayer = null;
    state.lastSubmit = null;
    state.submissionInFlight = false;
    state.lastSubmitAt = resetSubmitCooldown ? 0 : previousSubmitAt;
    state.lastObservedRowCount = 0;
    state.lastBoardGuessCount = visibleBoardGuessCount(state.board);
    state.lastFeedbackAt = 0;
    state.roundMarker = visibleRoundMarker() || state.roundMarker || null;
    state.lastError = '';
    state.feedbackPaused = false;
    state.status = reason;
  }

  function processRow(row) {
    const fingerprint = FribergLiveDomAdapter.feedbackRowFingerprint(row);
    if (state.processedRows.has(row) || state.processedFingerprints.has(fingerprint)) return;
    const parsed = FribergLiveDomAdapter.readFeedbackRow(row);
    if (!parsed.valid) throw new Error(`反馈未通过共享 DOM 适配器校验：${parsed.errors.join(' ')}`);
    const baseGuess = playerForNickname(parsed.nickname);
    const visibleGuess = FribergAutomation.guessFromVisibleReading(baseGuess, parsed.reading, state.players);
    const result = state.session.recordObservedVisibleFeedback(visibleGuess, parsed.reading, { maxGuesses: 8 });
    state.processedRows.add(row);
    state.processedFingerprints.add(fingerprint);
    state.lastFeedback = parsed.reading;
    state.lastRow = normalizeText(parsed.cells.map(cell => cell.innerText).join(' | ')).slice(0, 320);
    state.lastCandidates = result.candidates || [];
    state.lastFill = null;
    state.lastFilledPlayer = null;
    clearQueuedSubmit();
    clearSubmissionWatchdog();
    state.submissionInFlight = false;
    state.lastFeedbackAt = Date.now();
    state.lastBoardGuessCount = visibleBoardGuessCount(state.board);
    state.lastError = '';
    state.status = result.won
      ? '页面报告本局胜利'
      : result.lost
        ? '本局已结束'
        : result.dataDrift
          ? '已用加权数据漂移恢复候选'
          : '已读取新的自己的可见反馈';
  }

  function synchronizeRows() {
    if (!state.session || !state.board) throw new Error('请先选择自己的棋盘。');
    const marker = visibleRoundMarker();
    const markerChanged = Boolean(marker && state.roundMarker && marker !== state.roundMarker);
    if (marker) state.roundMarker = marker;
    let rows = rowCandidates();
    const fingerprints = rows.map(row => FribergLiveDomAdapter.feedbackRowFingerprint(row));
    const boardGuessCount = visibleBoardGuessCount(state.board);
    const terminal = isTerminalState(state.session.state);
    const hadRoundEvidence = Boolean(
      state.session.history.length
      || state.processedFingerprints.size
      || state.feedbackPaused
      || state.lastError
      || terminal,
    );
    const boardCleared = rows.length === 0 && hadRoundEvidence;
    const rowCountRewound = rows.length < (state.lastObservedRowCount || 0);
    const guessCountRewound = boardGuessCount !== null
      && state.lastBoardGuessCount !== null
      && boardGuessCount < state.lastBoardGuessCount;
    const counterReturnedToZero = boardGuessCount === 0 && hadRoundEvidence;
    const allRowsReplacedAfterTerminal = terminal
      && rows.length > 0
      && fingerprints.every(fingerprint => !state.processedFingerprints.has(fingerprint));
    if (markerChanged || boardCleared || rowCountRewound || guessCountRewound || counterReturnedToZero || allRowsReplacedAfterTerminal) {
      resetSession(
        markerChanged
          ? `检测到 ${marker}；已清除上一小局状态并开放随机首猜。`
          : '检测到棋盘已进入新一小局；已清除上一局状态并开放随机首猜。',
        { resetSubmitCooldown: true },
      );
      rows = rowCandidates();
    }
    state.lastObservedRowCount = rows.length;
    state.lastBoardGuessCount = visibleBoardGuessCount(state.board);
    state.feedbackPaused = false;
    for (const row of rows) processRow(row);
    state.lastError = '';
    render();
  }

  function stopWithError(cause) {
    state.lastError = cause instanceof Error ? cause.message : String(cause);
    state.errors.push(state.lastError);
    if (state.errors.length > 20) state.errors.shift();
    state.feedbackPaused = true;
    state.status = '最新反馈尚未识别：监听将自动重试';
    render();
  }

  function installObserver() {
    state.observer?.disconnect();
    if (!state.board) return;
    state.observer = new MutationObserver(records => {
      FribergLiveDomAdapter.appendMutations(state.recentMutations, records);
      try { synchronizeRows(); } catch (cause) { stopWithError(cause); }
    });
    state.observer.observe(state.board, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'data-feedback', 'data-state', 'aria-label'],
    });
  }

  function bindBoard(board, source) {
    if (!board) return;
    state.board = board;
    state.rowSeed = null;
    state.rowParent = null;
    state.rowShape = null;
    state.observer?.disconnect();
    const rows = FribergLiveDomAdapter.feedbackRows(board);
    resetSession(source === 'automatic'
      ? '已自动绑定“我的猜测”棋盘，正在同步可见反馈。'
      : '已绑定自己的棋盘，正在同步可见反馈。');
    installObserver();
    if (rows.length) synchronizeRows();
  }

  function queueLiveScan(reason) {
    if (!state.listening || state.scanTimer) return;
    state.scanTimer = setTimeout(() => {
      state.scanTimer = null;
      try { refreshLiveScan(reason); } catch (cause) { stopWithError(cause); }
    }, 120);
  }

  function startHealthMonitor() {
    clearInterval(state.healthTimer);
    state.healthTimer = setInterval(() => {
      if (!state.listening) return;
      try {
        const marker = visibleRoundMarker();
        const count = visibleBoardGuessCount(state.board);
        const markerChanged = Boolean(marker && state.roundMarker && marker !== state.roundMarker);
        const countRewound = count !== null
          && state.lastBoardGuessCount !== null
          && count < state.lastBoardGuessCount;
        const staleAtFreshBoard = count === 0 && Boolean(
          state.feedbackPaused
          || state.lastError
          || state.session?.history.length
          || state.processedFingerprints.size
          || isTerminalState(state.session?.state),
        );
        if (state.board && state.session && (markerChanged || countRewound || staleAtFreshBoard)) {
          synchronizeRows();
          state.scan = FribergLiveDomAdapter.scan(document);
          render();
          return;
        }
        const input = state.scan?.inputCandidates?.[0]?.element;
        if (!state.board || !input?.isConnected || state.feedbackPaused) {
          queueLiveScan('状态巡检发现页面已变化。');
        }
      } catch (cause) {
        stopWithError(cause);
      }
    }, 350);
  }

  function refreshLiveScan(reason) {
    if (!state.listening) return;
    state.scan = FribergLiveDomAdapter.scan(document);
    if (state.board && !document.documentElement.contains(state.board)) {
      state.board = null;
      state.rowSeed = null;
      state.rowParent = null;
      state.rowShape = null;
      state.observer?.disconnect();
      resetSession('先前绑定的棋盘已移除，正在重新扫描。');
    }
    if (!state.board && state.scan.autoBoard) {
      try { bindBoard(state.scan.autoBoard.element, 'automatic'); } catch (cause) { stopWithError(cause); return; }
    }
    if (!state.board) {
      state.status = '等待对局';
      state.lastError = '';
      const selectableBoards = state.scan.boardCandidates.filter(candidate => candidate.ownership !== 'opponent');
      if (selectableBoards.length > 1) {
        FribergLiveDomAdapter.markBoardCandidates(selectableBoards);
        state.status = '请选择自己的棋盘';
        state.lastError = '发现多个可能棋盘；点击“选择自己的棋盘”后再点击有边框的棋盘。';
      }
    } else {
      try { synchronizeRows(); } catch (cause) { stopWithError(cause); }
    }
    if (reason) state.status = state.board ? state.status : '等待对局';
    render();
  }

  function previewCandidates() {
    const candidates = state.lastCandidates;
    if (!candidates.length) return '—';
    return candidates.slice(0, 3).map(player => player.nick).join(' / ');
  }

  function recommendation() {
    return state.session?.history?.length ? state.session.lastRecommendation?.player || null : null;
  }

  function uniquePlayerForText(value) {
    const wanted = GameSolver.normalize(value);
    if (!wanted) return null;
    const matches = state.players.filter(player => GameSolver.normalize(player.nick) === wanted);
    return matches.length === 1 ? matches[0] : null;
  }

  function setCapture(mode) {
    state.captureMode = mode;
    if (mode === 'board') {
      state.scan = FribergLiveDomAdapter.scan(document);
      state.choosingBoard = true;
      FribergLiveDomAdapter.markBoardCandidates(
        state.scan.boardCandidates.filter(candidate => candidate.ownership !== 'opponent'),
        state.board,
      );
    }
    state.status = mode === 'board'
      ? '选择模式：请点击你自己的“我的猜测”棋盘区域；该次点击不会提交游戏操作。'
      : mode === 'row'
        ? '选择模式：请点击一条你自己的真实反馈行；该次点击不会提交游戏操作。'
        : `校准模式：请点击一个${mode === 'green' ? '绿色' : mode === 'yellow' ? '黄色' : mode === 'gray' ? '灰色' : mode === 'up' ? '向上箭头' : '向下箭头'}反馈格；该次点击不会提交游戏操作。`;
    render();
  }

  function handleCapture(event) {
    if (!state.captureMode) return;
    const path = event.composedPath();
    if (path.includes(host)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const mode = state.captureMode;
    state.captureMode = null;
    if (mode === 'board') {
      state.choosingBoard = false;
      FribergLiveDomAdapter.clearMarks();
    }
    try {
      if (mode === 'board') {
        const candidate = FribergLiveDomAdapter.findBoardForTarget(event.target, state.scan);
        if (!candidate) throw new Error('这里没有发现包含全部字段标题的棋盘；请点击“我的猜测”的表格区域。');
        if (candidate.ownership === 'opponent') throw new Error('该棋盘属于对方或含 masked-cell，已拒绝绑定。');
        bindBoard(candidate.element, 'manual');
      } else if (mode === 'row') {
        if (!state.board) throw new Error('请先选择自己的棋盘。');
        const row = findRow(event.target);
        if (!row) throw new Error('未找到 8 格反馈行；请直接点击一条猜测结果的任意格。');
        state.rowSeed = row;
        state.rowParent = row.parentElement;
        state.rowShape = rowSignature(row);
        resetSession('已锁定自己的反馈行结构，正在同步已可见历史。');
        installObserver();
        synchronizeRows();
      } else {
        if (!state.rowSeed) throw new Error('请先选择自己的反馈行，才能校准颜色与箭头。');
        const row = findRow(event.target);
        if (!row) throw new Error('请点击已选择棋盘中的反馈格。');
        const directCell = cellsFor(row).find(cell => cell === event.target || cell.contains(event.target));
        if (!directCell) throw new Error('未能定位被点击的反馈格。');
        if (['green', 'yellow', 'gray'].includes(mode)) {
          state.calibration.colors[mode] = cellSignal(directCell);
          state.status = `已校准${mode}反馈颜色。`;
        } else {
          const signal = arrowSignal(directCell);
          if (!signal) throw new Error('该格没有可识别的箭头元素，请点击数字旁的箭头图标。');
          state.calibration.arrows[mode] = signal;
          state.status = `已校准${mode === 'up' ? '向上' : '向下'}箭头。`;
        }
        saveCalibration();
      }
    } catch (cause) {
      stopWithError(cause);
      return;
    }
    render();
  }

  async function gmGet(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') return await GM_getValue(key, fallback);
      if (globalThis.GM?.getValue) return await globalThis.GM.getValue(key, fallback);
    } catch { /* ScriptCat storage is optional */ }
    return fallback;
  }

  async function gmSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') return await GM_setValue(key, value);
      if (globalThis.GM?.setValue) return await globalThis.GM.setValue(key, value);
    } catch { /* ScriptCat storage is optional */ }
    return undefined;
  }

  function saveCalibration() {
    void gmSet(STORAGE_KEY, state.calibration);
  }

  function auditCandidates() {
    const scan = state.scan || FribergLiveDomAdapter.scan(document);
    return scan.boardCandidates.map(candidate => ({
      score: candidate.score,
      reasons: candidate.reasons,
      headers: candidate.headers,
      selfEvidence: candidate.selfEvidence,
      ...FribergLiveDomAdapter.elementDescriptor(candidate.element),
    }));
  }

  function diagnostic() {
    state.scan = FribergLiveDomAdapter.scan(document);
    const recommendationValue = recommendation();
    const report = FribergLiveDomAdapter.diagnostic({
      scanResult: state.scan,
      activeBoard: state.board,
      recentMutations: state.recentMutations,
      errors: [...state.errors, state.lastError].filter(Boolean),
      extensionVersion: VERSION,
      gamePoolSize: state.players.length,
      adapterState: {
        listening: state.listening,
        choosingBoard: state.choosingBoard,
        rowCount: rowCandidates().length,
        processedRows: state.session?.history.length || 0,
        lastFill: state.lastFill,
        lastSubmit: state.lastSubmit,
        submitQueued: state.submitQueue ? {
          nickname: state.submitQueue.nickname,
          createdAt: state.submitQueue.createdAt,
          deadline: state.submitQueue.deadline,
        } : null,
        submissionInFlight: state.submissionInFlight,
        feedbackPaused: state.feedbackPaused,
      },
    });
    return {
      ...report,
      generatedAt: new Date().toISOString(),
      extension: 'ScriptCat userscript',
      version: VERSION,
      policy: FribergAutomation.originPolicy(location.origin),
      players: state.players.length,
      matrixReady: Boolean(state.matrix),
      pageMode: 'public-visible-dom-assist',
      board: elementSummary(state.board),
      boardPath: describePath(state.board),
      rowSeed: elementSummary(state.rowSeed),
      rowContainer: elementSummary(state.rowParent),
      rowCount: rowCandidates().length,
      processedRows: state.session?.history.length || 0,
      lastProcessedRow: state.lastRow,
      lastFeedback: state.lastFeedback,
      candidateCount: state.lastCandidates.length,
      recommendation: recommendationValue?.nick || null,
      bestProbe: state.session?.lastRecommendation?.purpose || null,
      currentError: state.lastError || null,
      legacyBoardCandidates: auditCandidates(),
    };
  }

  function copyText(value) {
    if (!value) return;
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(value, 'text');
      } else if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(value);
      }
      state.status = `已复制：${value}`;
    } catch (cause) {
      state.lastError = `复制失败：${cause.message}`;
    }
    render();
  }

  function exportDiagnostic() {
    const blob = new Blob([JSON.stringify(diagnostic(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `friberg-diagnostic-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    state.status = '已下载本地诊断 JSON；可把它交给我继续完成真实 DOM 合约。';
    render();
  }

  function copyDiagnostic() {
    const report = diagnostic();
    const text = JSON.stringify(report, null, 2);
    try {
      if (typeof GM_setClipboard === 'function') GM_setClipboard(text, 'text');
      else if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text);
      else throw new Error('当前浏览器没有可用的剪贴板接口。');
      state.status = '诊断 JSON 已复制；可直接粘贴到此任务。';
      state.lastError = '';
    } catch (cause) {
      state.lastError = `复制诊断失败：${cause.message}`;
    }
    render();
  }

  async function fillPlayer(player, sourceLabel) {
    state.scan = FribergLiveDomAdapter.scan(document);
    const input = state.scan.inputCandidates?.[0]?.element;
    if (state.feedbackPaused || !input || !player || state.submissionInFlight) {
      state.status = '无法填入选手';
      state.lastError = state.feedbackPaused
        ? '最新反馈尚未识别；监听仍会自动重试，也可点击“扫描页面”。'
        : state.submissionInFlight
          ? '上一猜已经提交，正在等待反馈行。'
          : '需要可用选手和已发现的搜索框。';
      render();
      return;
    }
    state.status = sourceLabel === '随机首猜' ? '正在生成随机首猜' : '正在填入下一猜';
    state.lastError = '';
    render();
    try {
      const result = await FribergLiveDomAdapter.fillAndSelectUniqueOption({ input, player, players: state.players, documentRef: document });
      state.lastFill = result;
      state.lastFilledPlayer = result.status === 'selected' ? player : null;
      state.lastSubmit = null;
      state.status = result.status === 'selected'
        ? `${sourceLabel || '下一猜'}已选中，等待提交`
        : '未自动选择下拉项';
      state.lastError = result.status === 'selected' ? '' : result.message || '';
    } catch (cause) {
      state.lastError = cause instanceof Error ? cause.message : String(cause);
      state.errors.push(state.lastError);
      state.status = '填入已停止';
    }
    render();
  }

  function fillRecommended() {
    const player = recommendation();
    if (!state.board || !player) {
      state.status = '无法填入下一猜';
      state.lastError = '需要已绑定自己的棋盘并产生下一猜推荐。';
      render();
      return;
    }
    void fillPlayer(player, '下一猜');
  }

  function fillRandomFirstGuess() {
    if ((state.session?.history.length || 0) > 0) {
      state.status = '随机首猜已停用';
      state.lastError = '本局已有反馈；请使用求解器给出的“填入下一猜”。';
      render();
      return;
    }
    const player = FribergAutomation.pickRandomPlayer({
      players: state.players,
      guessedKeys: state.session?.guessedKeys || new Set(),
    });
    if (!player) {
      state.status = '没有可用的随机首猜';
      state.lastError = '题库中没有尚未猜过的启用选手。';
      render();
      return;
    }
    void fillPlayer(player, '随机首猜');
  }

  function clearQueuedSubmit() {
    clearTimeout(state.submitQueueTimer);
    state.submitQueueTimer = null;
    state.submitQueue = null;
  }

  function clearSubmissionWatchdog() {
    clearTimeout(state.submissionWatchdogTimer);
    state.submissionWatchdogTimer = null;
  }

  function beginSubmissionWatchdog(player) {
    clearSubmissionWatchdog();
    state.submissionWatchdogTimer = setTimeout(() => {
      if (!state.submissionInFlight) return;
      state.submissionInFlight = false;
      state.lastSubmit = {
        status: 'feedback-timeout',
        submitted: false,
        player: player.nick,
        message: '提交后未检测到新的反馈行。',
      };
      state.status = '提交后未收到反馈';
      state.lastError = '';
      state.scan = FribergLiveDomAdapter.scan(document);
      render();
    }, SUBMIT_FEEDBACK_TIMEOUT_MS);
  }

  function scheduleSubmitRetry(delay = SUBMIT_RETRY_INTERVAL_MS) {
    if (!state.submitQueue || state.submitQueueTimer) return;
    state.submitQueueTimer = setTimeout(() => {
      state.submitQueueTimer = null;
      attemptQueuedSubmit();
    }, Math.max(20, delay));
  }

  function stopQueuedSubmit(result) {
    clearQueuedSubmit();
    state.lastSubmit = result;
    state.status = '提交已停止';
    state.lastError = result?.message || '提交前校验失败。';
    render();
  }

  function attemptQueuedSubmit() {
    const queued = state.submitQueue;
    if (!queued || state.submissionInFlight) return;
    if (!state.listening || state.feedbackPaused || Date.now() >= queued.deadline) {
      stopQueuedSubmit({
        status: 'queue-timeout',
        submitted: false,
        message: '网页提交按钮在 10 秒内没有恢复；本次没有点击原网页按钮。',
      });
      return;
    }

    state.scan = FribergLiveDomAdapter.scan(document);
    const input = state.scan.inputCandidates?.[0]?.element;
    const player = uniquePlayerForText(input?.value);
    if (!player || GameSolver.playerKey(player) !== queued.playerKey) {
      stopQueuedSubmit({
        status: 'mismatch',
        submitted: false,
        message: '等待期间搜索框内容发生变化，已取消排队提交。',
      });
      return;
    }

    const localCooldownRemaining = state.lastSubmitAt + SUBMIT_COOLDOWN_MS - Date.now();
    const pageCooldownRemaining = visiblePageGuessCooldownMs();
    const cooldownRemaining = Math.max(localCooldownRemaining, pageCooldownRemaining);
    if (cooldownRemaining > 0) {
      state.status = `等待网页提交冷却：${Math.max(0.1, Math.ceil(cooldownRemaining / 100) / 10)} 秒`;
      state.lastError = '';
      scheduleSubmitRetry(Math.min(250, Math.max(SUBMIT_RETRY_INTERVAL_MS, cooldownRemaining)));
      render();
      return;
    }

    const result = FribergLiveDomAdapter.submitSelectedGuess({
      input,
      player,
      scanResult: state.scan,
      documentRef: document,
    });
    state.lastSubmit = result;
    if (result.status === 'submitted') {
      clearQueuedSubmit();
      state.submissionInFlight = true;
      state.lastSubmitAt = Date.now();
      state.status = '猜测已提交';
      state.lastError = '';
      beginSubmissionWatchdog(player);
      render();
      return;
    }
    if (['disabled', 'missing'].includes(result.status)) {
      state.status = `等待网页提交冷却：已排队 ${player.nick}`;
      state.lastError = '';
      scheduleSubmitRetry();
      render();
      return;
    }
    stopQueuedSubmit(result);
  }

  function submitCurrentGuess() {
    if (state.submissionInFlight || state.submitQueue) return;
    state.scan = FribergLiveDomAdapter.scan(document);
    const input = state.scan.inputCandidates?.[0]?.element;
    const player = uniquePlayerForText(input?.value);
    if (!input || !player) {
      stopQueuedSubmit({
        status: 'error',
        submitted: false,
        message: '搜索框中不是题库内唯一选手昵称。',
      });
      return;
    }
    state.submitQueue = {
      playerKey: GameSolver.playerKey(player),
      nickname: player.nick,
      createdAt: Date.now(),
      deadline: Date.now() + SUBMIT_QUEUE_TIMEOUT_MS,
    };
    state.status = `正在检查网页提交冷却：${player.nick}`;
    state.lastError = '';
    render();
    attemptQueuedSubmit();
  }

  function startPageListening() {
    state.pageObserver?.disconnect();
    state.routeStop?.();
    state.listening = true;
    state.pageObserver = new MutationObserver(records => {
      const meaningful = records.filter(record => !record.target.closest?.(`#${ROOT_ID}`));
      FribergLiveDomAdapter.appendMutations(state.recentMutations, meaningful);
      queueLiveScan('页面发生变化。');
    });
    state.pageObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'disabled', 'data-feedback', 'data-state', 'aria-disabled', 'aria-label'],
    });
    state.routeStop = FribergLiveDomAdapter.routeWatcher(handleRouteChange);
    startHealthMonitor();
    refreshLiveScan('监听已启动。');
  }

  function pauseListening() {
    clearQueuedSubmit();
    clearSubmissionWatchdog();
    clearInterval(state.healthTimer);
    state.healthTimer = null;
    state.captureMode = null;
    state.choosingBoard = false;
    FribergLiveDomAdapter.clearMarks();
    state.listening = false;
    state.pageObserver?.disconnect();
    state.routeStop?.();
    state.observer?.disconnect();
    state.status = '监听已暂停';
    state.lastError = '';
    render();
  }

  function handleRouteChange() {
    if (state.route === location.href) return;
    state.route = location.href;
    state.board = null;
    state.rowSeed = null;
    state.rowParent = null;
    state.rowShape = null;
    state.observer?.disconnect();
    resetSession('页面路由已变化；正在重新扫描自己的棋盘。', { resetSubmitCooldown: true });
    state.scan = null;
    try { refreshLiveScan('SPA 路由已变化。'); } catch (cause) { stopWithError(cause); }
  }

  const host = document.createElement('aside');
  host.id = ROOT_ID;
  host.setAttribute('aria-label', '弗一把助手，只读诊断模式');
  Object.assign(host.style, {
    position: 'fixed',
    zIndex: '2147483646',
    top: '16px',
    right: '16px',
  });
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .panel { width: min(328px, calc(100vw - 24px)); color: #eef5ff; background: #111a2c; border: 1px solid #465a80; box-shadow: 0 18px 56px rgba(3, 9, 23, .46); font: 13px/1.36 ui-sans-serif, system-ui, sans-serif; transition: width .16s ease, box-shadow .16s ease; }
      .head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; padding: 11px 11px 10px 14px; cursor: grab; touch-action: none; user-select: none; background: linear-gradient(135deg, #22385e, #171f35); border-bottom: 1px solid #465a80; }
      .panel[data-dragging="true"] { box-shadow: 0 22px 70px rgba(3, 9, 23, .62); } .panel[data-dragging="true"] .head { cursor: grabbing; }
      .title { min-width: 0; pointer-events: none; }
      .eyebrow { margin: 0 0 4px; color: #9bb7ff; font: 700 10px/1 ui-monospace, Consolas, monospace; letter-spacing: .13em; }
      h1 { margin: 0; color: #fff; font: 780 19px/1.05 Georgia, 'Noto Serif SC', serif; }
      .window-controls { display: flex; align-items: flex-start; gap: 4px; }
      .chip { padding: 6px; border: 1px solid #83d4c3; color: #c7fff3; font: 700 10px/1 ui-monospace, Consolas, monospace; letter-spacing: .04em; }
      button.window-button { width: 27px; min-width: 27px; min-height: 27px; padding: 0; color: #dbe7ff; background: #263653; border: 1px solid #4a618c; font: 800 15px/1 ui-monospace, Consolas, monospace; }
      button.window-button:hover { color: #102333; background: #83d4c3; border-color: #a3f2e1; }
      .rail { display: flex; gap: 3px; padding: 8px 14px 0; }
      .rail i { width: 24px; height: 4px; display: block; }
      .rail i:nth-child(1) { background: #34c48d; } .rail i:nth-child(2) { background: #e1a54f; } .rail i:nth-child(3) { background: #778495; }
      .body { display: grid; gap: 10px; padding: 12px 14px 14px; }
      .status { margin: 0; min-height: 34px; color: #b7c8e8; font-size: 12px; }
      .metrics { display: grid; grid-template-columns: 1fr 1fr; margin: 0; border-top: 1px solid #34445f; border-left: 1px solid #34445f; }
      .metrics div { min-width: 0; padding: 7px; border-right: 1px solid #34445f; border-bottom: 1px solid #34445f; }
      dt { color: #9aaac6; font-size: 10px; } dd { overflow: hidden; margin: 2px 0 0; color: #fff; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
      .next { padding: 9px; border-left: 3px solid #83d4c3; background: #17283a; } .next small { display: block; color: #a2b5d1; } .next strong { color: #d6fff4; font: 750 16px/1.1 Georgia, 'Noto Serif SC', serif; }
      .controls { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
      button { min-height: 31px; padding: 6px 7px; cursor: pointer; color: #e7f0ff; background: #263653; border: 1px solid #4a618c; border-radius: 0; font: 700 11px/1.1 ui-sans-serif, system-ui, sans-serif; }
      button:hover:not(:disabled) { background: #31486e; } button.primary { color: #102333; background: #83d4c3; border-color: #a3f2e1; } button.random { color: #102333; background: #b9c9ff; border-color: #d5defe; } button.submit { color: #14230b; background: #d8f36a; border-color: #efffa4; } button.warn { color: #ffdbc4; border-color: #9d5f57; background: #472a31; } button:disabled { cursor: not-allowed; opacity: .45; }
      .detail { margin: 0; color: #aebed8; font-size: 11px; } .error { color: #ffb5ad; } .tiny { color: #8799b9; font-size: 10px; }
      .panel[data-collapsed="true"] { width: min(210px, calc(100vw - 16px)); }
      .panel[data-collapsed="true"] .head { padding-top: 9px; padding-bottom: 9px; border-bottom: 0; }
      .panel[data-collapsed="true"] .eyebrow,.panel[data-collapsed="true"] .rail,.panel[data-collapsed="true"] .body { display: none; }
      .panel[data-collapsed="true"] h1 { overflow: hidden; font-size: 16px; line-height: 27px; text-overflow: ellipsis; white-space: nowrap; }
      @media (prefers-reduced-motion: reduce) { .panel { transition: none; } }
      @media (max-width: 580px) { .panel { width: min(328px, calc(100vw - 16px)); } }
    </style>
    <section class="panel" data-collapsed="false">
      <header class="head" data-drag-handle>
        <div class="title"><p class="eyebrow">SCRIPT CAT / LIVE ASSIST</p><h1>弗一把助手</h1></div>
        <div class="window-controls"><span class="chip">646</span><button class="window-button" data-window="reset" title="归位" aria-label="将悬浮窗归位">⌖</button><button class="window-button" data-window="collapse" title="最小化" aria-label="最小化悬浮窗" aria-expanded="true">—</button></div>
      </header>
      <div class="rail"><i></i><i></i><i></i></div>
      <div class="body">
        <p class="status" data-status></p>
        <dl class="metrics"><div><dt>题库</dt><dd>646</dd></div><div><dt>监听</dt><dd data-listener>运行中</dd></div><div><dt>当前 URL</dt><dd data-route>/multi</dd></div><div><dt>自己的棋盘</dt><dd data-board>尚未发现</dd></div><div><dt>搜索框</dt><dd data-search>未发现</dd></div><div><dt>下拉菜单</dt><dd data-dropdown>未发现</dd></div><div><dt>本局猜测</dt><dd data-guesses>0 / 8</dd></div><div><dt>剩余候选</dt><dd data-candidates>646</dd></div></dl>
        <div class="next"><small>当前推荐 / 最佳探针</small><strong data-next>等待反馈</strong></div>
        <div class="controls"><button class="primary" data-action="scan">扫描页面</button><button data-action="board">选择自己的棋盘</button><button data-action="sync">重新读取反馈</button><button data-action="copy">复制下一猜</button><button class="primary" data-action="fill">填入下一猜</button><button class="random" data-action="random-first">随机首猜并填入</button><button class="submit" data-action="submit">提交当前猜测</button><button data-action="diagnostic">采集诊断</button><button data-action="copy-diagnostic">复制诊断</button><button data-action="export">下载诊断 JSON</button><button class="warn" data-action="pause">暂停监听</button></div>
        <p class="detail" data-detail></p><p class="detail error" data-error></p><p class="tiny">填入与提交均只响应你的点击；提交前会再次核对选手、搜索框和原网页提交按钮。</p>
      </div>
    </section>`;
  document.documentElement.append(host);

  const $ = selector => shadow.querySelector(selector);
  const panel = $('.panel');
  let drag = null;

  function clampLayoutPoint(x, y) {
    const width = host.offsetWidth || panel.offsetWidth || 210;
    const height = host.offsetHeight || panel.offsetHeight || 48;
    return {
      x: Math.max(8, Math.min(Number(x) || 8, Math.max(8, innerWidth - width - 8))),
      y: Math.max(8, Math.min(Number(y) || 8, Math.max(8, innerHeight - height - 8))),
    };
  }

  function placePanel(x, y) {
    const point = clampLayoutPoint(x, y);
    host.style.left = `${Math.round(point.x)}px`;
    host.style.top = `${Math.round(point.y)}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    state.layout = { ...state.layout, ...point };
  }

  function savePanelLayout() {
    void gmSet(LAYOUT_STORAGE_KEY, state.layout);
  }

  function setPanelCollapsed(collapsed, persist = true) {
    state.layout = { ...state.layout, collapsed: Boolean(collapsed) };
    panel.dataset.collapsed = String(state.layout.collapsed);
    const button = $('[data-window="collapse"]');
    button.textContent = state.layout.collapsed ? '□' : '—';
    button.title = state.layout.collapsed ? '恢复' : '最小化';
    button.setAttribute('aria-label', state.layout.collapsed ? '恢复悬浮窗' : '最小化悬浮窗');
    button.setAttribute('aria-expanded', String(!state.layout.collapsed));
    if (state.layout.x !== null && state.layout.y !== null) requestAnimationFrame(() => placePanel(state.layout.x, state.layout.y));
    if (persist) savePanelLayout();
  }

  function resetPanelPosition(persist = true) {
    host.style.left = 'auto';
    host.style.top = '16px';
    host.style.right = '16px';
    host.style.bottom = 'auto';
    state.layout = { ...state.layout, x: null, y: null };
    if (persist) savePanelLayout();
  }

  $('[data-drag-handle]').addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    const rect = host.getBoundingClientRect();
    drag = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    panel.dataset.dragging = 'true';
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  $('[data-drag-handle]').addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    placePanel(event.clientX - drag.dx, event.clientY - drag.dy);
  });
  const finishPanelDrag = event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    delete panel.dataset.dragging;
    savePanelLayout();
  };
  $('[data-drag-handle]').addEventListener('pointerup', finishPanelDrag);
  $('[data-drag-handle]').addEventListener('pointercancel', finishPanelDrag);
  addEventListener('resize', () => {
    if (state.layout.x !== null && state.layout.y !== null) placePanel(state.layout.x, state.layout.y);
  });

  function render() {
    const recommendationValue = recommendation();
    const scan = state.scan;
    $('[data-status]').textContent = state.status;
    $('[data-listener]').textContent = state.listening ? '运行中' : '已暂停';
    $('[data-route]').textContent = location.href;
    $('[data-guesses]').textContent = `${state.session?.history.length || 0} / 8`;
    $('[data-candidates]').textContent = String(state.session ? state.lastCandidates.length : state.players.length);
    $('[data-board]').textContent = state.board ? '已绑定' : '尚未发现';
    $('[data-search]').textContent = scan?.inputCandidates?.length ? '已发现' : '未发现';
    $('[data-dropdown]').textContent = scan?.dropdownCandidates?.length ? '已发现' : '未发现';
    $('[data-next]').textContent = state.feedbackPaused
      ? '最新反馈待识别'
      : recommendationValue
        ? `${recommendationValue.nick} · ${state.session.lastRecommendation.purpose === 'probe' ? '探针' : '直接猜'}${state.session.lastResolution?.mode === 'data-drift' ? ' · 数据漂移恢复' : ''}`
        : '等待反馈';
    $('[data-action="fill"]').disabled = Boolean(state.feedbackPaused || !state.board || !recommendationValue);
    const input = scan?.inputCandidates?.[0]?.element;
    const inputPlayer = uniquePlayerForText(input?.value);
    const submitCandidate = input
      ? FribergLiveDomAdapter.uniqueSubmitButton({ scanResult: scan, input, documentRef: document })
      : null;
    const submitButtonFound = submitCandidate?.status === 'unique';
    const randomDisabled = Boolean(
      state.feedbackPaused
      || !input
      || (state.session?.history.length || 0) > 0
      || isTerminalState(state.session?.state)
      || state.submissionInFlight
    );
    const randomBlockedReason = !randomDisabled
      ? ''
      : state.feedbackPaused
        ? '等待换局重置'
        : !input
          ? '未发现输入框'
          : state.submissionInFlight
            ? '等待上一猜反馈'
            : isTerminalState(state.session?.state)
              ? '等待下一小局'
              : '本局已有反馈';
    $('[data-action="random-first"]').disabled = randomDisabled;
    $('[data-action="random-first"]').textContent = randomDisabled ? `随机首猜（${randomBlockedReason}）` : '随机首猜并填入';
    $('[data-action="random-first"]').title = randomDisabled ? randomBlockedReason : '随机选择一名尚未猜过的选手并填入原网页。';
    $('[data-action="submit"]').disabled = Boolean(
      state.feedbackPaused
      || state.submissionInFlight
      || state.submitQueue
      || !inputPlayer
      || !submitButtonFound,
    );
    $('[data-action="submit"]').textContent = state.submitQueue ? '等待网页 CD…' : '提交当前猜测';
    $('[data-detail]').textContent = state.submitQueue
      ? `已排队 ${state.submitQueue.nickname}；原网页按钮恢复后会自动提交一次。`
      : state.feedbackPaused
        ? '此前历史已保留；监听会在 DOM 变化或手动扫描时自动重试最新一行。'
      : state.board
        ? state.session?.lastResolution?.mode === 'data-drift'
          ? `严格候选归零；已按资料稳定性加权恢复。疑似漂移：${state.session.lastResolution.conflicts.map(item => `${item.nickname}(${item.fields.join('、')})`).slice(0, 4).join('；')}。`
          : `反馈行：${rowCandidates().length} 行；候选预览：${previewCandidates()}`
        : '等待对局。出现“我的猜测”棋盘会自动绑定；也可手动选择自己的棋盘。';
    $('[data-error]').textContent = state.lastError;
  }

  shadow.addEventListener('click', event => {
    const windowAction = event.target.closest('button')?.dataset.window;
    if (windowAction === 'collapse') {
      setPanelCollapsed(!state.layout.collapsed);
      return;
    }
    if (windowAction === 'reset') {
      resetPanelPosition();
      return;
    }
    const action = event.target.closest('button')?.dataset.action;
    if (!action) return;
    if (action === 'scan') {
      if (!state.listening) startPageListening();
      else {
        try { refreshLiveScan('已按你的点击重新扫描页面。'); } catch (cause) { stopWithError(cause); }
      }
    }
    else if (action === 'board') setCapture('board');
    else if (action === 'row') setCapture('row');
    else if (['green', 'yellow', 'gray', 'up', 'down'].includes(action)) setCapture(action);
    else if (action === 'sync') { try { synchronizeRows(); } catch (cause) { stopWithError(cause); } }
    else if (action === 'copy') copyText(recommendation()?.nick || '');
    else if (action === 'fill') fillRecommended();
    else if (action === 'random-first') fillRandomFirstGuess();
    else if (action === 'submit') submitCurrentGuess();
    else if (action === 'diagnostic') {
      const report = diagnostic();
      state.status = `诊断：${report.boardCandidates.length} 个可能棋盘、${report.rowCount} 条可见反馈行、${report.candidateCount} 名候选。需要完整内容请点击“导出诊断 JSON”。`;
      render();
    }
    else if (action === 'copy-diagnostic') copyDiagnostic();
    else if (action === 'export') exportDiagnostic();
    else if (action === 'pause') {
      pauseListening();
    }
  });

  document.addEventListener('click', handleCapture, true);
  document.addEventListener('input', event => {
    if (event.composedPath().includes(host)) return;
    if (state.submitQueue) {
      const player = uniquePlayerForText(event.target?.value);
      if (!player || GameSolver.playerKey(player) !== state.submitQueue.playerKey) {
        clearQueuedSubmit();
        state.status = '已取消排队提交';
        state.lastError = '';
      }
    }
    queueMicrotask(render);
  }, true);

  (async () => {
    const stored = await gmGet(STORAGE_KEY, { colors: {}, arrows: {} });
    if (stored && typeof stored === 'object') {
      state.calibration = {
        colors: stored.colors && typeof stored.colors === 'object' ? stored.colors : {},
        arrows: stored.arrows && typeof stored.arrows === 'object' ? stored.arrows : {},
      };
    }
    const storedLayout = await gmGet(LAYOUT_STORAGE_KEY, null);
    if (storedLayout && typeof storedLayout === 'object') {
      state.layout = {
        x: Number.isFinite(storedLayout.x) ? storedLayout.x : null,
        y: Number.isFinite(storedLayout.y) ? storedLayout.y : null,
        collapsed: Boolean(storedLayout.collapsed),
      };
      setPanelCollapsed(state.layout.collapsed, false);
      if (state.layout.x !== null && state.layout.y !== null) requestAnimationFrame(() => placePanel(state.layout.x, state.layout.y));
    }
    const started = performance.now();
    state.matrix = FribergAutomation.buildFeedbackMatrix(state.players);
    resetSession(`已载入 ${state.players.length} 人严格矩阵（${Math.round(performance.now() - started)} ms）。`);
    startPageListening();
  })().catch(stopWithError);
})();
