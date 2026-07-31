const PRIVATE_SCRIPT_ID = 'friberg-authorized-private-adapter';
const PRIVATE_FILES = ['solver.js', 'automation-core.js', 'overlay.js', 'content-script.js'];

function matchPatternForOrigin(origin) {
  const url = new URL(origin);
  // Chrome match patterns deliberately have no port component.  The content
  // script still checks the exact stored origin before exposing any action.
  return `${url.protocol}//${url.hostname}/*`;
}

async function replacePrivateRegistration(origins) {
  const matches = [...new Set((origins || []).map(matchPatternForOrigin))]
    .filter(match => !match.startsWith('https://shnlfriberg.online/'));
  await chrome.scripting.unregisterContentScripts({ ids: [PRIVATE_SCRIPT_ID] }).catch(() => undefined);
  if (!matches.length) return;
  await chrome.scripting.registerContentScripts([{
    id: PRIVATE_SCRIPT_ID,
    matches,
    css: ['overlay.css'],
    js: PRIVATE_FILES,
    runAt: 'document_idle',
    persistAcrossSessions: true,
  }]);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'friberg:configure-private-origins') return undefined;
  replacePrivateRegistration(message.origins)
    .then(() => sendResponse({ ok: true }))
    .catch(cause => sendResponse({ ok: false, message: cause.message }));
  return true;
});
