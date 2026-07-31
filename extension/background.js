const PRIVATE_SCRIPT_ID = 'friberg-authorized-private-adapter';
const PRIVATE_FILES = ['solver.js', 'automation-core.js', 'overlay.js', 'content-script.js'];
const NOTIFICATION_PREFIX = 'friberg-match-';
const notificationTargets = new Map();

function matchPatternForOrigin(origin) {
  const url = new URL(origin);
  // Chrome match patterns deliberately have no port component. The content
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

async function createDesktopNotification(message, sender) {
  const notificationId = `${NOTIFICATION_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tabId = sender?.tab?.id;
  const windowId = sender?.tab?.windowId;
  if (Number.isInteger(tabId)) notificationTargets.set(notificationId, { tabId, windowId });
  await chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('notification-icon.svg'),
    title: String(message.title || '弗一把助手'),
    message: String(message.message || '页面状态已变化。'),
    priority: 2,
    requireInteraction: Boolean(message.requireInteraction),
  });
  return notificationId;
}

chrome.notifications.onClicked.addListener(notificationId => {
  const target = notificationTargets.get(notificationId);
  if (!target) return;
  const focus = Number.isInteger(target.windowId)
    ? chrome.windows.update(target.windowId, { focused: true }).catch(() => undefined)
    : Promise.resolve();
  void focus.then(() => chrome.tabs.update(target.tabId, { active: true }).catch(() => undefined));
  void chrome.notifications.clear(notificationId);
});

chrome.notifications.onClosed.addListener(notificationId => {
  notificationTargets.delete(notificationId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'friberg:configure-private-origins') {
    replacePrivateRegistration(message.origins)
      .then(() => sendResponse({ ok: true }))
      .catch(cause => sendResponse({ ok: false, message: cause.message }));
    return true;
  }
  if (message?.type === 'friberg:desktop-notification') {
    createDesktopNotification(message, sender)
      .then(notificationId => sendResponse({ ok: true, notificationId }))
      .catch(cause => sendResponse({ ok: false, message: cause.message }));
    return true;
  }
  return undefined;
});
