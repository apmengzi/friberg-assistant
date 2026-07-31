(() => {
  'use strict';

  const Adapter = globalThis.FribergLiveDomAdapter;
  const Solver = globalThis.GameSolver;
  if (!Adapter || !Solver || !globalThis.chrome?.runtime) return;

  const OVERLAY = '#friberg-assistant-overlay';
  const TICK_MS = 140;
  const ACTION_TIMEOUT_MS = 14000;
  const MULTI_WINDOW_MS = 45 * 60 * 1000;
  const SINGLE_WINDOW_MS = 30 * 60 * 1000;
  const TERMINAL_SINGLE_RE = /(恭喜，猜对了|正确答案|本局结束|congratulations|correct answer|game ended)/i;
  const MATCH_OVER_RE = /(比赛结束|本场比赛结束|最终比分|match over|match finished)/i;

  const state = {
    mode: 'off',
    armedUntil: 0,
    actionKey: '',
    actionStartedAt: 0,
    previousProgress: null,
    roundEpoch: 0,
    matchStarted: false,
    hadPlayableSurface: false,
    fastFirstBusy: false,
    playersPromise: null,
    timer: null,
    lastErrorAtArm: '',
  };

  const normalize = value => typeof Solver.normalize === 'function'
    ? Solver.normalize(value)
    : String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

  function overlay() {
    return document.querySelector(OVERLAY);
  }

  function setOverlay(status, detail = '', error = '') {
    const host = overlay();
    if (!host) return;
    const statusNode = host.querySelector('[data-fa-status]');
    const detailNode = host.querySelector('[data-fa-detail]');
    const errorNode = host.querySelector('[data-fa-error]');
    if (statusNode && status) statusNode.textContent = status;
    if (detailNode && detail) detailNode.textContent = detail;
    if (errorNode) errorNode.textContent = error;
  }

  function baseButton(action) {
    return overlay()?.querySelector(`[data-fa-action="${action}"]`) || null;
  }

  function qolButton(action) {
    return overlay()?.querySelector(`[data-fa-qol-action="${action}"]`) || null;
  }

  function routeKind() {
    if (location.pathname.startsWith('/single')) return 'single';
    if (location.pathname.startsWith('/multi')) return 'multi';
    return 'other';
  }

  function visibleText() {
    let text = document.body?.innerText || '';
    const own = overlay()?.innerText || '';
    if (own) text = text.replace(own, ' ');
    return text.replace(/\s+/g, ' ').trim();
  }

  function multiGuessCount() {
    const text = visibleText();
    const match = text.match(/(?:我的猜测|我的竞猜|my guesses?)[^0-9]{0,40}(\d+)\s*\/\s*8\b/i);
    const count = Number(match?.[1]);
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

    const board = Array.from(document.querySelectorAll('.single-game-board,.guess-board,table.game-table'))
      .find(isVisible);
    if (!board) return 0;
    const rows = Adapter.feedbackRows(board);
    return rows.length <= 8 ? rows.length : null;
  }

  function guessCount() {
    return routeKind() === 'single' ? singleGuessCount() : multiGuessCount();
  }

  function roundMarker() {
    if (routeKind() === 'single') return `single-${state.roundEpoch}`;
    const match = visibleText().match(/第\s*(\d+)\s*局/);
    return match ? `multi-${match[1]}` : `multi-${state.roundEpoch}`;
  }

  function currentRecommendation() {
    const text = overlay()?.querySelector('[data-fa-next]')?.textContent?.trim() || '';
    if (!text || /^(等待反馈|最新反馈待识别|—)$/.test(text)) return '';
    return text.split('·')[0].trim();
  }

  function currentError() {
    return overlay()?.querySelector('[data-fa-error]')?.textContent?.trim() || '';
  }

  function hasBoundBoard() {
    const text = overlay()?.querySelector('[data-fa-board]')?.textContent || '';
    return /已绑定|已发现/.test(text);
  }

  function uniqueSelectableBoard() {
    const scan = Adapter.scan(document);
    const candidates = (scan.boardCandidates || []).filter(candidate => candidate.ownership !== 'opponent');
    return candidates.length === 1 ? candidates[0] : null;
  }

  async function bindSingleBoardIfUnique() {
    if (routeKind() !== 'single' || hasBoundBoard()) return true;
    const candidate = uniqueSelectableBoard();
    if (!candidate) return false;
    const choose = baseButton('board');
    if (!choose || choose.disabled) return false;
    choose.click();
    await sleep(0);
    candidate.element.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window,
    }));
    await sleep(30);
    return hasBoundBoard();
  }

  function resetActionTracking() {
    state.actionKey = '';
    state.actionStartedAt = 0;
  }

  function disarm(reason, error = '') {
    state.mode = 'off';
    state.armedUntil = 0;
    state.matchStarted = false;
    state.hadPlayableSurface = false;
    state.previousProgress = null;
    resetActionTracking();
    updateControl();
    if (reason) setOverlay('托管已停止', reason, error);
  }

  function ensureAutoReadyArmed() {
    const button = qolButton('auto-ready');
    if (!button || button.disabled || state.matchStarted) return;
    if (/：关/.test(button.textContent || '')) button.click();
  }

  function arm(mode) {
    state.mode = mode;
    state.armedUntil = Date.now() + (mode === 'single' ? SINGLE_WINDOW_MS : MULTI_WINDOW_MS);
    state.matchStarted = false;
    state.hadPlayableSurface = false;
    state.previousProgress = null;
    state.roundEpoch += 1;
    state.lastErrorAtArm = currentError();
    resetActionTracking();
    if (mode === 'multi') ensureAutoReadyArmed();
    updateControl();
    setOverlay(
      mode === 'single' ? '单人本局全自动已开启' : '本次匹配托管已开启',
      mode === 'single'
        ? '将自动首猜、读取可见反馈并提交后续推荐；胜负、异常或离开页面时自动停止。'
        : '将自动准备、首猜、读取反馈并完成整个 BO3；异常或离开房间时立即停止。',
      '',
    );
  }

  function controlLabel() {
    if (state.mode === 'single') return '单人本局全自动：开（点击停止）';
    if (state.mode === 'multi') return '本次匹配托管：开（点击停止）';
    return routeKind() === 'single' ? '单人本局全自动：关' : '本次匹配托管：关';
  }

  function ensureControl() {
    const host = overlay();
    const actions = host?.querySelector('.fa-actions');
    if (!actions) return null;
    let button = actions.querySelector('[data-fa-autoplay-action="toggle"]');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'fa-autoplay';
      button.dataset.faAutoplayAction = 'toggle';
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (state.mode !== 'off') {
          disarm('已按你的点击取消自动托管。');
          return;
        }
        const kind = routeKind();
        if (kind === 'single') arm('single');
        else if (kind === 'multi') arm('multi');
        else setOverlay('当前页面不支持托管', '请进入弗一把单人模式或多人模式。');
      });
      actions.append(button);
    }
    button.hidden = routeKind() === 'other';
    return button;
  }

  function updateControl() {
    const button = ensureControl();
    if (!button) return;
    button.textContent = controlLabel();
    button.dataset.armed = String(state.mode !== 'off');
    button.title = state.mode === 'off'
      ? (routeKind() === 'single'
        ? '仅自动完成当前单人对局；默认关闭。'
        : '仅托管本次匹配与当前 BO3；默认关闭。')
      : '点击立即停止自动操作。';
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
          : raw);
    }
    return state.playersPromise;
  }

  async function waitFor(predicate, timeoutMs = 1000, intervalMs = 20) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await sleep(intervalMs);
    }
    return null;
  }

  async function fastRefrezh() {
    if (state.fastFirstBusy) return false;
    state.fastFirstBusy = true;
    try {
      if (guessCount() !== 0) throw new Error('当前小局不是 0/8，未执行首猜。');
      const players = await loadPlayers();
      const matches = players.filter(player => normalize(player.nick || player.nickname) === 'refrezh');
      if (matches.length !== 1) throw new Error(`题库中 refrezh 匹配 ${matches.length} 人。`);
      const player = matches[0];
      const scan = Adapter.scan(document);
      const input = scan.inputCandidates?.[0]?.element;
      if (!input) throw new Error('没有发现可写入的选手搜索框。');

      setOverlay('正在首猜 refrezh', '正在直接填入并进入现有提交/CD队列。', '');
      const result = await Adapter.fillAndSelectUniqueOption({
        input,
        player,
        players,
        documentRef: document,
        timeoutMs: 900,
      });
      if (result.status !== 'selected') throw new Error(result.message || '未能唯一选择 refrezh。');

      const submit = await waitFor(() => {
        const button = baseButton('submit');
        return button && !button.disabled ? button : null;
      }, 900);
      if (!submit) throw new Error('refrezh 已填入，但提交按钮未及时就绪。');
      submit.click();
      setOverlay('refrezh 已进入提交队列', '网页有猜测 CD 时会等待，满足条件后只提交一次。', '');
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setOverlay('首猜 refrezh 已停止', '没有执行不确定的提交。', message);
      return false;
    } finally {
      state.fastFirstBusy = false;
    }
  }

  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-fa-qol-action="refrezh-first"]');
    if (!button || button.disabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void fastRefrezh();
  }, true);

  function terminalSinglePage() {
    if (routeKind() !== 'single') return false;
    const modal = Array.from(document.querySelectorAll('[aria-modal="true"],.answer-overlay,.modal'))
      .find(isVisible);
    return Boolean(modal && TERMINAL_SINGLE_RE.test(modal.innerText || modal.textContent || ''));
  }

  function terminalMultiPage() {
    if (routeKind() !== 'multi') return false;
    return MATCH_OVER_RE.test(visibleText());
  }

  function noteProgress(count) {
    const marker = roundMarker();
    const progress = `${marker}|${count}`;
    if (state.previousProgress !== progress) {
      const previousCount = Number(state.previousProgress?.split('|').at(-1));
      if (count === 0 && Number.isFinite(previousCount) && previousCount > 0) state.roundEpoch += 1;
      state.previousProgress = `${roundMarker()}|${count}`;
      resetActionTracking();
    }
  }

  function beginAction(key, label) {
    state.actionKey = key;
    state.actionStartedAt = Date.now();
    setOverlay(label, '自动托管正在等待网页完成本次提交与反馈。', '');
  }

  async function automatePlayableSurface() {
    const kind = routeKind();
    const count = guessCount();
    if (count === null) return;

    state.hadPlayableSurface = true;
    if (kind === 'multi') state.matchStarted = true;
    noteProgress(count);

    if (kind === 'single' && count > 0 && !hasBoundBoard()) {
      const bound = await bindSingleBoardIfUnique();
      if (!bound) {
        disarm('单人棋盘无法唯一确认，已停止，避免读取或操作错误区域。');
        return;
      }
    }

    if (state.actionKey) {
      if (Date.now() - state.actionStartedAt > ACTION_TIMEOUT_MS) {
        disarm('自动操作超过 14 秒仍未看到猜测进度变化。', '可能是下拉项、提交按钮、网络请求或网页结构发生变化。');
      }
      return;
    }

    if (count >= 8) return;

    if (count === 0) {
      const first = qolButton('refrezh-first');
      if (!first || first.disabled) return;
      beginAction(`${roundMarker()}|first`, '正在自动首猜 refrezh');
      first.click();
      return;
    }

    const combined = qolButton('fill-submit');
    const recommendation = currentRecommendation();
    if (!combined || combined.disabled || !recommendation) return;
    beginAction(`${roundMarker()}|${count}|${normalize(recommendation)}`, `正在自动提交 ${recommendation}`);
    combined.click();
  }

  function detectActionFailure() {
    if (!state.actionKey || Date.now() - state.actionStartedAt < 500) return false;
    const error = currentError();
    if (!error || error === state.lastErrorAtArm) return false;
    if (/未发现|无法|失败|停止|不唯一|超时|变化|错误/.test(error)) {
      disarm('插件报告了无法安全继续的页面状态。', error);
      return true;
    }
    return false;
  }

  function tick() {
    updateControl();
    if (state.mode === 'off') return;
    if (Date.now() >= state.armedUntil) {
      disarm('本次托管授权已自动过期。');
      return;
    }

    const kind = routeKind();
    if (state.mode === 'single' && kind !== 'single') {
      disarm('已离开单人模式页面。');
      return;
    }
    if (state.mode === 'multi' && kind !== 'multi') {
      disarm('已离开多人模式页面。');
      return;
    }

    if (detectActionFailure()) return;

    if (state.mode === 'single') {
      if (terminalSinglePage()) {
        disarm('当前单人对局已经结束。');
        return;
      }
      void automatePlayableSurface();
      return;
    }

    if (!state.matchStarted) ensureAutoReadyArmed();
    if (terminalMultiPage()) {
      disarm('当前多人比赛已经结束。');
      return;
    }
    if (location.pathname.startsWith('/multi/room')) {
      void automatePlayableSurface();
      return;
    }
    if (state.matchStarted && state.hadPlayableSurface) {
      disarm('已离开本次多人房间。');
    }
  }

  clearInterval(state.timer);
  state.timer = setInterval(tick, TICK_MS);
  updateControl();
})();
