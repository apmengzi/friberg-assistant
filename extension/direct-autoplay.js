(() => {
  'use strict';

  const Adapter = globalThis.FribergLiveDomAdapter;
  const Solver = globalThis.GameSolver;
  if (!Adapter || !Solver || !globalThis.chrome?.runtime) return;

  const OVERLAY = '#friberg-assistant-overlay';
  const FIRST_GUESS = 'refrezh';
  const SINGLE_NORMAL_ROUTE = '/single/normal';
  const FALLBACK_MS = 16;
  const SELECT_TIMEOUT_MS = 500;
  const ACTION_TIMEOUT_MS = 8000;
  const MULTI_WINDOW_MS = 45 * 60 * 1000;
  const SINGLE_WINDOW_MS = 30 * 60 * 1000;
  const MATCH_OVER_RE = /(比赛结束|本场比赛结束|最终比分|match over|match finished)/i;
  const SINGLE_OVER_RE = /(恭喜，猜对了|正确答案|本局结束|很遗憾|congratulations|correct answer|game ended)/i;
  const AGAIN_RE = /^(再来一把|再来一局|再玩一局|again|play again)$/i;
  const WAITING_RE = /^(等待反馈|最新反馈待识别|—)$/;

  const state = {
    mode: 'off',
    armedUntil: 0,
    roundEpoch: 0,
    progressKey: '',
    progressCount: null,
    recommendationAtProgressStart: '',
    action: null,
    running: false,
    rerun: false,
    queued: false,
    timer: null,
    observer: null,
    playersPromise: null,
    playerByNick: null,
    loopArmed: false,
    loopCompleted: 0,
    loopRestarting: false,
    loopRestartAt: 0,
    matchStarted: false,
    hadPlayableSurface: false,
  };

  const normalize = value => typeof Solver.normalize === 'function'
    ? Solver.normalize(value)
    : String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && rect.width > 0
      && rect.height > 0;
  }

  function host() {
    return document.querySelector(OVERLAY);
  }

  function setOverlay(status, detail = '', error = '') {
    const root = host();
    if (!root) return;
    if (status) root.querySelector('[data-fa-status]')?.replaceChildren(document.createTextNode(status));
    if (detail) root.querySelector('[data-fa-detail]')?.replaceChildren(document.createTextNode(detail));
    const errorNode = root.querySelector('[data-fa-error]');
    if (errorNode) errorNode.textContent = error;
  }

  function routeKind() {
    if (location.pathname.startsWith('/single')) return 'single';
    if (location.pathname.startsWith('/multi')) return 'multi';
    return 'other';
  }

  function directInput() {
    const selectors = [
      '.input-dock form.input-bar input:not([type="hidden"]):not([type="password"])',
      'form.input-bar input:not([type="hidden"]):not([type="password"])',
      '.player-search-content input:not([type="hidden"]):not([type="password"])',
      'input[placeholder*="选手"]:not([type="hidden"]):not([type="password"])',
      'input[placeholder*="player" i]:not([type="hidden"]):not([type="password"])',
    ];
    for (const selector of selectors) {
      const found = Array.from(document.querySelectorAll(selector))
        .find(element => isVisible(element) && !element.closest(OVERLAY));
      if (found) return found;
    }
    try {
      return Adapter.scan(document).inputCandidates?.find(candidate => isVisible(candidate.element))?.element || null;
    } catch {
      return null;
    }
  }

  function directSubmitButton(input) {
    const form = input?.form || input?.closest('form');
    if (!form) return null;
    const buttons = Array.from(form.querySelectorAll('button,[role="button"]')).filter(isVisible);
    const exact = buttons.filter(button => /^(提交猜测|提交|submit guess|submit)$/i.test(
      String(button.innerText || button.textContent || '').replace(/\s+/g, ' ').trim(),
    ));
    if (exact.length === 1) return exact[0];
    const submit = buttons.filter(button => button.type === 'submit');
    return submit.length === 1 ? submit[0] : null;
  }

  function multiGuessCount() {
    const selfTitle = Array.from(document.querySelectorAll('.player-board-self h1,.player-board-self h2,.player-board-self h3,.player-board-self h4'))
      .find(isVisible);
    const direct = String(selfTitle?.innerText || selfTitle?.textContent || '').match(/(\d+)\s*\/\s*8\b/);
    if (direct) return Number(direct[1]);
    const text = String(document.querySelector('.player-board-self')?.innerText || '');
    const fallback = text.match(/(?:我的猜测|我的竞猜|my guesses?)[^0-9]{0,40}(\d+)\s*\/\s*8\b/i);
    const count = Number(fallback?.[1]);
    return Number.isInteger(count) && count >= 0 && count <= 8 ? count : null;
  }

  function singleGuessCount() {
    const groups = Array.from(document.querySelectorAll('.guess-progress')).filter(isVisible);
    for (const group of groups) {
      const dots = Array.from(group.querySelectorAll('i'));
      if (!dots.length) continue;
      const used = dots.filter(dot => dot.classList.contains('used')).length;
      if (used >= 0 && used <= dots.length && dots.length <= 12) return used;
    }
    const board = Array.from(document.querySelectorAll('.single-game-board,.guess-board,table.game-table')).find(isVisible);
    if (!board) return directInput() ? 0 : null;
    const rows = Adapter.feedbackRows(board);
    return rows.length <= 8 ? rows.length : null;
  }

  function guessCount() {
    return routeKind() === 'single' ? singleGuessCount() : multiGuessCount();
  }

  function roundMarker() {
    if (routeKind() === 'single') return `single-${state.roundEpoch}`;
    const status = String(document.querySelector('.status-bar')?.innerText || document.body?.innerText || '');
    const match = status.match(/第\s*(\d+)\s*局/);
    return match ? `multi-${match[1]}` : `multi-${state.roundEpoch}`;
  }

  function currentRecommendation() {
    const text = host()?.querySelector('[data-fa-next]')?.textContent?.trim() || '';
    if (!text || WAITING_RE.test(text)) return '';
    const nick = text.split('·')[0].trim();
    return WAITING_RE.test(nick) ? '' : nick;
  }

  function assistantProcessed(count) {
    const root = host();
    const status = root?.querySelector('[data-fa-status]')?.textContent || '';
    const detail = root?.querySelector('[data-fa-detail]')?.textContent || '';
    return /已读取自己的新反馈/.test(status)
      || new RegExp(`已合并\\s*${count}\\s*次可见猜测`).test(detail)
      || /严格候选归零/.test(detail);
  }

  function guessedNicknames() {
    const selectors = routeKind() === 'single'
      ? '.single-game-board tbody tr td:first-child,.single-game-board [role="row"] [role="cell"]:first-child'
      : '.player-board-self tbody tr td:first-child,.player-board-self [role="row"] [role="cell"]:first-child';
    return new Set(Array.from(document.querySelectorAll(selectors))
      .filter(isVisible)
      .map(cell => normalize(cell.innerText || cell.textContent || ''))
      .filter(Boolean));
  }

  function terminalSingleDialog() {
    if (routeKind() !== 'single') return null;
    return Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"],.answer-overlay,.overlay-card,.modal'))
      .filter(isVisible)
      .filter(element => !element.closest(OVERLAY))
      .find(element => SINGLE_OVER_RE.test(element.innerText || element.textContent || '')) || null;
  }

  function terminalMultiPage() {
    if (routeKind() !== 'multi') return false;
    const text = String(document.body?.innerText || '').replace(host()?.innerText || '', ' ');
    return MATCH_OVER_RE.test(text);
  }

  async function loadPlayers() {
    if (!state.playersPromise) {
      state.playersPromise = fetch(chrome.runtime.getURL('data/game-players-646.json'))
        .then(response => {
          if (!response.ok) throw new Error(`题库读取失败：${response.status}`);
          return response.json();
        })
        .then(raw => typeof Solver.normalizeGamePlayers === 'function'
          ? Solver.normalizeGamePlayers(raw).filter(player => player.enabled !== false)
          : raw)
        .then(players => {
          const map = new Map();
          players.forEach(player => {
            const key = normalize(player.nick || player.nickname);
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(player);
          });
          state.playerByNick = map;
          return players;
        });
    }
    return state.playersPromise;
  }

  async function uniquePlayer(nickname) {
    const players = await loadPlayers();
    const matches = state.playerByNick?.get(normalize(nickname)) || [];
    if (matches.length !== 1) throw new Error(`题库中 ${nickname} 匹配 ${matches.length} 人。`);
    return { player: matches[0], players };
  }

  function clearAction() {
    state.action = null;
  }

  function noteProgress(count) {
    const key = `${roundMarker()}|${count}`;
    if (key === state.progressKey) return false;
    const oldCount = state.progressCount;
    if (count === 0 && Number.isInteger(oldCount) && oldCount > 0) state.roundEpoch += 1;
    state.progressCount = count;
    state.progressKey = `${roundMarker()}|${count}`;
    state.recommendationAtProgressStart = currentRecommendation();
    clearAction();
    return true;
  }

  function controlButton() {
    return host()?.querySelector('[data-fa-autoplay-action="toggle"]') || null;
  }

  function loopButton() {
    return host()?.querySelector('[data-fa-single-loop-action="toggle"]') || null;
  }

  function updateControls() {
    const root = host();
    const actions = root?.querySelector('.fa-actions');
    if (!actions) return;

    let autoplay = controlButton();
    if (!autoplay) {
      autoplay = document.createElement('button');
      autoplay.type = 'button';
      autoplay.className = 'fa-autoplay';
      autoplay.dataset.faAutoplayAction = 'toggle';
      autoplay.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (state.mode !== 'off') stop('已按你的点击停止自动托管。');
        else arm(routeKind());
      });
      actions.append(autoplay);
    }

    autoplay.hidden = routeKind() === 'other';
    autoplay.dataset.armed = String(state.mode !== 'off');
    autoplay.textContent = state.mode === 'single'
      ? '单人本局全自动：开（点击停止）'
      : state.mode === 'multi'
        ? '本次匹配托管：开（点击停止）'
        : routeKind() === 'single'
          ? '单人本局全自动：关'
          : '本次匹配托管：关';

    let loop = loopButton();
    if (!loop) {
      loop = document.createElement('button');
      loop.type = 'button';
      loop.className = 'fa-autoplay fa-single-loop';
      loop.dataset.faSingleLoopAction = 'toggle';
      loop.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (state.loopArmed) {
          state.loopArmed = false;
          if (state.mode === 'single') stop('已停止单人完整版循环。');
        } else if (location.pathname === SINGLE_NORMAL_ROUTE || location.pathname.startsWith(`${SINGLE_NORMAL_ROUTE}/`)) {
          state.loopArmed = true;
          state.loopCompleted = 0;
          arm('single');
        } else {
          setOverlay('当前页面不是单人完整版', '请进入“单人 · 完整版”的实际对局后再开启。');
        }
      });
      actions.append(loop);
    }
    loop.hidden = routeKind() !== 'single';
    loop.disabled = routeKind() === 'single'
      && !(location.pathname === SINGLE_NORMAL_ROUTE || location.pathname.startsWith(`${SINGLE_NORMAL_ROUTE}/`));
    loop.dataset.armed = String(state.loopArmed);
    loop.textContent = state.loopArmed
      ? `单人完整版循环：开 · 已完成 ${state.loopCompleted} 局（点击停止）`
      : '单人完整版循环：关';
  }

  function ensureAutoReady() {
    if (state.mode !== 'multi' || state.matchStarted) return;
    const button = host()?.querySelector('[data-fa-qol-action="auto-ready"]');
    if (button && !button.disabled && /：关/.test(button.textContent || '')) button.click();
  }

  function arm(kind) {
    if (kind !== 'single' && kind !== 'multi') {
      setOverlay('当前页面不支持托管', '请进入弗一把单人或多人模式。');
      return;
    }
    state.mode = kind;
    state.armedUntil = Date.now() + (kind === 'single' ? SINGLE_WINDOW_MS : MULTI_WINDOW_MS);
    state.progressKey = '';
    state.progressCount = null;
    state.recommendationAtProgressStart = '';
    state.matchStarted = false;
    state.hadPlayableSurface = false;
    clearAction();
    void loadPlayers();
    if (kind === 'multi') ensureAutoReady();
    updateControls();
    setOverlay(
      kind === 'single' ? '单人本局全自动已开启' : '本次匹配托管已开启',
      '0/8 永远只提交 refrezh；反馈一出现就立即填入下一猜，冷却结束的第一刻直接提交。',
      '',
    );
    schedule();
  }

  function stop(reason = '', error = '') {
    const wasMulti = state.mode === 'multi';
    state.mode = 'off';
    state.armedUntil = 0;
    state.progressKey = '';
    state.progressCount = null;
    state.matchStarted = false;
    state.hadPlayableSurface = false;
    clearAction();
    if (wasMulti) {
      const ready = host()?.querySelector('[data-fa-qol-action="auto-ready"]');
      if (ready && !/：关/.test(ready.textContent || '')) ready.click();
    }
    updateControls();
    if (reason) setOverlay('托管已停止', reason, error);
  }

  async function bindSingleBoard() {
    if (routeKind() !== 'single' || state.progressCount === 0) return true;
    const boardText = host()?.querySelector('[data-fa-board]')?.textContent || '';
    if (/已绑定|已发现/.test(boardText)) return true;
    const scan = Adapter.scan(document);
    const candidates = (scan.boardCandidates || [])
      .filter(candidate => candidate.ownership !== 'opponent' && isVisible(candidate.element));
    if (candidates.length !== 1) return false;
    const choose = host()?.querySelector('[data-fa-action="board"]');
    if (!choose || choose.disabled) return false;
    choose.click();
    candidates[0].element.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window,
    }));
    return false;
  }

  async function beginFill(nickname, count) {
    const key = `${state.progressKey}|${normalize(nickname)}`;
    if (state.action?.key === key) return;
    state.action = {
      key,
      nickname,
      count,
      phase: 'filling',
      startedAt: performance.now(),
      selectedAt: 0,
      submittedAt: 0,
    };

    try {
      const { player, players } = await uniquePlayer(nickname);
      if (!state.action || state.action.key !== key || guessCount() !== count) return;
      const input = directInput();
      if (!input) {
        clearAction();
        schedule();
        return;
      }
      const result = await Adapter.fillAndSelectUniqueOption({
        input,
        player,
        players,
        documentRef: document,
        timeoutMs: SELECT_TIMEOUT_MS,
      });
      if (!state.action || state.action.key !== key || guessCount() !== count) return;
      if (result.status !== 'selected') {
        clearAction();
        setOverlay('正在重试填入', `${nickname} 的下拉项尚未唯一出现；下一次页面变化会立即重试。`, '');
        schedule();
        return;
      }
      state.action.phase = 'selected';
      state.action.selectedAt = performance.now();
      setOverlay(
        count === 0 ? `首猜 ${nickname} 已填入` : `下一猜 ${nickname} 已填入`,
        '已提前完成输入和下拉选择；正在等待网页提交按钮合法启用。',
        '',
      );
      trySubmit();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      clearAction();
      setOverlay('自动填入失败', '下一次页面变化会重试，没有改用其他首猜。', message);
      schedule();
    }
  }

  function trySubmit() {
    const action = state.action;
    if (!action || action.phase !== 'selected') return false;
    if (guessCount() !== action.count) return false;
    const input = directInput();
    if (!input) return false;
    if (normalize(input.value) !== normalize(action.nickname)) {
      clearAction();
      schedule();
      return false;
    }
    const button = directSubmitButton(input);
    if (!button) return false;
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') return false;

    action.phase = 'submitting';
    action.submittedAt = performance.now();
    button.click();
    action.phase = 'submitted';
    setOverlay(
      `已提交 ${action.nickname}`,
      `本地填入至提交耗时 ${Math.max(0, Math.round(action.submittedAt - action.startedAt))} ms；正在等待网页反馈。`,
      '',
    );
    return true;
  }

  function desiredNickname(count) {
    if (count === 0) return FIRST_GUESS;
    const next = currentRecommendation();
    if (!next) return '';
    const processed = assistantProcessed(count);
    const changed = normalize(next) !== normalize(state.recommendationAtProgressStart);
    if (!processed && !changed) return '';
    if (guessedNicknames().has(normalize(next))) return '';
    return next;
  }

  function driveSingleLoop() {
    if (!state.loopArmed) return false;
    if (!(location.pathname === SINGLE_NORMAL_ROUTE || location.pathname.startsWith(`${SINGLE_NORMAL_ROUTE}/`))) {
      state.loopArmed = false;
      stop('已离开单人完整版页面。');
      return true;
    }
    const dialog = terminalSingleDialog();
    if (!dialog) return false;
    if (!state.loopRestarting) {
      state.loopCompleted += 1;
      state.loopRestarting = true;
      state.loopRestartAt = performance.now();
      updateControls();
      const buttons = Array.from(dialog.querySelectorAll('button')).filter(isVisible);
      const again = buttons.filter(button => AGAIN_RE.test(
        String(button.innerText || button.textContent || '').replace(/\s+/g, ' ').trim(),
      ));
      if (again.length !== 1) {
        state.loopArmed = false;
        stop('结算窗口中没有唯一“再来一把”按钮。');
        return true;
      }
      again[0].click();
      state.roundEpoch += 1;
      state.progressKey = '';
      state.progressCount = null;
      clearAction();
      requestAnimationFrame(() => {
        state.loopRestarting = false;
        schedule();
      });
    }
    return true;
  }

  async function drive() {
    updateControls();
    if (state.mode === 'off') return;
    if (Date.now() >= state.armedUntil) {
      stop('本次托管授权已到期。');
      return;
    }

    const kind = routeKind();
    if (state.mode !== kind) {
      if (state.mode === 'multi' && kind === 'multi') return;
      stop('已离开当前托管模式页面。');
      return;
    }

    if (kind === 'single' && driveSingleLoop()) return;
    if (kind === 'single' && terminalSingleDialog()) {
      stop('当前单人对局已经结束。');
      return;
    }
    if (kind === 'multi' && terminalMultiPage()) {
      stop('当前多人比赛已经结束。');
      return;
    }

    if (kind === 'multi' && !location.pathname.startsWith('/multi/room')) {
      ensureAutoReady();
      return;
    }

    const count = guessCount();
    if (!Number.isInteger(count)) return;
    state.hadPlayableSurface = true;
    if (kind === 'multi') state.matchStarted = true;
    noteProgress(count);

    if (kind === 'single' && count > 0 && !await bindSingleBoard()) return;
    if (count >= 8) return;

    if (state.action) {
      if (state.action.phase === 'selected') trySubmit();
      if (
        state.action.phase === 'submitted'
        && performance.now() - state.action.submittedAt > ACTION_TIMEOUT_MS
        && guessCount() === state.action.count
      ) {
        stop('提交后 8 秒仍未看到猜测次数变化。', `最后提交：${state.action.nickname}`);
      }
      return;
    }

    const nickname = desiredNickname(count);
    if (!nickname) return;
    void beginFill(nickname, count);
  }

  async function runScheduled() {
    if (state.running) {
      state.rerun = true;
      return;
    }
    state.running = true;
    try {
      do {
        state.rerun = false;
        await drive();
      } while (state.rerun);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setOverlay('自动托管运行异常', '已保留当前页面，不会改猜其他首猜。', message);
    } finally {
      state.running = false;
    }
  }

  function schedule() {
    if (state.queued) return;
    state.queued = true;
    queueMicrotask(() => {
      requestAnimationFrame(() => {
        state.queued = false;
        void runScheduled();
      });
    });
  }

  state.observer = new MutationObserver(schedule);
  state.observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'disabled', 'aria-disabled', 'data-armed'],
  });
  document.addEventListener('input', schedule, true);
  document.addEventListener('change', schedule, true);
  document.addEventListener('click', schedule, true);
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('popstate', schedule);

  clearInterval(state.timer);
  state.timer = window.setInterval(() => {
    if (state.mode !== 'off' || state.loopArmed) schedule();
  }, FALLBACK_MS);

  void loadPlayers();
  updateControls();
  schedule();
})();
