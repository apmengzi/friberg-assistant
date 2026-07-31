(() => {
  'use strict';

  if (!globalThis.chrome?.storage?.local) return;

  const OVERLAY = '#friberg-assistant-overlay';
  const STORAGE_KEY = 'fribergSpeedTelemetryV1';
  const MAX_ROUNDS = 300;
  const TICK_MS = 100;
  const TERMINAL_RE = /(本局胜利|本局结束|恭喜，猜对了|正确答案|很遗憾|game ended|correct answer)/i;

  const state = {
    round: null,
    lastCount: null,
    lastRecommendation: '',
    lastStatus: '',
    lastError: '',
    lastCandidateCount: null,
    feedbackSeenAt: 0,
    timer: null,
  };

  const nowIso = () => new Date().toISOString();
  const perfNow = () => Math.round(performance.now() * 10) / 10;

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

  function routeKind() {
    if (location.pathname.startsWith('/single')) return 'single';
    if (location.pathname.startsWith('/multi')) return 'multi';
    return 'other';
  }

  function overlay() {
    return document.querySelector(OVERLAY);
  }

  function overlayText(selector) {
    return overlay()?.querySelector(selector)?.textContent?.trim() || '';
  }

  function multiGuessCount() {
    let text = document.body?.innerText || '';
    const own = overlay()?.innerText || '';
    if (own) text = text.replace(own, ' ');
    const match = text.match(/(?:我的猜测|我的竞猜|my guesses?)[^0-9]{0,40}(\d+)\s*\/\s*8\b/i);
    const value = Number(match?.[1]);
    return Number.isInteger(value) && value >= 0 && value <= 8 ? value : null;
  }

  function singleGuessCount() {
    const groups = Array.from(document.querySelectorAll('.guess-progress')).filter(isVisible);
    for (const group of groups) {
      const dots = Array.from(group.querySelectorAll('i'));
      if (!dots.length) continue;
      const used = dots.filter(dot => dot.classList.contains('used')).length;
      if (used >= 0 && used <= 8) return used;
    }
    return null;
  }

  function guessCount() {
    return routeKind() === 'single' ? singleGuessCount() : multiGuessCount();
  }

  function candidateCount() {
    const value = Number(overlayText('[data-fa-candidates]'));
    return Number.isInteger(value) && value >= 0 ? value : null;
  }

  function currentRecommendation() {
    const value = overlayText('[data-fa-next]');
    if (!value || /^(等待反馈|最新反馈待识别|—)$/.test(value)) return '';
    return value.split('·')[0].trim();
  }

  function currentStatus() {
    return overlayText('[data-fa-status]');
  }

  function currentError() {
    return overlayText('[data-fa-error]');
  }

  function newRound(count) {
    state.round = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      route: location.pathname,
      kind: routeKind(),
      startedAt: nowIso(),
      startedPerf: perfNow(),
      initialCount: count,
      finalCount: count,
      candidateTrajectory: [],
      solveLatenciesMs: [],
      statusEvents: [],
      errors: [],
    };
    state.feedbackSeenAt = 0;
  }

  async function persistRound(round) {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const rounds = Array.isArray(stored[STORAGE_KEY]?.rounds)
      ? stored[STORAGE_KEY].rounds.slice(-MAX_ROUNDS + 1)
      : [];
    rounds.push(round);
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        version: 1,
        updatedAt: nowIso(),
        rounds,
      },
    });
  }

  function finishRound(reason) {
    if (!state.round) return;
    const round = {
      ...state.round,
      endedAt: nowIso(),
      endedPerf: perfNow(),
      durationMs: Math.max(0, perfNow() - state.round.startedPerf),
      finalCount: state.lastCount,
      finishReason: reason,
    };
    state.round = null;
    void persistRound(round);
  }

  function recordCandidate(count) {
    if (!state.round || count === null || count === state.lastCandidateCount) return;
    state.round.candidateTrajectory.push({ atMs: perfNow() - state.round.startedPerf, count });
    state.lastCandidateCount = count;
  }

  function recordStatus(status) {
    if (!state.round || !status || status === state.lastStatus) return;
    state.round.statusEvents.push({ atMs: perfNow() - state.round.startedPerf, status });
    state.lastStatus = status;
  }

  function recordError(error) {
    if (!state.round || !error || error === state.lastError) return;
    state.round.errors.push({ atMs: perfNow() - state.round.startedPerf, error });
    state.lastError = error;
  }

  function recordRecommendation(recommendation) {
    if (!state.round || !recommendation || recommendation === state.lastRecommendation) return;
    if (state.feedbackSeenAt) {
      state.round.solveLatenciesMs.push(Math.max(0, perfNow() - state.feedbackSeenAt));
      state.feedbackSeenAt = 0;
    }
    state.round.statusEvents.push({
      atMs: perfNow() - state.round.startedPerf,
      recommendation,
    });
    state.lastRecommendation = recommendation;
  }

  function ensureExportButton() {
    const actions = overlay()?.querySelector('.fa-actions');
    if (!actions) return;
    let button = actions.querySelector('[data-fa-speed-telemetry="export"]');
    if (button) return;
    button = document.createElement('button');
    button.type = 'button';
    button.dataset.faSpeedTelemetry = 'export';
    button.textContent = '导出优化数据';
    button.title = '导出最近最多 300 局的猜测次数、候选轨迹、求解延迟和错误；不包含隐藏答案。';
    button.style.gridColumn = '1 / -1';
    button.addEventListener('click', async () => {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const payload = stored[STORAGE_KEY] || { version: 1, rounds: [] };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `friberg-speed-telemetry-${Date.now()}.json`;
      document.documentElement.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    actions.append(button);
  }

  function tick() {
    ensureExportButton();
    const kind = routeKind();
    if (kind === 'other') {
      if (state.round) finishRound('left-supported-route');
      return;
    }

    const count = guessCount();
    if (count !== null && (!state.round || (count === 0 && state.lastCount !== null && state.lastCount > 0))) {
      if (state.round) finishRound('new-round');
      newRound(count);
    }

    if (state.round && count !== null && count !== state.lastCount) {
      if (state.lastCount !== null && count > state.lastCount) state.feedbackSeenAt = perfNow();
      state.round.finalCount = count;
      state.round.statusEvents.push({ atMs: perfNow() - state.round.startedPerf, guessCount: count });
      state.lastCount = count;
    }

    const candidates = candidateCount();
    recordCandidate(candidates);
    recordRecommendation(currentRecommendation());
    recordStatus(currentStatus());
    recordError(currentError());

    const status = currentStatus();
    const pageText = document.body?.innerText || '';
    if (state.round && (TERMINAL_RE.test(status) || TERMINAL_RE.test(pageText))) finishRound('terminal');
  }

  clearInterval(state.timer);
  state.timer = setInterval(tick, TICK_MS);
})();
