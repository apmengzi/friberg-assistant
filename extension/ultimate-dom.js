(function bootstrapFribergUltimateDom(root, factory) {
  const api = factory(root.GameSolver);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FribergUltimateDom = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createUltimateDomApi(Solver) {
  'use strict';

  if (!Solver) throw new Error('FribergUltimateDom requires GameSolver.');

  const normalize = value => Solver.normalize(value);
  const compact = value => String(value || '').replace(/\s+/g, ' ').trim();

  function visible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && rect.width > 0
      && rect.height > 0;
  }

  function routeKind() {
    if (location.pathname.startsWith('/single')) return 'single';
    if (location.pathname.startsWith('/multi')) return 'multi';
    return 'other';
  }

  function pageText(excludeElement = null) {
    let text = document.body?.innerText || '';
    const excluded = excludeElement?.innerText || '';
    if (excluded) text = text.replace(excluded, ' ');
    return compact(text);
  }

  function ownBoard(kind = routeKind()) {
    const selectors = kind === 'multi'
      ? ['.player-board-self']
      : ['.single-game-board', '.single-game-page'];
    for (const selector of selectors) {
      const element = Array.from(document.querySelectorAll(selector)).find(visible);
      if (element) return element;
    }
    return null;
  }

  function rows(board = ownBoard()) {
    if (!(board instanceof Element)) return [];
    return Array.from(board.querySelectorAll('table.game-table tbody > tr, tbody > tr'))
      .filter(visible)
      .filter(row => row.children.length === 8);
  }

  function multiCount(board) {
    const card = board?.matches?.('.player-board-self') ? board : board?.closest?.('.player-board-self');
    const match = compact(card?.querySelector('h3')?.innerText || card?.innerText)
      .match(/(\d+)\s*\/\s*8\b/);
    const count = Number(match?.[1]);
    if (Number.isInteger(count) && count >= 0 && count <= 8) return count;
    return null;
  }

  function singleCount(board) {
    const groups = Array.from(document.querySelectorAll('.guess-progress')).filter(visible);
    const counts = groups.map(group => {
      const dots = Array.from(group.querySelectorAll('i'));
      return dots.length ? dots.filter(dot => dot.classList.contains('used')).length : null;
    }).filter(Number.isInteger);
    if (counts.length) return Math.max(...counts);
    return board ? rows(board).length : null;
  }

  function guessCount(kind = routeKind(), board = ownBoard(kind)) {
    const count = kind === 'multi' ? multiCount(board) : singleCount(board);
    if (Number.isInteger(count) && count >= 0 && count <= 8) return count;
    const fallback = rows(board).length;
    return fallback <= 8 ? fallback : null;
  }

  function roundToken(kind = routeKind(), excluded = null) {
    if (kind === 'single') return `single:${location.pathname}`;
    const match = pageText(excluded).match(/第\s*(\d+)\s*局/);
    return match ? `multi:${match[1]}` : `multi:${location.pathname}`;
  }

  function inputSurface() {
    const forms = Array.from(document.querySelectorAll('.input-dock form.input-bar, form.input-bar'));
    for (const form of forms) {
      if (!visible(form)) continue;
      const input = form.querySelector('input[role="combobox"], input.input');
      const button = form.querySelector('button');
      if (input instanceof HTMLInputElement && button instanceof HTMLButtonElement) {
        return { form, input, button };
      }
    }
    return null;
  }

  function setInputValue(input, value) {
    if (!(input instanceof HTMLInputElement)) return false;
    input.focus({ preventScroll: true });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(input, value);
    input.dispatchEvent(typeof InputEvent === 'function'
      ? new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        data: value,
      })
      : new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return true;
  }

  function submitExact(nickname) {
    const surface = inputSurface();
    if (!surface) return Object.freeze({ status: 'missing-surface' });
    const desired = compact(nickname);
    if (!desired) return Object.freeze({ status: 'empty-nickname' });
    if (normalize(surface.input.value) !== normalize(desired)) {
      setInputValue(surface.input, desired);
      return Object.freeze({ status: 'filled', surface });
    }
    if (surface.button.disabled || surface.button.getAttribute('aria-disabled') === 'true') {
      return Object.freeze({ status: 'waiting-react', surface });
    }
    surface.form.requestSubmit(surface.button);
    return Object.freeze({ status: 'submitted', surface });
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
    const nodes = Array.from(cell.querySelectorAll('.dir, svg, [data-lucide]'));
    const signal = normalize(nodes.map(node => [
      node.textContent,
      node.getAttribute('class'),
      node.getAttribute('data-lucide'),
      node.getAttribute('aria-label'),
    ].join(' ')).join(' '));
    if (signal.includes('↑') || /arrow[-_ ]?up|lucide-arrow-up|higher|向上/.test(signal)) return 'up';
    if (signal.includes('↓') || /arrow[-_ ]?down|lucide-arrow-down|lower|向下/.test(signal)) return 'down';
    return 'none';
  }

  function numberFrom(cell, fallback) {
    const raw = compact(cell?.textContent).match(/-?\d+(?:\.\d+)?/)?.[0];
    const value = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(value) ? value : fallback;
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

  function visibleGuess(local, cells, players) {
    const team = compact(cells[1]?.textContent) || local.gameTeam;
    const country = compact(cells[2]?.textContent) || local.gameCountry;
    const role = roleFromText(cells[4]?.textContent, local.gameRole);
    const active = activeFromText(cells[7]?.textContent, local.gameActive);
    return Solver.normalizeGamePlayer({
      id: local.id,
      nickname: local.nick,
      real_name: local.realName,
      nationality: country,
      region: Solver.gameRegionFromValue(country, players) || local.region,
      team,
      age: numberFrom(cells[3], local.age),
      role,
      major_championships: numberFrom(cells[5], local.majorWins),
      major_appearances: numberFrom(cells[6], local.majorApps),
      is_active: active,
      is_enabled: local.enabled !== false,
      difficulty: local.difficulty,
    });
  }

  function parseHistory({ board = ownBoard(), players = [], expectedCount = null } = {}) {
    const gameRows = rows(board);
    const count = expectedCount === null ? gameRows.length : expectedCount;
    if (gameRows.length < count) {
      return Object.freeze({ ok: false, reason: `反馈行 ${gameRows.length}/${count}，网页仍在渲染。` });
    }
    const byNick = new Map(players.map(player => [normalize(player.nick), player]));
    const guesses = [];
    const history = [];

    for (let index = 0; index < count; index += 1) {
      const cells = Array.from(gameRows[index].children);
      const nickname = compact(cells[0]?.textContent);
      const local = byNick.get(normalize(nickname));
      if (!local) {
        return Object.freeze({ ok: false, reason: `第 ${index + 1} 行昵称不在题库：${nickname || '空'}` });
      }
      const colors = cells.slice(1).map(levelOf);
      if (colors.some(color => !color)) {
        return Object.freeze({
          ok: false,
          reason: `第 ${index + 1} 行颜色不完整：${colors.map(color => color || '?').join('/')}`,
        });
      }
      const guess = visibleGuess(local, cells, players);
      const feedback = Solver.buildFeedback(guess, colors, {
        age: directionOf(cells[3]),
        majorWins: directionOf(cells[5]),
        majorApps: directionOf(cells[6]),
      });
      const validation = Solver.validateFeedback(feedback);
      if (!validation.valid) {
        return Object.freeze({ ok: false, reason: `第 ${index + 1} 行反馈无效：${validation.errors.join(' ')}` });
      }
      guesses.push(guess);
      history.push(feedback);
    }

    return Object.freeze({ ok: true, guesses, history, rows: gameRows.slice(0, count) });
  }

  function buttons() {
    return Array.from(document.querySelectorAll('button')).filter(visible);
  }

  function buttonByText(pattern, scope = document) {
    return Array.from(scope.querySelectorAll('button')).find(button => visible(button) && pattern.test(compact(button.innerText || button.textContent))) || null;
  }

  function readyButton() {
    const candidates = buttons().filter(button => /^(准备|确认准备|我已准备|ready|accept)$/i.test(compact(button.innerText || button.textContent)));
    if (candidates.length !== 1) return null;
    const button = candidates[0];
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') return null;
    return button;
  }

  function againButton() {
    const modal = Array.from(document.querySelectorAll('[aria-modal="true"], .answer-overlay, .modal')).find(visible);
    const pattern = /^(再来一局|再玩一次|再来一次|重新开始|again|play again|restart)$/i;
    return buttonByText(pattern, modal || document);
  }

  function terminalSingle() {
    const modal = Array.from(document.querySelectorAll('[aria-modal="true"], .answer-overlay, .modal')).find(visible);
    if (modal && /(恭喜|正确答案|本局结束|猜对|congratulations|correct answer|game ended)/i.test(compact(modal.innerText))) return true;
    return Boolean(!inputSurface() && againButton());
  }

  function terminalMulti(excludeElement = null) {
    return /(比赛结束|本场比赛结束|最终比分|你赢下了整场比赛|你输掉了整场比赛|match over|match finished)/i
      .test(pageText(excludeElement));
  }

  function playable(kind = routeKind()) {
    const surface = inputSurface();
    if (!surface) return false;
    const board = ownBoard(kind);
    const count = guessCount(kind, board);
    return Number.isInteger(count) && count >= 0 && count <= 8;
  }

  return Object.freeze({
    version: 2,
    visible,
    compact,
    normalize,
    routeKind,
    pageText,
    ownBoard,
    rows,
    guessCount,
    roundToken,
    inputSurface,
    setInputValue,
    submitExact,
    parseHistory,
    readyButton,
    againButton,
    terminalSingle,
    terminalMulti,
    playable,
  });
}));
