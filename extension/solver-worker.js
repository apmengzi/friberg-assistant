/* global importScripts, FribergAutomation */
// Optional worker entry point for future larger pools.  The shipped 646-player
// mirror builds once during page boot because transferring a 646² string matrix
// costs more than computing it locally in the content script.
importScripts('solver.js', 'automation-core.js');

self.addEventListener('message', event => {
  if (event.data?.type !== 'build-matrix') return;
  try {
    const players = event.data.players || [];
    const matrix = FribergAutomation.buildFeedbackMatrix(players);
    self.postMessage({ type: 'matrix-ready', requestId: event.data.requestId, matrix });
  } catch (cause) {
    self.postMessage({ type: 'matrix-error', requestId: event.data?.requestId, message: cause.message });
  }
});
