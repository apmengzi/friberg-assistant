// Runs only when a future, audited page contract explicitly injects it.
// It deliberately exposes no React state, storage, network traffic or answer.
// Its only job is to forward an already-visible feedback-row identifier.
(() => {
  window.addEventListener('friberg:mirror-feedback', event => {
    const rowId = event.detail?.row?.dataset?.fribergRowId;
    if (!rowId) return;
    window.dispatchEvent(new CustomEvent('friberg-assistant:visible-row', { detail: { rowId } }));
  });
})();
