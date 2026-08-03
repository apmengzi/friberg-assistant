(() => {
  'use strict';

  if (!globalThis.chrome?.runtime || !globalThis.chrome?.storage?.local) return;

  const POOL_PATH = 'data/game-players-646.json';
  const OVERRIDES_KEY = 'fribergProductionOverridesV1';
  const META_KEY = 'fribergProductionSyncMetaV1';
  const LOCK_KEY = 'fribergProductionSyncLockV1';
  const REQUEST_GAP_MS = 6500;
  const LOCK_TTL_MS = 30000;
  const owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const originalFetch = globalThis.fetch.bind(globalThis);
  let overrides = Object.create(null);
  let meta = Object.create(null);
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  let syncTimer = null;
  let syncRunning = false;
  let observerTimer = null;

  function getStorage(keys) {
    return new Promise(resolve => chrome.storage.local.get(keys, result => resolve(result || {})));
  }

  function setStorage(values) {
    return new Promise(resolve => chrome.storage.local.set(values, resolve));
  }

  function usable(value) {
    return value !== null
      && value !== undefined
      && String(value).trim() !== ''
      && !/^[·•.\-—]+$/.test(String(value).trim());
  }

  function normalizedStatus(value) {
    const text = normalize(value);
    if (/现役|active|已下放|bench/.test(text)) return true;
    if (/退役|retired|inactive/.test(text)) return false;
    return null;
  }

  function regionLookup(pool) {
    const counts = new Map();
    for (const player of pool || []) {
      const country = normalize(player.nationality);
      const region = player.region;
      if (!country || !region) continue;
      if (!counts.has(country)) counts.set(country, new Map());
      const byRegion = counts.get(country);
      byRegion.set(region, (byRegion.get(region) || 0) + 1);
    }
    const result = new Map();
    for (const [country, byRegion] of counts) {
      const best = Array.from(byRegion.entries()).sort((a, b) => b[1] - a[1])[0];
      if (best) result.set(country, best[0]);
    }
    return result;
  }

  function mergePool(pool) {
    const regions = regionLookup(pool);
    return (pool || []).map(player => {
      const key = normalize(player.nickname || player.nick);
      const patch = overrides[key];
      if (!patch) return player;
      const nationality = usable(patch.nationality) ? patch.nationality : player.nationality;
      return {
        ...player,
        nationality,
        region: usable(patch.region) ? patch.region : regions.get(normalize(nationality)) || player.region,
        team: usable(patch.team) ? patch.team : player.team,
        age: Number.isFinite(Number(patch.age)) ? Number(patch.age) : player.age,
        role: usable(patch.role) ? patch.role : player.role,
        major_championships: Number.isFinite(Number(patch.major_championships))
          ? Number(patch.major_championships)
          : player.major_championships,
        major_appearances: Number.isFinite(Number(patch.major_appearances))
          ? Number(patch.major_appearances)
          : player.major_appearances,
        is_active: typeof patch.is_active === 'boolean' ? patch.is_active : player.is_active,
        production_verified_at: patch.production_verified_at || player.production_verified_at,
      };
    });
  }

  async function loadState() {
    const stored = await getStorage([OVERRIDES_KEY, META_KEY]);
    overrides = stored[OVERRIDES_KEY] && typeof stored[OVERRIDES_KEY] === 'object'
      ? stored[OVERRIDES_KEY]
      : Object.create(null);
    meta = stored[META_KEY] && typeof stored[META_KEY] === 'object'
      ? stored[META_KEY]
      : Object.create(null);
    readyResolve();
  }

  function requestUrl(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return input?.url || '';
  }

  globalThis.fetch = async function fribergProductionAwareFetch(input, init) {
    const url = requestUrl(input);
    const poolUrl = chrome.runtime.getURL(POOL_PATH);
    if (!url || !url.startsWith(poolUrl)) return originalFetch(input, init);
    const response = await originalFetch(input, init);
    if (!response.ok) return response;
    const raw = await response.clone().json();
    await ready;
    const merged = mergePool(raw);
    return new Response(JSON.stringify(merged), {
      status: response.status,
      statusText: response.statusText,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  };

  function playerPatchFromApi(player) {
    if (!player || !usable(player.nickname)) return null;
    return {
      nickname: player.nickname,
      nationality: player.nationality,
      region: player.region,
      team: player.team,
      age: player.age,
      role: player.role,
      major_championships: player.majorChampionships,
      major_appearances: player.majorAppearances,
      is_active: Boolean(player.isActive),
      difficulties: Array.isArray(player.difficulties) ? player.difficulties.slice() : [],
      production_verified_at: new Date().toISOString(),
      source: 'public-player-search',
    };
  }

  function playerPatchFromVisible(parsed) {
    const values = parsed?.reading?.visibleValues;
    if (!parsed?.valid || !usable(parsed.nickname) || !values) return null;
    const active = normalizedStatus(values.status);
    const patch = {
      nickname: parsed.nickname,
      nationality: usable(values.country) ? values.country : undefined,
      team: usable(values.team) ? values.team : undefined,
      age: Number.isFinite(Number(values.age)) ? Number(values.age) : undefined,
      role: usable(values.role) ? values.role : undefined,
      major_championships: Number.isFinite(Number(values.majorWins)) ? Number(values.majorWins) : undefined,
      major_appearances: Number.isFinite(Number(values.majorApps)) ? Number(values.majorApps) : undefined,
      is_active: typeof active === 'boolean' ? active : undefined,
      production_verified_at: new Date().toISOString(),
      source: 'visible-feedback-row',
    };
    return patch;
  }

  async function savePatch(patch) {
    if (!patch) return false;
    const key = normalize(patch.nickname);
    if (!key) return false;
    const previous = overrides[key] || {};
    const next = Object.fromEntries(Object.entries({ ...previous, ...patch }).filter(([, value]) => value !== undefined));
    const changed = JSON.stringify(previous) !== JSON.stringify(next);
    if (!changed) return false;
    overrides[key] = next;
    await setStorage({ [OVERRIDES_KEY]: overrides });
    return true;
  }

  async function learnVisibleRows() {
    const Adapter = globalThis.FribergLiveDomAdapter;
    if (!Adapter?.scan || !Adapter?.feedbackRows || !Adapter?.readFeedbackRow) return;
    try {
      const scan = Adapter.scan(document);
      const boards = (scan.boardCandidates || []).map(candidate => candidate.element).filter(Boolean);
      for (const board of boards) {
        for (const row of Adapter.feedbackRows(board)) {
          const parsed = Adapter.readFeedbackRow(row);
          const patch = playerPatchFromVisible(parsed);
          if (patch) await savePatch(patch);
        }
      }
    } catch {
      // Learning is best-effort and must never disturb the assistant.
    }
  }

  function scheduleVisibleLearning() {
    clearTimeout(observerTimer);
    observerTimer = setTimeout(() => { void learnVisibleRows(); }, 300);
  }

  async function acquireLock() {
    const now = Date.now();
    const stored = await getStorage([LOCK_KEY]);
    const lock = stored[LOCK_KEY];
    if (lock && lock.owner !== owner && Number(lock.expiresAt) > now) return false;
    await setStorage({ [LOCK_KEY]: { owner, expiresAt: now + LOCK_TTL_MS } });
    return true;
  }

  async function renewLock() {
    await setStorage({ [LOCK_KEY]: { owner, expiresAt: Date.now() + LOCK_TTL_MS } });
  }

  async function releaseLock() {
    const stored = await getStorage([LOCK_KEY]);
    if (stored[LOCK_KEY]?.owner === owner) await setStorage({ [LOCK_KEY]: null });
  }

  function emitSync(detail) {
    document.dispatchEvent(new CustomEvent('friberg:production-sync', { detail }));
  }

  async function fetchPlayerList() {
    const response = await originalFetch('/api/players/list', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(`生产选手列表读取失败：${response.status}`);
    return response.json();
  }

  async function fetchExactPlayer(nickname) {
    const response = await originalFetch(`/api/players?search=${encodeURIComponent(nickname)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (response.status === 429) {
      const error = new Error('生产选手搜索触发限流。');
      error.retryAfterMs = 65000;
      throw error;
    }
    if (!response.ok) throw new Error(`生产选手搜索失败：${response.status}`);
    const players = await response.json();
    const wanted = normalize(nickname);
    const exact = (Array.isArray(players) ? players : []).filter(player => normalize(player.nickname) === wanted);
    return exact.length === 1 ? exact[0] : null;
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function runGentleSync() {
    if (syncRunning || location.hostname !== 'shnlfriberg.online') return;
    if (document.visibilityState !== 'visible') return;
    if (!await acquireLock()) return;
    syncRunning = true;
    try {
      const list = await fetchPlayerList();
      const version = String(list?.version || 'unknown');
      const players = Array.isArray(list?.players) ? list.players : [];
      const versionChanged = meta.siteVersion !== version;
      const queue = players.filter(player => {
        const patch = overrides[normalize(player.nickname)];
        return versionChanged || !patch || patch.site_version !== version;
      });
      meta = {
        ...meta,
        siteVersion: version,
        total: players.length,
        pending: queue.length,
        startedAt: meta.startedAt || new Date().toISOString(),
        lastRunAt: new Date().toISOString(),
      };
      await setStorage({ [META_KEY]: meta });
      emitSync({ phase: 'start', version, total: players.length, pending: queue.length });

      for (let index = 0; index < queue.length; index += 1) {
        if (document.visibilityState !== 'visible') break;
        await renewLock();
        const item = queue[index];
        try {
          const full = await fetchExactPlayer(item.nickname);
          const patch = playerPatchFromApi(full);
          if (patch) {
            patch.site_version = version;
            await savePatch(patch);
          }
          meta.pending = queue.length - index - 1;
          meta.completed = (Number(meta.completed) || 0) + (patch ? 1 : 0);
          meta.lastNickname = item.nickname;
          meta.lastError = patch ? '' : '未得到唯一精确结果';
          meta.updatedAt = new Date().toISOString();
          await setStorage({ [META_KEY]: meta });
          emitSync({ phase: 'player', nickname: item.nickname, completed: meta.completed, pending: meta.pending });
          await delay(REQUEST_GAP_MS);
        } catch (cause) {
          const wait = Number(cause?.retryAfterMs) || REQUEST_GAP_MS;
          meta.lastError = cause instanceof Error ? cause.message : String(cause);
          meta.updatedAt = new Date().toISOString();
          await setStorage({ [META_KEY]: meta });
          emitSync({ phase: 'error', nickname: item.nickname, message: meta.lastError, retryAfterMs: wait });
          await delay(wait);
        }
      }
      meta.finishedAt = meta.pending === 0 ? new Date().toISOString() : meta.finishedAt;
      await setStorage({ [META_KEY]: meta });
      emitSync({ phase: meta.pending === 0 ? 'complete' : 'paused', ...meta });
    } catch (cause) {
      meta.lastError = cause instanceof Error ? cause.message : String(cause);
      meta.updatedAt = new Date().toISOString();
      await setStorage({ [META_KEY]: meta });
      emitSync({ phase: 'error', message: meta.lastError });
    } finally {
      syncRunning = false;
      await releaseLock();
    }
  }

  function scheduleGentleSync(delayMs = 4000) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { void runGentleSync(); }, delayMs);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleGentleSync(1200);
  });

  const observer = new MutationObserver(scheduleVisibleLearning);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  globalThis.FribergProductionData = Object.freeze({
    ready,
    mergePool,
    savePatch,
    learnVisibleRows,
    runGentleSync,
    getOverrides: () => ({ ...overrides }),
    getMeta: () => ({ ...meta }),
  });

  void loadState().then(() => {
    scheduleVisibleLearning();
    scheduleGentleSync();
  });
})();
