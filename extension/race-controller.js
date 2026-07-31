(() => {
  'use strict';

  const Solver = globalThis.GameSolver;
  const Adapter = globalThis.FribergLiveDomAdapter;
  const Policy = globalThis.FribergRacePolicy;
  if (!Solver || !Adapter || !Policy || !globalThis.chrome?.runtime) return;

  const FIRST = Policy.opening || 'refrezh';
  const STORAGE_KEY = 'fribergRaceLiteArmedV1';
  const HUD_ID = 'friberg-race-lite-hud';
  const FALLBACK_MS = 16;
  const RETRY_MS = 8;
  const ESTIMATED_COOLDOWN_MS = 1470;

  const state = {
    armed: sessionStorage.getItem(STORAGE_KEY) === '1',
    ready: false,
    players: [],
    byNick: new Map(),
    lastCount: null,
    lastRound: '',
    desired: '',
    actionKey: '',
    cooldownAt: 0,
    lastAttemptAt: 0,
    candidateCount: null,
    observer: null,
    timer: null,
    queued: false,
    driving: false,
    hud: null,
  };

  const normalize = value => Solver.normalize
    ? Solver.normalize(value)
    : String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

  function visible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
  }

  function pageText() {
    let text = document.body?.innerText || '';
    const own = state.hud?.innerText || '';
    if (own) text = text.replace(own, ' ');
    return text.replace(/\s+/g, ' ').trim();
  }

  function roundToken() {
    const match = pageText().match(/第\s*(\d+)\s*局/);
    return match ? `R${match[1]}` : 'R?';
  }

  function selfBoard() {
    const card = Array.from(document.querySelectorAll('.player-board-self')).find(visible);
    if (card) return card.querySelector('table.game-table') || card;
    const scan = Adapter.scan(document);
    if (visible(scan?.autoBoard?.element)) return scan.autoBoard.element;
    return scan?.boardCandidates?.find(item => item.ownership === 'self' && visible(item.element))?.element || null;
  }

  function guessCount(board) {
    const card = board?.closest('.player-board-self') || board?.parentElement;
    const match = String(card?.innerText || '').match(/(?:我的猜测|我的竞猜|my guesses?)[^0-9]{0,40}(\d+)\s*\/\s*8\b/i);
    const count = Number(match?.[1]);
    if (Number.isInteger(count) && count >= 0 && count <= 8) return count;
    if (!board) return null;
    const rows = Adapter.feedbackRows(board).filter(row => {
      const first = row.querySelector('td,th,[role="gridcell"],[role="cell"]') || row.firstElementChild;
      const nick = String(first?.textContent || '').trim();
      return nick && !/^[•·.\-—]+$/.test(nick);
    });
    return rows.length <= 8 ? rows.length : null;
  }

  function surface() {
    const form = Array.from(document.querySelectorAll('.input-dock form.input-bar,form.input-bar')).find(visible);
    const input = form?.querySelector('input[role="combobox"],input.input');
    if (!(form instanceof HTMLFormElement) || !(input instanceof HTMLInputElement)) return null;
    return { form, input };
  }

  function setHud(status, detail = '') {
    const hud = ensureHud();
    const statusNode = hud.querySelector('[data-race-status]');
    const detailNode = hud.querySelector('[data-race-detail]');
    const toggle = hud.querySelector('[data-race-toggle]');
    if (statusNode.textContent !== status) statusNode.textContent = status;
    if (detailNode.textContent !== detail) detailNode.textContent = detail;
    const label = state.armed ? '竞速：开（点击停止）' : '竞速：关（点击开启）';
    if (toggle.textContent !== label) toggle.textContent = label;
    toggle.style.background = state.armed ? '#77efcc' : '#d8ff3f';
  }

  function ensureHud() {
    if (state.hud?.isConnected) return state.hud;
    const hud = document.createElement('div');
    hud.id = HUD_ID;
    hud.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483647;min-width:190px;padding:7px 9px;border:1px solid #52e0b4;border-radius:5px;background:#10292d;color:#e8ffef;box-shadow:0 4px 16px #0008;font:12px/1.35 Consolas,monospace;user-select:none';
    const status = document.createElement('div');
    status.dataset.raceStatus = '1';
    status.style.fontWeight = '700';
    const detail = document.createElement('div');
    detail.dataset.raceDetail = '1';
    detail.style.cssText = 'margin-top:2px;color:#bce9dd';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.dataset.raceToggle = '1';
    toggle.style.cssText = 'margin-top:6px;width:100%;padding:5px;border:0;font-weight:700;cursor:pointer;color:#152015';
    toggle.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      state.armed = !state.armed;
      sessionStorage.setItem(STORAGE_KEY, state.armed ? '1' : '0');
      resetAction();
      setHud(state.armed ? '竞速已开启' : '竞速已关闭', state.armed ? '等待多人房间' : '不会操作网页');
      schedule();
    });
    hud.append(status, detail, toggle);
    document.documentElement.append(hud);
    state.hud = hud;
    return hud;
  }

  function rowFeedback(row) {
    const read = Adapter.readFeedbackRow(row);
    if (!read.valid) return null;
    const guess = state.byNick.get(normalize(read.nickname));
    if (!guess) return null;
    const r = read.reading;
    const feedback = Solver.buildFeedback(guess, [
      r.team,
      r.country,
      r.age?.color,
      r.role,
      r.majorWins?.color,
      r.majorAppearances?.color,
      r.status,
    ], {
      age: r.age?.direction || 'none',
      majorWins: r.majorWins?.direction || 'none',
      majorApps: r.majorAppearances?.direction || 'none',
    });
    return Solver.validateFeedback(feedback).valid ? { guess, feedback } : null;
  }

  function history(board, count) {
    const rows = Adapter.feedbackRows(board);
    if (rows.length < count) return null;
    const feedbacks = [];
    const guesses = [];
    for (const row of rows.slice(0, count)) {
      const item = rowFeedback(row);
      if (!item) return null;
      feedbacks.push(item.feedback);
      guesses.push(item.guess);
    }
    return { feedbacks, guesses };
  }

  function nextNickname(board, count) {
    if (count === 0) {
      state.candidateCount = Policy.poolSize;
      return FIRST;
    }
    const parsed = history(board, count);
    if (!parsed) return '';
    const guessedKeys = new Set(parsed.guesses.map(Solver.playerKey));
    const candidates = Solver.filterCandidates(state.players, parsed.feedbacks, guessedKeys);
    state.candidateCount = candidates.length;
    if (!candidates.length) return '';
    return Policy.choose({ Solver, candidates, guessedKeys })?.nick || '';
  }

  function setReactInput(input, nickname) {
    input.focus({ preventScroll: true });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, nickname);
    input.dispatchEvent(typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: nickname })
      : new Event('input', { bubbles: true, composed: true }));
  }

  function exactOptions(nickname) {
    return Array.from(document.querySelectorAll('.input-dock ul.autocomplete-list li[role="option"],ul.autocomplete-list li[role="option"]'))
      .filter(visible)
      .filter(option => normalize(option.textContent) === normalize(nickname));
  }

  function submitThroughReact(option) {
    option.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: 1,
    }));
  }

  function resetAction() {
    state.desired = '';
    state.actionKey = '';
    state.lastAttemptAt = 0;
  }

  function terminal() {
    return /(比赛结束|本场比赛结束|最终比分|你赢下了整场比赛|你输掉了整场比赛|match over|match finished)/i.test(pageText());
  }

  function drive() {
    if (state.driving || !state.armed || !state.ready || !location.pathname.startsWith('/multi/room')) return;
    state.driving = true;
    try {
      if (terminal()) {
        state.armed = false;
        sessionStorage.removeItem(STORAGE_KEY);
        resetAction();
        setHud('比赛已结束', '竞速已自动关闭');
        return;
      }
      const board = selfBoard();
      const controls = surface();
      const count = guessCount(board);
      if (!board || !controls || count === null) {
        setHud('等待对局界面', '需要自己的棋盘和输入栏');
        return;
      }
      const round = roundToken();
      if (state.lastCount !== count || state.lastRound !== round) {
        const countAdvanced = state.lastCount !== null && count > state.lastCount;
        state.lastCount = count;
        state.lastRound = round;
        state.cooldownAt = countAdvanced ? performance.now() + ESTIMATED_COOLDOWN_MS : 0;
        resetAction();
      }
      if (count >= 8) {
        setHud('等待本局结束', `${round} · 8/8`);
        return;
      }
      const nickname = nextNickname(board, count);
      if (!nickname) {
        setHud('等待完整反馈', `${round} · ${count}/8`);
        return;
      }
      const actionKey = `${round}|${count}|${normalize(nickname)}`;
      if (state.actionKey !== actionKey) {
        state.actionKey = actionKey;
        state.desired = nickname;
        state.lastAttemptAt = 0;
      }
      if (normalize(controls.input.value) !== normalize(nickname)) {
        setReactInput(controls.input, nickname);
        setHud(`已预填 ${nickname}`, `${state.candidateCount ?? '?'} 候选 · ${count}/8`);
        return;
      }
      const options = exactOptions(nickname);
      if (options.length !== 1) {
        setHud(`等待唯一选项 ${nickname}`, `${options.length} 个精确项`);
        return;
      }
      const remaining = state.cooldownAt - performance.now();
      if (remaining > 0) {
        setHud(`已预填 ${nickname}`, `冷却约 ${Math.ceil(remaining)}ms`);
        return;
      }
      if (performance.now() - state.lastAttemptAt < RETRY_MS) return;
      state.lastAttemptAt = performance.now();
      submitThroughReact(options[0]);
      setHud(`提交 ${nickname}`, '已触发原网页 onMouseDown → onPick');
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

  async function load() {
    const response = await fetch(chrome.runtime.getURL('data/game-players-646.json'));
    if (!response.ok) throw new Error(`题库读取失败：${response.status}`);
    const players = Solver.normalizeGamePlayers(await response.json()).filter(player => player.enabled !== false);
    if (players.length !== Policy.poolSize) throw new Error(`题库数量 ${players.length} 与策略 ${Policy.poolSize} 不一致`);
    state.players = players;
    state.byNick = new Map(players.map(player => [normalize(player.nick), player]));
    state.ready = true;
    setHud('竞速引擎已就绪', `${players.length} 人 · 二猜理论率 41.49%`);
    schedule();
  }

  function boot() {
    ensureHud();
    setHud('正在加载竞速引擎', '只加载多人竞速所需模块');
    state.observer = new MutationObserver(records => {
      if (records.every(record => state.hud?.contains(record.target))) return;
      schedule();
    });
    state.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'disabled', 'aria-disabled', 'aria-selected', 'aria-expanded'],
    });
    document.addEventListener('input', schedule, true);
    document.addEventListener('mousedown', schedule, true);
    state.timer = window.setInterval(() => { if (state.armed) drive(); }, FALLBACK_MS);
    void load().catch(error => setHud('竞速引擎加载失败', error instanceof Error ? error.message : String(error)));
  }

  if (document.documentElement) boot();
  else addEventListener('DOMContentLoaded', boot, { once: true });
})();
