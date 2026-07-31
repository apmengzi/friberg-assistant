const NOTIFICATION_PREFIX = 'friberg-ultimate-match-';
const NOTIFICATION_ICON_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAACDklEQVR4nO3bsVEcQRBA0YMiABQJHg42pRiIQ3EoDmJQyVY8hAAWJiok9czd6r/nAjNXtZ/ehbm7ur27fz2RdX3uF8B5CSBOAHECiBNAnADiBBAngDgBxAkgTgBxAogTQJwA4gQQJ4A4AcQJIE4AcQKIE0CcAOIEECeAOAHECSBOAHE3uzf88evL7i0P5+vDy7a9TIA4AcQJIE4AcQKIE0CcAOIEECeAOAHECSBOAHECiBNA3Pbj4Ak7j0v/dyZAnADiBBAngDgBxAkgTgBxAogTQJwA4gQQJ4C4Qx4GHe3zhZd8eGUCxAkgTgBxAogTQJwA4gQQJ4A4AcQJIE4AcQKIE0CcAOIOeRx8ycerR2MCxAkgTgBxAogTQJwA4gQQJ4C4Q/4j6Ogen799+LWfT983vhIBbPO7i/7R9+2IwS1gg89e/Kmf+xMmwEITF/B9jVXTwARYZPq3d9U0EMACqy7WinUFECeAYasf3KbXF8CgHU/t0/sIIE4AcQIYsmv8T+8ngDgBxAkgTgBxAogTQJwAhux+J8/UfgKIE0CcAAbtug1M7iOAYasjmF5fAHECWGDVFFix7tXt3f3r+KqcTqfZE8JVUQlgg38JYfUzhVvABn97EXf8VWECnMElfTZQAHFuAXECiBNAnADiBBAngDgBxAkgTgBxAogTQJwA4gQQJ4A4AcQJIE4AcQKIewMkt0asEQvw8AAAAABJRU5ErkJggg==';
const notificationTargets = new Map();

function notificationPermissionLevel() {
  return new Promise(resolve => chrome.notifications.getPermissionLevel(resolve));
}

async function createDesktopNotification(message, sender) {
  const permissionLevel = await notificationPermissionLevel();
  if (permissionLevel !== 'granted') {
    throw new Error(`浏览器扩展通知权限为 ${permissionLevel}，不是 granted。`);
  }
  const notificationId = `${NOTIFICATION_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tabId = sender?.tab?.id;
  const windowId = sender?.tab?.windowId;
  if (Number.isInteger(tabId)) notificationTargets.set(notificationId, { tabId, windowId });
  await chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: NOTIFICATION_ICON_URL,
    title: String(message.title || '弗一把助手'),
    message: String(message.message || '页面状态已变化。'),
    contextMessage: 'Friberg Ultimate Assistant',
    priority: 2,
    requireInteraction: Boolean(message.requireInteraction),
  });
  return { notificationId, permissionLevel };
}

chrome.notifications.onClicked.addListener(notificationId => {
  const target = notificationTargets.get(notificationId);
  if (!target) return;
  const focusWindow = Number.isInteger(target.windowId)
    ? chrome.windows.update(target.windowId, { focused: true }).catch(() => undefined)
    : Promise.resolve();
  void focusWindow.then(() => chrome.tabs.update(target.tabId, { active: true }).catch(() => undefined));
  void chrome.notifications.clear(notificationId);
});

chrome.notifications.onClosed.addListener(notificationId => {
  notificationTargets.delete(notificationId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'friberg:desktop-notification') return undefined;
  createDesktopNotification(message, sender)
    .then(result => sendResponse({ ok: true, ...result }))
    .catch(cause => sendResponse({ ok: false, message: cause.message }));
  return true;
});
