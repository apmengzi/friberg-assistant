(() => {
  'use strict';

  const OVERLAY = '#friberg-assistant-overlay';
  const FALLBACK_MS = 24;
  const state = {
    lastProgress: '',
    lockKey: '',
    lockAt: 0,
    queued: false,
    timer: null,
    observer: null,
  };

  function overlay() {
    return document.querySelector(OVERLAY);
  }

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  }

  function armed() {
    const host = overlay();
    const autoplay = host?.querySelector('[data-fa-autoplay-action="toggle"]');
    const loop = host?.querySelector('[data-fa-single-loop-action="toggle"]');
    return autoplay?.dataset.armed === 'true' || loop?.dataset.armed === 'true';
  }

  function pageText() {
    let text = document.body?.innerText || '';
    const own = overlay()?.innerText || '';
    if (own) text = text.replace(own, ' ');
    return text.replace(/\s+/g, ' ').trim();
  }

  function progressKey() {
    if (location.pathname.startsWith('/single')) {
      const groups = Array.from(document.querySelectorAll('.guess-progress'));
      for (const group of groups) {
        const style = getComputedStyle(group);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const dots = Array.from(group.querySelectorAll('i'));
        if (!dots.length) continue;
        return `single:${dots.filter(dot => dot.classList.contains('used')).length}`;
      }
      return 'single:?';
    }
    const match = pageText().match(/(?:我的猜测|我的竞猜|my guesses?)[^0-9]{0,40}(\d+)\s*\/\s*8\b/i);
    return `multi:${match?.[1] ?? '?'}`;
  }

  function recommendation() {
    const value = overlay()?.querySelector('[data-fa-next]')?.textContent?.trim() || '';
    if (!value || /^(等待反馈|最新反馈待识别|—)$/.test(value)) return '';
    return value.split('·')[0].trim();
  }

  function releaseLock() {
    const button = overlay()?.querySelector('[data-fa-qol-action="fill-submit"]');
    if (button?.dataset.faInstantLock === 'true') {
      delete button.dataset.faInstantLock;
      button.disabled = false;
    }
    state.lockKey = '';
    state.lockAt = 0;
  }

  function tick() {
    state.queued = false;
    const progress = progressKey();
    if (progress !== state.lastProgress) {
      state.lastProgress = progress;
      releaseLock();
    }

    if (!armed()) {
      releaseLock();
      return;
    }

    if (state.lockKey && performance.now() - state.lockAt > 3000) releaseLock();
    if (state.lockKey) return;

    const next = recommendation();
    if (!next) return;
    const button = overlay()?.querySelector('[data-fa-qol-action="fill-submit"]');
    if (!button || button.hidden || button.disabled) return;

    const key = `${progress}|${normalize(next)}`;
    state.lockKey = key;
    state.lockAt = performance.now();
    button.click();
    button.dataset.faInstantLock = 'true';
    button.disabled = true;
  }

  function schedule() {
    if (state.queued) return;
    state.queued = true;
    queueMicrotask(() => requestAnimationFrame(tick));
  }

  state.observer?.disconnect();
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
  state.timer = window.setInterval(schedule, FALLBACK_MS);
  schedule();
})();
