(() => {
  'use strict';

  const Solver = globalThis.GameSolver;
  const Adapter = globalThis.FribergLiveDomAdapter;
  const Policy = globalThis.FribergRacePolicy;
  if (!Solver || !Adapter || !Policy || !globalThis.chrome?.runtime) return;

  const FIRST_GUESS = Policy.opening || 'refrezh';
  const MAX_GUESSES = 8;
  const HUD_ID = 'friberg-race-lite-hud';
  const STORAGE_KEY = 'fribergRaceLiteArmedV1';
  const OPTION_SETTLE_TIMEOUT_MS = 700;
  const SUBMIT_RETRY_WINDOW_MS = 650;
  const FALLBACK_TICK_MS = 16;

  const state = {
    armed: false,
    loaded: false,
    players: [],
    byNick: new Map(),
    desiredNick: '',
    desiredKey: '',
    lastPreparedAt: 0,
    lastSubmitAttemptAt: 0,
    submitWindowStartedAt: 0,
    lastCount: null,
    lastRoundToken: '',
    cooldownDeadline: 0,
    observer: null,
    timer: null,
    queued: false,
    busy: false,
    hud: null,
    status: '等待加载',
    detail: '',
    lastCandidateCount: null,
    lastPolicySource: '',
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

  function pageText() {
    let text = document.body?.innerText || '';
    const own = state.hud?.innerText || '';
    if (own) text = text.replace(own, ' ');
    return text.replace(/\s+/g, ' ').trim();
  }

  function currentRoundToken() {
    const match = pageText().match(/第\s*(\d+)\s*局/);
    return match ? `round-${match[1]}` : 'round-unknown';
  }

  function selfBoard() {
    const explicit = Array.from(document.querySelectorAll('.player-board-self'))
      .find(isVisible);
    if (explicit) return explicit.querySelector('table.game-table') || explicit;
    const scan = Adapter.scan(document);
    if (isVisible(scan?.autoBoard?.element)) return scan.autoBoard.element;
    return scan?.boardCandidates?.find(candidate => (
      candidate.ownership === 'self' && isVisible(candidate.element)
    ))?.element || null;
  }

  function ownGuessCount(board = selfBoard()) {
    const explicit = board?.closest('.player-board-self') || board?.parentElement;
    const text = explicit?.innerText || pageText();
    const match = text.match(/(?:我的猜测|我的竞猜|my guesses?)[^0-9]{0,40}(\d+)\s*\/\s*8\b/i);
    const count = Number(match?.[1]);
    if (Number.isInteger(count) && count >= 0 && count <= MAX_GUESSES) return count;
    if (!board) return null;
    const rows = Adapter.feedbackRows(board).filter(row => {
      const cell = row.querySelector('td,th,[role="gridcell"],[role="cell"]') || row.firstElementChild;
      const nick = String(cell?.textContent || '').trim();
      return nick && !/^[•·.\-—]+$/.test(nick);
    });
    return rows.length <= MAX_GUESSES ? rows.length : null;
  }

  function raceSurface() {
    const dock = Array.from(document.querySelectorAll('.input-dock')).find(isVisible)
      || document.querySelector('.input-dock');
    const form = dock?.querySelector('form.input-bar') || document.querySelector('form.input-bar');
    const input = form?.querySelector('input.input[role="combobox"],input[role="combobox"],input.input')
      || document.querySelector('.input-dock input[role="combobox"],form.input-bar input');
    const button = form?.querySelector('button.btn,button[type="submit"],button:not([type])');
    if (!(form instanceof HTMLFormElement) || !(input instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement)) return null;
    return { dock, form, input, button };
  }

  function ensureHud() {
    if (state.hud?.isConnected) return state.hud;
    const host = document.createElement('div');
    host.id = HUD_ID;
    host.style.cssText = [
      'position:fixed', 'left:12px', 'bottom:12px', 'z-index:2147483647',
      'font:12px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace',
      'background:#10292d', 'color:#e8ffef', 'border:1px solid #52e0b4',
      'padding:8px 10px', 'border-radius:6px', 'box-shadow:0 4px 18px #0008',
      'min-width:198px', 'user-select:none',
    ].join(';');
    const status = document.createElement('div');
    status.dataset.raceStatus = 'true';
    status.style.fontWeight = '700';
    const detail = document.createElement('div');
    detail.dataset.raceDetail = 'true';
    detail.style.cssText = 'margin-top:3px;color:#bce9dd;max-width:320px';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.dataset.raceToggle = 'true';
    toggle.style.cssText = 'margin-top:7px;width:100%;background:#d8ff3f;color:#152015;border:0;padding:5px 8px;font-weight:700;cursor:pointer';
    toggle.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      state.armed = !state.armed;
      sessionStorage.setItem(STORAGE_KEY, state.armed ? '1' : '0');
      resetAction(state.armed ? '等待当前小局' : '已停止所有自动操作');
      updateHud();
      schedule();
    });
    host.append(status, detail, toggle);
    document.documentElement.append(host);
    state.hud = host;
    updateHud();
    return host;
  }

  function updateHud(status = state.status, detail = state.detail) {
    state.status = status;
    state.detail = detail;
    const host = ensureHud();
    host.querySelector('[data-race-status]').textContent = status;
    host.querySelector('[data-race-detail]').textContent = detail;
    const toggle = host.querySelector('[data-race-toggle]');
    toggle.textContent = state.armed ? '竞速：开（点击停止）' : '竞速：关（点击开启）';
    toggle.style.background = state.armed ? '#77efcc' : '#d8ff3f';
  }

  function feedbackForRow(row) {
    const read = Adapter.readFeedbackRow(row);
    if (!read.valid) return { valid: false, errors: read.errors };
    const guess = state.byNick.get(normalize(read.nickname));
    if (!guess) return { valid: false, errors: [`题库没有 ${read.nickname}`] };
    const reading = read.reading;
    const feedback = Solver.makeFeedback([
      reading.team,
      reading.country,
      reading.age?.color,
      reading.role,
      reading.majorWins?.color,
      reading.majorAppearances?.color,
      reading.status,
    ], {
      age: reading.age?.direction || 'none',
      majorWins: reading.majorWins?.direction || 'none',
      majorApps: reading.majorAppearances?.direction || 'none',
    });
    const validation = Solver.validateFeedback(feedback);
    return validation.valid
      ? { valid: true, guess, feedback }
      : { valid: false, errors: validation.errors };
  }

  function currentHistory(board, count) {
    const rows = Adapter.feedbackRows(board);
    if (rows.length < count) return null;
    const selected = rows.slice(0, count);
    const history = [];
    const guesses = [];
    for (const row of selected) {
      const result = feedbackForRow(row);
      if (!result.valid) return null;
      history.push(result.feedback);
      guesses.push(result.guess);
    }
    return { history, guesses };
  }

  function raceChoice(history, guesses) {
    const guessedKeys = new Set(guesses.map(Solver.playerKey));
    const candidates = Solver.filterCandidates(state.players, history, guessedKeys);
    const choice = Policy.choose({ Solver, candidates, guessedKeys });
    return { candidates, choice };
  }

  function desiredNickname(board, count) {
    if (count === 0) {
      state.lastCandidateCount = Policy.poolSize;
      state.lastPolicySource = '固定首猜';
      return FIRST_GUESS;
    }
    const parsed = currentHistory(board, count);
    if (!parsed) return '';
    const { candidates, choice } = raceChoice(parsed.history, parsed.guesses);
    state.lastCandidateCount = candidates.length;
    if (!candidates.length) {
      updateHud('反馈与题库不一致', '未提交任何猜测');
      return '';
    }
    state.lastPolicySource = '缓存精确策略';
    return choice?.nick || '';
  }

  function resetAction(reason = '') {
    state.desiredNick = '';
    state.desiredKey = '';
    state.lastPreparedAt = 0;
    state.lastSubmitAttemptAt = 0;
    state.submitWindowStartedAt = 0;
    state.cooldownDeadline = 0;
    if (reason) updateHud(state.armed ? '竞速已开启' : '竞速已关闭', reason);
  }

  function setReactInput(input, value) {
    input.focus({ preventScroll: true });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value })
      : new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function exactOption(nickname) {
    return Array.from(document.querySelectorAll('.input-dock ul.autocomplete-list li[role="option"],ul.autocomplete-list li[role="option"]'))
      .filter(isVisible)
      .filter(element => normalize(element.textContent) === normalize(nickname));
  }

  function selectExactOption(option) {
    return option.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: 1,
    }));
  }

  function cooldownRemainingMs() {
    const text = Array.from(document.querySelectorAll('.guess-input-feedback,[role="status"]'))
      .filter(isVisible)
      .map(element => element.textContent || '')
      .join(' ');
    const match = text.match(/(?:冷却|cooldown)[^0-9]{0,16}(\d+(?:\.\d+)?)\s*(?:秒|s)/i);
    return match ? Math.max(0, Math.round(Number(match[1]) * 1000)) : 0;
  }

  function armCooldownDeadline() {
    const remaining = cooldownRemainingMs();
    if (remaining > 0) state.cooldownDeadline = performance.now() + remaining + 35;
  }

  function prepareDesired(surface, nickname, actionKey) {
    if (state.desiredKey !== actionKey || normalize(state.desiredNick) !== normalize(nickname)) {
      state.desiredKey = actionKey;
      state.desiredNick = nickname;
      state.lastPreparedAt = 0;
      state.lastSubmitAttemptAt = 0;
      state.submitWindowStartedAt = 0;
    }
    if (normalize(surface.input.value) !== normalize(nickname)) {
      setReactInput(surface.input, nickname);
      state.lastPreparedAt = performance.now();
      updateHud(`准备 ${nickname}`, `${state.lastCandidateCount ?? '?'} 候选 · ${state.lastPolicySource}`);
      return false;
    }
    const options = exactOption(nickname);
    if (options.length !== 1) return false;
    if (!state.submitWindowStartedAt) state.submitWindowStartedAt = performance.now();
    const remaining = state.cooldownDeadline ? state.cooldownDeadline - performance.now() : cooldownRemainingMs();
    if (remaining > 8) return false;
    if (performance.now() - state.lastSubmitAttemptAt < 12) return false;
    state.lastSubmitAttemptAt = performance.now();
    selectExactOption(options[0]);
    updateHud(`提交 ${nickname}`, remaining > 0 ? `预计冷却剩余 ${Math.ceil(remaining)}ms` : '已触发原网页提交路径');
    return true;
  }

  function terminalPage() {
    return /(比赛结束|本场比赛结束|最终比分|你赢下了整场比赛|你输掉了整场比赛|match over|match finished)/i.test(pageText());
  }

  function drive() {
    if (state.busy || !state.armed || !state.loaded || !location.pathname.startsWith('/multi/room')) return;
    state.busy = true;
    try {
      if (terminalPage()) {
        state.armed = false;
        sessionStorage.removeItem(STORAGE_KEY);
        resetAction('比赛已结束');
        return;
      }
      const surface = raceSurface();
      const board = selfBoard();
      const count = ownGuessCount(board);
      if (!surface || !board || count === null) {
        updateHud('等待对局界面', '尚未同时发现自己的棋盘与输入栏');
        return;
      }
      const round = currentRoundToken();
      if (state.lastCount !== count || state.lastRoundToken !== round) {
        state.lastCount = count;
        state.lastRoundToken = round;
        resetAction(`${round} · ${count}/8`);
        armCooldownDeadline();
      }
      if (count >= MAX_GUESSES) {
        updateHud('等待本局结束', `${count}/8`);
        return;
      }
      const nickname = desiredNickname(board, count);
      if (!nickname) {
        updateHud('等待完整反馈', `${count}/8 · 当前反馈尚未可安全解析`);
        return;
      }
      const actionKey = `${round}|${count}|${normalize(nickname)}`;
      prepareDesired(surface, nickname, actionKey);
      if (state.submitWindowStartedAt && performance.now() - state.submitWindowStartedAt > SUBMIT_RETRY_WINDOW_MS) {
        state.submitWindowStartedAt = 0;
        setReactInput(surface.input, nickname);
      }
    } finally {
      state.busy = false;
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

  async function loadPlayers() {
    const response = await fetch(chrome.runtime.getURL('data/game-players-646.json'));
    if (!response.ok) throw new Error(`题库读取失败：${response.status}`);
    const raw = await response.json();
    const players = Solver.normalizeGamePlayers(raw).filter(player => player.enabled !== false);
    if (players.length !== Policy.poolSize) throw new Error(`题库数量 ${players.length} 与策略 ${Policy.poolSize} 不一致`);
    state.players = players;
    state.byNick = new Map(players.map(player => [normalize(player.nick), player]));
    state.loaded = true;
    updateHud('竞速引擎已就绪', `${players.length} 人 · 二猜率 41.49%`);
    schedule();
  }

  function boot() {
    state.armed = sessionStorage.getItem(STORAGE_KEY) === '1';
    ensureHud();
    state.observer = new MutationObserver(schedule);
    state.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'disabled', 'aria-disabled', 'aria-selected', 'aria-expanded'],
    });
    document.addEventListener('input', schedule, true);
    document.addEventListener('change', schedule, true);
    document.addEventListener('mousedown', schedule, true);
    document.addEventListener('click', schedule, true);
    state.timer = window.setInterval(() => {
      if (state.armed) drive();
    }, FALLBACK_TICK_MS);
    void loadPlayers().catch(cause => updateHud('竞速引擎加载失败', cause instanceof Error ? cause.message : String(cause)));
  }

  if (document.documentElement) boot();
  else addEventListener('DOMContentLoaded', boot, { once: true });
})();
