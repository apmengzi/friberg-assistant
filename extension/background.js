const PRIVATE_SCRIPT_ID = 'friberg-authorized-private-adapter';
const PRIVATE_FILES = ['solver.js', 'automation-core.js', 'overlay.js', 'content-script.js'];
const NOTIFICATION_PREFIX = 'friberg-match-';
const NOTIFICATION_ICON = 'notification-icon.svg';
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

async function notificationPermissionLevel() {
  if (typeof chrome.notifications.getPermissionLevel !== 'function') return 'granted';
  return chrome.notifications.getPermissionLevel();
}

async function createDesktopNotification(message, sender) {
  const permissionLevel = await notificationPermissionLevel();
  if (permissionLevel !== 'granted') {
    throw new Error(`浏览器通知权限为 ${permissionLevel}；请在 Edge 与 Windows 通知设置中允许通知。`);
  }

  const requestedId = `${NOTIFICATION_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tabId = sender?.tab?.id;
  const windowId = sender?.tab?.windowId;
  if (Number.isInteger(tabId)) notificationTargets.set(requestedId, { tabId, windowId });

  const notificationId = await chrome.notifications.create(requestedId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL(NOTIFICATION_ICON),
    title: String(message.title || '弗一把助手'),
    message: String(message.message || '页面状态已变化。'),
    priority: 2,
    silent: false,
    requireInteraction: Boolean(message.requireInteraction),
  });

  if (!notificationId) throw new Error('浏览器没有返回通知编号。');
  if (notificationId !== requestedId && Number.isInteger(tabId)) {
    const target = notificationTargets.get(requestedId);
    notificationTargets.delete(requestedId);
    notificationTargets.set(notificationId, target);
  }
  return { notificationId, permissionLevel };
}

async function focusFribergTab(notificationId) {
  let target = notificationTargets.get(notificationId);
  if (!target) {
    const tabs = await chrome.tabs.query({ url: 'https://shnlfriberg.online/multi*' }).catch(() => []);
    const tab = tabs.find(candidate => Number.isInteger(candidate.id));
    if (tab) target = { tabId: tab.id, windowId: tab.windowId };
  }
  if (!target || !Number.isInteger(target.tabId)) return;
  if (Number.isInteger(target.windowId)) {
    await chrome.windows.update(target.windowId, { focused: true }).catch(() => undefined);
  }
  await chrome.tabs.update(target.tabId, { active: true }).catch(() => undefined);
}

chrome.notifications.onClicked.addListener(notificationId => {
  void focusFribergTab(notificationId).finally(() => {
    notificationTargets.delete(notificationId);
    void chrome.notifications.clear(notificationId);
  });
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
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(cause => sendResponse({ ok: false, message: cause.message }));
    return true;
  }
  return undefined;
});
