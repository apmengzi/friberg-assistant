(() => {
  'use strict';

  const Adapter = globalThis.FribergLiveDomAdapter;
  const Solver = globalThis.GameSolver;
  if (!Adapter || !Solver || !globalThis.chrome?.runtime) return;

  const OVERLAY = '#friberg-assistant-overlay';
  const TICK_MS = 120;
  const FIRST_GUESS = 'refrezh';
  const SINGLE_NORMAL_ROUTE = '/single/normal';
  const TERMINAL_SINGLE_RE = /(恭喜，猜对了|正确答案|本局结束|很遗憾|congratulations|correct answer|game ended)/i;
  const AGAIN_RE = /^(再来一把|再来一局|再玩一局|again|play again)$/i;

  const state = {
    submittingFirst: false,
    awaitingFirstProgress: false,
    firstSubmittedAt: 0,
    lastGuessCount: null,
    loopArmed: false,
    loopCompleted: 0,
    loopTerminalSeen: false,
    loopRestarting: false,
    loopRestartAt: 0,
    timer: null,
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

  function routeKind() {
    if (location.pathname.startsWith('/single')) return 'single';
    if (location.pathname.startsWith('/multi')) return 'multi';
    return 'other';
  }

  function isSingleNormalGame() {
    return location.pathname === SINGLE_NORMAL_ROUTE
      || location.pathname.startsWith(`${SINGLE_NORMAL_ROUTE}/`);
  }

  function visiblePageText() {
    let text = document.body?.innerText || '';
    const own = overlay()?.innerText || '';
    if (own) text = text.replace(own, ' ');
    return text.replace(/\s+/g, ' ').trim();
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

  function multiGuessCount() {
    const match = visiblePageText().match(/(?:我的猜测|我的竞猜|my guesses?)[^0-9]{0,40}(\d+)\s*\/\s*8\b/i);
    const count = Number(match?.[1]);
    return Number.isInteger(count) && count >= 0 && count <= 8 ? count : null;
  }

  function guessCount() {
    return routeKind() === 'single' ? singleGuessCount() : multiGuessCount();
  }

  function autoplayButton() {
    return overlay()?.querySelector('[data-fa-autoplay-action="toggle"]') || null;
  }

  function autoplayArmed() {
    return autoplayButton()?.dataset.armed === 'true';
  }

  function ensureAutoplayArmed() {
    const button = autoplayButton();
    if (!button || button.hidden || button.disabled || autoplayArmed()) return false;
    button.click();
    return true;
  }

  function terminalSingleDialog() {
    if (routeKind() !== 'single') return null;
    return Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"],.answer-overlay,.overlay-card'))
      .filter(isVisible)
      .filter(element => !element.closest(OVERLAY))
      .find(element => TERMINAL_SINGLE_RE.test(element.innerText || element.textContent || '')) || null;
  }

  function uniqueAgainButton(dialog) {
    const buttons = Array.from(dialog?.querySelectorAll('button') || []).filter(isVisible);
    const exact = buttons.filter(button => AGAIN_RE.test((button.innerText || button.textContent || '').trim()));
    return exact.length === 1 ? exact[0] : null;
  }

  function loopButtonLabel() {
    if (!state.loopArmed) return '单人完整版循环：关';
    return `单人完整版循环：开 · 已完成 ${state.loopCompleted} 局（点击停止）`;
  }

  function updateLoopControl() {
    const button = ensureLoopControl();
    if (!button) return;
    button.textContent = loopButtonLabel();
    button.dataset.armed = String(state.loopArmed);
    button.hidden = routeKind() !== 'single';
    button.disabled = routeKind() === 'single' && !isSingleNormalGame();
    button.title = button.disabled
      ? '请先进入“单人 · 完整版”的实际对局。'
      : state.loopArmed
        ? '自动完成当前完整版单人局，结算后点击“再来一把”并继续；点击可立即停止。'
        : '仅在当前页面会话持续运行，刷新或离开完整版页面后关闭。';
  }

  function stopLoop(reason = '', error = '') {
    state.loopArmed = false;
    state.loopTerminalSeen = false;
    state.loopRestarting = false;
    state.loopRestartAt = 0;
    updateLoopControl();
    if (reason) setOverlay('单人完整版循环已停止', reason, error);
  }

  function startLoop() {
    if (!isSingleNormalGame()) {
      setOverlay('当前页面不是单人完整版', '请先进入“单人 · 完整版”的实际对局，再开启循环。');
      return;
    }
    state.loopArmed = true;
    state.loopCompleted = 0;
    state.loopTerminalSeen = false;
    state.loopRestarting = false;
    state.loopRestartAt = 0;
    updateLoopControl();
    ensureAutoplayArmed();
    setOverlay(
      '单人完整版循环已开启',
      '将自动完成当前局，结算后自动点击“再来一把”，并重新开启下一局全自动。',
      '',
    );
  }

  function ensureLoopControl() {
    const host = overlay();
    const actions = host?.querySelector('.fa-actions');
    if (!actions) return null;
    let button = actions.querySelector('[data-fa-single-loop-action="toggle"]');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'fa-autoplay fa-single-loop';
      button.dataset.faSingleLoopAction = 'toggle';
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (state.loopArmed) stopLoop('已按你的点击停止连续单人对局。');
        else startLoop();
      });
      actions.append(button);
    }
    return button;
  }

  function noteGuessCount(count) {
    if (count !== null && count !== state.lastGuessCount) {
      if (count > 0) state.awaitingFirstProgress = false;
      state.lastGuessCount = count;
    }
    if (!autoplayArmed()) state.awaitingFirstProgress = false;
  }

  function recoverInitialSubmit() {
    if (state.submittingFirst || state.awaitingFirstProgress || !autoplayArmed()) return;
    const kind = routeKind();
    if (kind !== 'single' && kind !== 'multi') return;
    const count = guessCount();
    noteGuessCount(count);
    if (count !== 0) return;

    const scan = Adapter.scan(document);
    const input = scan.inputCandidates?.[0]?.element;
    if (!input || normalize(input.value) !== FIRST_GUESS) return;

    state.submittingFirst = true;
    try {
      const result = Adapter.submitSelectedGuess({
        input,
        player: { nick: FIRST_GUESS, nickname: FIRST_GUESS },
        scanResult: scan,
        documentRef: document,
      });
      if (result?.submitted) {
        state.awaitingFirstProgress = true;
        state.firstSubmittedAt = Date.now();
        setOverlay(
          'refrezh 已自动提交',
          '已绕过旧版“只填入不提交”的状态断层；正在等待网页生成第一行反馈。',
          '',
        );
      } else if (result?.status && !['disabled', 'missing', 'ambiguous'].includes(result.status)) {
        setOverlay('首猜提交尚未完成', '没有执行不确定的重复提交。', result.message || result.status);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setOverlay('首猜自动提交失败', 'refrezh 已保留在输入框中，没有重复点击。', message);
    } finally {
      state.submittingFirst = false;
    }
  }

  function driveSingleLoop() {
    if (!state.loopArmed) return;
    if (!isSingleNormalGame()) {
      stopLoop('已离开“单人 · 完整版”实际对局页面。');
      return;
    }

    const terminal = terminalSingleDialog();
    if (terminal) {
      if (!state.loopTerminalSeen) {
        state.loopTerminalSeen = true;
        state.loopCompleted += 1;
        state.loopRestartAt = Date.now() + 650;
        updateLoopControl();
      }
      if (state.loopRestarting || Date.now() < state.loopRestartAt) return;
      const again = uniqueAgainButton(terminal);
      if (!again) {
        stopLoop('结算窗口中没有唯一的“再来一把”按钮，已停止以避免误点。');
        return;
      }
      state.loopRestarting = true;
      setOverlay('正在开始下一局完整版', `已连续完成 ${state.loopCompleted} 局；正在点击“再来一把”。`, '');
      again.click();
      window.setTimeout(() => {
        state.loopRestarting = false;
      }, 900);
      return;
    }

    if (state.loopTerminalSeen) {
      state.loopTerminalSeen = false;
      state.loopRestarting = false;
      state.awaitingFirstProgress = false;
      state.lastGuessCount = null;
    }
    ensureAutoplayArmed();
  }

  function tick() {
    try {
      updateLoopControl();
      const count = guessCount();
      noteGuessCount(count);
      if (
        state.awaitingFirstProgress
        && count === 0
        && Date.now() - state.firstSubmittedAt > 14000
      ) {
        state.awaitingFirstProgress = false;
      }
      driveSingleLoop();
      recoverInitialSubmit();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (state.loopArmed) stopLoop('循环巡检遇到异常。', message);
    }
  }

  clearInterval(state.timer);
  state.timer = window.setInterval(tick, TICK_MS);
  updateLoopControl();
})();
