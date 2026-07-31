(async () => {
  const input = document.querySelector('#privateOrigins');
  const saved = document.querySelector('#saved');
  const matchPatternForOrigin = origin => {
    const url = new URL(origin);
    // Chrome permissions do not encode ports; the injected code separately
    // requires an exact origin match before it can perform an action.
    return `${url.protocol}//${url.hostname}/*`;
  };
  const { privateOrigins = [] } = await chrome.storage.sync.get({ privateOrigins: [] });
  input.value = privateOrigins.join('\n');
  document.querySelector('#save').addEventListener('click', async () => {
    const values = input.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const normalized = [];
    for (const value of values) {
      try { normalized.push(new URL(value).origin); } catch { saved.textContent = `无效 origin：${value}`; return; }
    }
    const origins = [...new Set(normalized)];
    const requested = origins
      .filter(origin => origin !== 'https://shnlfriberg.online')
      .map(matchPatternForOrigin);
    if (requested.length && !(await chrome.permissions.request({ origins: requested }))) {
      saved.textContent = '未授予这些私人测试域名的扩展权限。';
      return;
    }
    await chrome.storage.sync.set({ privateOrigins: origins });
    const result = await chrome.runtime.sendMessage({ type: 'friberg:configure-private-origins', origins });
    saved.textContent = result?.ok ? '已保存；刷新该私人测试页以加载只认 data 合约的适配器。' : `注册失败：${result?.message || '未知错误'}`;
  });
})();
