(() => {
  'use strict';

  const Solver = globalThis.GameSolver;
  const Policy = globalThis.FribergRacePolicy;
  if (!Solver || !Policy || !globalThis.chrome?.runtime) return;

  const FIRST = Policy.opening || 'refrezh';
  const STORAGE_KEY = 'fribergRaceLiteArmedV1';
  const HUD_ID = 'friberg-race-lite-hud';
  const FALLBACK_MS = 8;
  const RETRY_MS = 8;
  const FIELD_KEYS = ['team', 'country', 'age', 'role', 'majorWins', 'majorApps', 'status'];

  const state = {
    armed: sessionStorage.getItem(STORAGE_KEY) === '1',
    ready: false,
    players: [],
    byNick: new Map(),
    lastCount: null,
    lastRound: '',
    actionKey: '',
    desired: '',
    lastAttemptAt: 0,
    awaitingProgressKey: '',
    awaitingProgressAt: 0,
    candidateCount: null,
    driftNote: '',
    observer: null,
    timer: null,
    queued: false,
    driving: false,
    hud: null,
  };

  const normalize = value => Solver.normalize
    ? Solver.normalize(value)
    : String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const compact = value => String(value || '').replace(/\s+/g, ' ').trim();

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
    return compact(text);
  }

  function roundToken() {
    const match = pageText().match(/第\s*(\d+)\s*局/);
    return match ? `R${match[1]}` : 'R?';
  }

  function selfBoard() {
    const card = Array.from(document.querySelectorAll('.player-board-self')).find(visible);
    return card?.querySelector('table.game-table') || null;
  }

  function guessCount(board) {
    const card = board?.closest('.player-board-self');
    const match = compact(card?.innerText).match(/(?:我的猜测|我的竞猜|my guesses?)[^0-9]{0,40}(\d+)\s*\/\s*8\b/i);
    const count = Number(match?.[1]);
    if (Number.isInteger(count) && count >= 0 && count <= 8) return count;
    const rows = officialRows(board);
    return rows.length <= 8 ? rows.length : null;
  }

  function surface() {
    const form = Array.from(document.querySelectorAll('.input-dock form.input-bar,form.input-bar')).find(visible);
    const input = form?.querySelector('input[role="combobox"],input.input');
    const button = form?.querySelector('button');
    if (!(form instanceof HTMLFormElement) || !(input instanceof HTMLInputElement)) return null;
    return { form, input, button: button instanceof HTMLButtonElement ? button : null };
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
    hud.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483647;min-width:220px;padding:7px 9px;border:1px solid #52e0b4;border-radius:5px;background:#10292d;color:#e8ffef;box-shadow:0 4px 16px #0008;font:12px/1.35 Consolas,monospace;user-select:none';
    const status = document.createElement('div');
    status.dataset.raceStatus = '1';
    status.style.fontWeight = '700';
    const detail = document.createElement('div');
    detail.dataset.raceDetail = '1';
    detail.style.cssText = 'margin-top:2px;color:#bce9dd;max-width:360px';
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

  function officialRows(board) {
    if (!(board instanceof Element)) return [];
    return Array.from(board.querySelectorAll('tbody > tr'))
      .filter(visible)
      .filter(row => row.children.length === 8);
  }

  function levelOf(cell) {
    if (!(cell instanceof Element)) return null;
    if (cell.classList.contains('correct')) return 'correct';
    if (cell.classList.contains('close')) return 'close';
    if (cell.classList.contains('wrong')) return 'wrong';
    return null;
  }

  function directionOf(cell) {
    if (!(cell instanceof Element)) return 'none';
    const signal = compact(Array.from(cell.querySelectorAll('.dir,svg,[data-lucide]')).map(node => [
      node.textContent,
      node.getAttribute('class'),
      node.getAttribute('data-lucide'),
      node.getAttribute('aria-label'),
    ].join(' ')).join(' ')).toLocaleLowerCase();
    if (signal.includes('↑') || /arrow[-_ ]?up|lucide-arrow-up|higher|向上/.test(signal)) return 'up';
    if (signal.includes('↓') || /arrow[-_ ]?down|lucide-arrow-down|lower|向下/.test(signal)) return 'down';
    return 'none';
  }

  function numberFrom(cell) {
    const value = compact(cell?.textContent).match(/-?\d+(?:\.\d+)?/)?.[0];
    return value === undefined ? null : Number(value);
  }

  function roleFromText(value, fallback) {
    const text = normalize(value);
    if (/狙击|awper|sniper/.test(text)) return 'AWPer';
    if (/教练|coach/.test(text)) return 'Coach';
    if (/步枪|rifler|igl|指挥|support|辅助/.test(text)) return 'Rifler';
    return fallback;
  }

  function activeFromText(value, fallback) {
    const text = normalize(value);
    if (/退役|retired|inactive|非现役/.test(text)) return false;
    if (/现役|active|在役/.test(text)) return true;
    return fallback;
  }

  function serverVisibleGuess(local, cells) {
    const team = compact(cells[1]?.textContent) || local.gameTeam;
    const country = compact(cells[2]?.textContent) || local.gameCountry;
    const age = numberFrom(cells[3]);
    const role = roleFromText(cells[4]?.textContent, local.gameRole);
    const majorWins = numberFrom(cells[5]);
    const majorApps = numberFrom(cells[6]);
    const active = activeFromText(cells[7]?.textContent, local.gameActive);
    return {
      ...local,
      team,
      gameTeam: team,
      country,
      gameCountry: country,
      age: age ?? local.age,
      gameRole: role,
      majorWins: majorWins ?? local.majorWins,
      majorApps: majorApps ?? local.majorApps,
      gameActive: active,
    };
  }

  function parseHistory(board, count) {
    const rows = officialRows(board);
    if (rows.length < count) return { ok: false, reason: `反馈行 ${rows.length}/${count}，等待网页渲染` };
    const feedbacks = [];
    const guesses = [];
    for (let index = 0; index < count; index += 1) {
      const cells = Array.from(rows[index].children);
      const nickname = compact(cells[0]?.textContent);
      const local = state.byNick.get(normalize(nickname));
      if (!local) return { ok: false, reason: `第 ${index + 1} 行昵称无法匹配题库：${nickname || '空'}` };
      const colors = cells.slice(1).map(levelOf);
      if (colors.some(color => !color)) {
        return { ok: false, reason: `第 ${index + 1} 行颜色尚未完整：${colors.map(value => value || '?').join('/')}` };
      }
      const guess = serverVisibleGuess(local, cells);
      const feedback = Solver.buildFeedback(guess, colors, {
        age: directionOf(cells[3]),
        majorWins: directionOf(cells[5]),
        majorApps: directionOf(cells[6]),
      });
      if (!Solver.validateFeedback(feedback).valid) {
        return { ok: false, reason: `第 ${index + 1} 行反馈不合法` };
      }
      guesses.push(guess);
      feedbacks.push(feedback);
    }
    return { ok: true, guesses, feedbacks };
  }

  function recommend(board, count) {
    state.driftNote = '';
    if (count === 0) {
      state.candidateCount = Policy.poolSize;
      return { nickname: FIRST, reason: '' };
    }
    const parsed = parseHistory(board, count);
    if (!parsed.ok) return { nickname: '', reason: parsed.reason };
    const guessedKeys = new Set(parsed.guesses.map(Solver.playerKey));
    let candidates = Solver.filterCandidates(state.players, parsed.feedbacks, guessedKeys);
    if (!candidates.length && typeof Solver.rankDataDriftCandidates === 'function') {
      const relaxed = Solver.rankDataDriftCandidates(state.players, parsed.feedbacks, guessedKeys, 1);
      if (relaxed.candidates.length) {
        candidates = relaxed.candidates;
        const fields = [...new Set(relaxed.conflicts.flatMap(item => item.fields))];
        state.driftNote = `题库漂移容错：${fields.join(',') || '1字段'}`;
      }
    }
    state.candidateCount = candidates.length;
    if (!candidates.length) return { nickname: '', reason: '严格筛选与单字段漂移容错均为 0 候选' };
    const player = Policy.choose({ Solver, candidates, guessedKeys });
    return { nickname: player?.nick || '', reason: player ? '' : '竞速策略未返回下一猜' };
  }

  function setReactInput(input, nickname) {
    input.focus({ preventScroll: true });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, nickname);
    input.dispatchEvent(typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: nickname })
      : new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function resetAction() {
    state.actionKey = '';
    state.desired = '';
    state.lastAttemptAt = 0;
    state.awaitingProgressKey = '';
    state.awaitingProgressAt = 0;
  }

  function terminal() {
    return /(比赛结束|本场比赛结束|最终比分|你赢下了整场比赛|你输掉了整场比赛|match over|match finished)/i.test(pageText());
  }

  function submitFast(controls, actionKey) {
    if (!controls.button || controls.button.disabled) return false;
    const now = performance.now();
    if (now - state.lastAttemptAt < RETRY_MS) return false;
    state.lastAttemptAt = now;
    controls.form.requestSubmit(controls.button);
    if (!controls.input.value) {
      state.awaitingProgressKey = actionKey;
      state.awaitingProgressAt = now;
    }
    return true;
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
        state.lastCount = count;
        state.lastRound = round;
        resetAction();
      }
      if (count >= 8) {
        setHud('等待本局结束', `${round} · 8/8`);
        return;
      }

      const result = recommend(board, count);
      const nickname = result.nickname;
      if (!nickname) {
        if (controls.input.value && count > 0) setReactInput(controls.input, '');
        setHud('等待/修复反馈', `${round} · ${count}/8 · ${result.reason}`);
        return;
      }

      const actionKey = `${round}|${count}|${normalize(nickname)}`;
      if (state.actionKey !== actionKey) {
        state.actionKey = actionKey;
        state.desired = nickname;
        state.lastAttemptAt = 0;
        state.awaitingProgressKey = '';
        state.awaitingProgressAt = 0;
      }

      if (state.lastAttemptAt > 0 && !controls.input.value && state.awaitingProgressKey !== actionKey) {
        state.awaitingProgressKey = actionKey;
        state.awaitingProgressAt = performance.now();
      }

      if (state.awaitingProgressKey === actionKey) {
        if (performance.now() - state.awaitingProgressAt < 5000) {
          setHud(`已提交 ${nickname}`, `等待 ${round} 进度从 ${count}/8 更新`);
          return;
        }
        state.awaitingProgressKey = '';
      }

      if (normalize(controls.input.value) !== normalize(nickname)) {
        setReactInput(controls.input, nickname);
        setHud(`立刻预填 ${nickname}`, `${state.candidateCount ?? '?'} 候选 · ${count}/8${state.driftNote ? ` · ${state.driftNote}` : ''}`);
      }

      const submitted = submitFast(controls, actionKey);
      if (submitted) {
        setHud(`立即提交 ${nickname}`, `${state.candidateCount ?? '?'} 候选 · 不等待下拉 DOM${state.driftNote ? ` · ${state.driftNote}` : ''}`);
      } else {
        setHud(`已预填 ${nickname}`, `${state.candidateCount ?? '?'} 候选 · 等 React 列表/提交状态就绪${state.driftNote ? ` · ${state.driftNote}` : ''}`);
      }
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
    setHud('竞速引擎已就绪', `${players.length} 人 · 二猜理论率 41.49% · 1.0.1`);
    schedule();
  }

  function boot() {
    ensureHud();
    setHud('正在加载竞速引擎', '官方多人 DOM 直读 · 表单直接提交');
    state.observer = new MutationObserver(records => {
      if (records.every(record => state.hud?.contains(record.target))) return;
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
    state.timer = window.setInterval(() => { if (state.armed) drive(); }, FALLBACK_MS);
    void load().catch(error => setHud('竞速引擎加载失败', error instanceof Error ? error.message : String(error)));
  }

  if (document.documentElement) boot();
  else addEventListener('DOMContentLoaded', boot, { once: true });
})();
