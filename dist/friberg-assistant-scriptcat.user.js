// ==UserScript==
// @name         弗一把助手 · 真实页面只读诊断
// @namespace    local.friberg-assistant
// @version      0.9.3
// @description  Edge / ScriptCat：识别自己的可见棋盘、严格求解、随机首猜、用户触发的安全填入与提交。
// @match        https://shnlfriberg.online/multi*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// ==/UserScript==

(function bootstrapGameSolver(root) {
  'use strict';

  // This file is deliberately dependency-free so the exact same logic can run
  // in the browser and in the regression runner.  Game feedback is a set of
  // predicates, never a weighted score.
  const FIELD_ORDER = Object.freeze(['team', 'country', 'age', 'role', 'majorWins', 'majorApps', 'status']);
  const NUMERIC_FIELDS = new Set(['age', 'majorWins', 'majorApps']);
  const NUMERIC_TOLERANCE = Object.freeze({ age: 3, majorWins: 1, majorApps: 1 });
  const DATA_DRIFT_WEIGHTS = Object.freeze({
    team: 0.2,
    status: 0.2,
    role: 0.3,
    age: 0.8,
    country: 1.2,
    majorWins: 1.5,
    majorApps: 1.5,
  });
  const COLORS = new Set(['correct', 'close', 'wrong']);

  const REGION_ALIASES = Object.freeze({
    asia: ['asia', '亚洲', '亚太', 'apac'],
    cis: ['cis', '独联体'],
    europe: ['europe', '欧洲'],
    northAmerica: ['north america', '北美', '北美洲'],
    southAmerica: ['south america', '南美', '南美洲'],
    oceania: ['oceania', '大洋洲'],
    africaIsrael: ['africa', '非洲', '非洲与以色列', '非洲和以色列', 'israel', '以色列'],
  });

  // The public game data already carries `region`; this table is only a
  // fail-closed fallback for manually imported compatible game snapshots.
  const COUNTRY_REGION = Object.freeze({
    asia: ['中国', 'china', '蒙古', 'mongolia', '马来西亚', 'malaysia', '印度尼西亚', 'indonesia', '土耳其', 'turkey', '韩国', 'south korea', 'korea', '日本', 'japan', '越南', 'vietnam', '泰国', 'thailand', '印度', 'india', '菲律宾', 'philippines', '新加坡', 'singapore', '中国香港', 'hong kong', '中国台湾', 'taiwan', '阿联酋', 'united arab emirates', '沙特阿拉伯', 'saudi arabia'],
    cis: ['俄罗斯', 'russia', '白俄罗斯', 'belarus', '哈萨克斯坦', 'kazakhstan', '阿塞拜疆', 'azerbaijan', '乌兹别克斯坦', 'uzbekistan'],
    northAmerica: ['美国', 'united states', 'usa', '加拿大', 'canada', '墨西哥', 'mexico'],
    southAmerica: ['巴西', 'brazil', '阿根廷', 'argentina', '智利', 'chile', '秘鲁', 'peru', '哥伦比亚', 'colombia', '乌拉圭', 'uruguay'],
    oceania: ['澳大利亚', 'australia', '新西兰', 'new zealand'],
    africaIsrael: ['以色列', 'israel', '南非', 'south africa', '埃及', 'egypt', '摩洛哥', 'morocco', '突尼斯', 'tunisia'],
  });

  const normalize = value => String(value ?? '').trim().toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ');
  const cleanKey = key => normalize(key).replace(/[_ -]/g, '');
  const numberOrNull = value => {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const match = String(value).match(/-?\d+(?:\.\d+)?/);
    const parsed = match ? Number(match[0]) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };

  function canonicalRegion(value) {
    const normalized = normalize(value);
    if (!normalized) return '';
    for (const [region, aliases] of Object.entries(REGION_ALIASES)) {
      if (aliases.some(alias => normalize(alias) === normalized)) return region;
    }
    return '';
  }

  function inferGameRegion(country) {
    const normalized = normalize(country);
    if (!normalized) return '';
    for (const [region, countries] of Object.entries(COUNTRY_REGION)) {
      if (countries.some(item => normalize(item) === normalized)) return region;
    }
    return '';
  }

  function gameRegionOf(player) {
    return canonicalRegion(player?.gameRegion) || canonicalRegion(player?.region) || inferGameRegion(player?.country);
  }

  function gameRegionFromValue(value, referencePlayers = []) {
    const direct = canonicalRegion(value);
    if (direct) return direct;
    const wanted = normalize(value);
    const matchingPlayer = referencePlayers.find(player => normalize(player.country) === wanted);
    return matchingPlayer ? gameRegionOf(matchingPlayer) : inferGameRegion(value);
  }

  function normalizeRole(role) {
    const value = normalize(role);
    if (/coach|教练/.test(value)) return 'coach';
    if (/awp|sniper|狙/.test(value)) return 'awper';
    if (/igl|leader|指挥/.test(value)) return 'igl';
    if (/support|辅助/.test(value)) return 'support';
    return 'rifler';
  }

  function normalizeStatus(status) {
    if (status === true || status === 1) return 'active';
    if (status === false || status === 0) return 'inactive';
    const value = normalize(status);
    if (value === 'true' || value === '1') return 'active';
    if (value === 'false' || value === '0') return 'inactive';
    if (/retired|退役/.test(value)) return 'retired';
    if (/非现役|未签约|下放|inactive|bench|替补/.test(value)) return 'inactive';
    if (/active|现役|在役/.test(value)) return 'active';
    return 'inactive';
  }

  function normalizeGameStatus(row) {
    if (row.status !== undefined && row.status !== null && String(row.status).trim() !== '') return normalizeStatus(row.status);
    if (row.is_active !== undefined && row.is_active !== null) {
      // The game itself compares Boolean(is_active), so every false value is
      // one status class.  "retired" is the clearest UI label for that class.
      return Boolean(row.is_active) ? 'active' : 'retired';
    }
    if (/退役|retired/i.test(String(row.team || ''))) return 'retired';
    return normalizeStatus(row.active || '');
  }

  function normalizeGamePlayer(row, index = 0) {
    const nick = row.nick || row.player || row.nickname || row.name || `player-${index + 1}`;
    const country = row.country || row.nationality || row.nation || '';
    const region = row.region || inferGameRegion(country);
    const rawTeam = row.team ?? row.currentTeam ?? row.current_team ?? '未签约';
    const rawRole = row.role ?? row.roles ?? '';
    const hasSourceActiveFlag = row.is_active !== undefined && row.is_active !== null;
    return {
      id: row.id || `${normalize(nick)}-${index}`,
      nick,
      realName: row.realName || row.real_name || row.fullName || row.full_name || '',
      country,
      region,
      gameRegion: canonicalRegion(region) || inferGameRegion(country),
      // Keep the values used by the public game engine separate from the
      // localized display values.  Its equality checks are raw and exact.
      gameCountry: country,
      gameTeam: rawTeam,
      gameRole: rawRole,
      gameActive: hasSourceActiveFlag ? Boolean(row.is_active) : normalizeGameStatus(row) === 'active',
      age: numberOrNull(row.age),
      role: normalizeRole(rawRole),
      team: rawTeam,
      status: normalizeGameStatus(row),
      majorWins: numberOrNull(row.majorWins ?? row.major_wins ?? row.majors ?? row.majorChampionships ?? row.major_championships ?? 0) ?? 0,
      majorApps: numberOrNull(row.majorApps ?? row.major_apps ?? row.majorAppearances ?? row.major_appearances ?? 0) ?? 0,
      rating: Number(row.rating) || null,
      hltvUrl: row.hltvUrl || row.hltv_url || '',
      difficulty: row.difficulty || (Array.isArray(row.difficulties) ? row.difficulties.join(', ') : row.difficulties || ''),
      enabled: row.enabled ?? row.is_enabled ?? true,
      source: 'game',
    };
  }

  const normalizeGamePlayers = rows => (Array.isArray(rows) ? rows : []).map(normalizeGamePlayer);
  const playerKey = player => normalize(`${player?.id ?? ''}|${player?.nick ?? ''}|${player?.country ?? ''}`);
  const equalText = (left, right) => Boolean(normalize(left) && normalize(left) === normalize(right));
  const rawGameValue = (player, key) => {
    if (key === 'country') return player?.gameCountry ?? player?.country ?? '';
    if (key === 'team') return player?.gameTeam ?? player?.team ?? '';
    if (key === 'role') return player?.gameRole ?? player?.role ?? '';
    if (key === 'status') return player?.gameActive ?? (normalizeStatus(player?.status) === 'active');
    return player?.[key];
  };

  function fieldValueForGuess(player, key) {
    if (key === 'country') return { country: rawGameValue(player, key), region: gameRegionOf(player) };
    return rawGameValue(player, key);
  }

  function buildFeedback(guess, cells, directions = {}) {
    const fields = {};
    FIELD_ORDER.forEach((key, index) => {
      const color = cells?.[index];
      if (!COLORS.has(color)) return;
      fields[key] = {
        color,
        guess: fieldValueForGuess(guess, key),
        direction: NUMERIC_FIELDS.has(key) ? (directions[key] || 'none') : 'none',
      };
    });
    return {
      version: 1,
      guessedKey: playerKey(guess),
      guessedNick: guess.nick,
      fields,
    };
  }

  function validateFeedback(feedback) {
    const errors = [];
    const warnings = [];
    if (!feedback || !Object.keys(feedback.fields || {}).length) errors.push('没有可用的颜色反馈。');
    Object.entries(feedback?.fields || {}).forEach(([key, field]) => {
      if (!COLORS.has(field.color)) errors.push(`${key} 的颜色无效。`);
      if (field.color === 'close' && !NUMERIC_FIELDS.has(key) && key !== 'country') {
        errors.push(`${key} 在弗一把中没有黄色反馈；请把该格校正为绿或灰。`);
      }
      if (key === 'country' && field.color !== 'correct' && !field.guess?.region) {
        errors.push('无法确定该猜测的游戏赛区，不能安全应用国家反馈。');
      }
      if (NUMERIC_FIELDS.has(key) && field.color !== 'correct' && field.direction === 'none') {
        warnings.push(`${key} 的箭头未识别；已只使用颜色范围，建议手动校正箭头以缩小候选。`);
      }
    });
    return { valid: errors.length === 0, errors, warnings };
  }

  function directionMatches(candidateValue, guessValue, direction) {
    if (direction === 'up') return candidateValue > guessValue;
    if (direction === 'down') return candidateValue < guessValue;
    return true;
  }

  function matchesNumeric(candidate, key, field) {
    const candidateValue = numberOrNull(candidate[key]);
    const guessValue = numberOrNull(field.guess);
    if (candidateValue === null || guessValue === null) return false;
    const distance = Math.abs(candidateValue - guessValue);
    const directionOk = directionMatches(candidateValue, guessValue, field.direction);
    if (field.color === 'correct') return distance === 0;
    if (field.color === 'close') return distance > 0 && distance <= NUMERIC_TOLERANCE[key] && directionOk;
    if (field.color === 'wrong') return distance > NUMERIC_TOLERANCE[key] && directionOk;
    return false;
  }

  function matchesCountry(candidate, field) {
    const guessCountry = field.guess?.country;
    const guessRegion = field.guess?.region;
    const sameCountry = rawGameValue(candidate, 'country') === guessCountry;
    const candidateRegion = gameRegionOf(candidate);
    if (field.color === 'correct') return sameCountry;
    if (!candidateRegion || !guessRegion) return false;
    if (field.color === 'close') return !sameCountry && candidateRegion === guessRegion;
    if (field.color === 'wrong') return candidateRegion !== guessRegion;
    return false;
  }

  function matchesCategorical(candidate, key, field) {
    const actual = rawGameValue(candidate, key);
    const same = actual === field.guess;
    if (field.color === 'correct') return same;
    if (field.color === 'wrong') return !same;
    return false;
  }

  function matchesField(candidate, key, field) {
    if (!field || !COLORS.has(field.color)) return false;
    if (NUMERIC_FIELDS.has(key)) return matchesNumeric(candidate, key, field);
    if (key === 'country') return matchesCountry(candidate, field);
    return matchesCategorical(candidate, key, field);
  }

  function matchesFeedback(candidate, feedback) {
    const validation = validateFeedback(feedback);
    if (!validation.valid) return false;
    return Object.entries(feedback.fields).every(([key, field]) => matchesField(candidate, key, field));
  }

  function compileFieldMatcher(key, field) {
    if (!field || !COLORS.has(field.color)) return () => false;
    if (NUMERIC_FIELDS.has(key)) {
      const guessValue = numberOrNull(field.guess);
      const tolerance = NUMERIC_TOLERANCE[key];
      if (guessValue === null) return () => false;
      if (field.color === 'correct') return candidate => numberOrNull(candidate[key]) === guessValue;
      if (field.color === 'close') return candidate => {
        const value = numberOrNull(candidate[key]);
        return value !== null && Math.abs(value - guessValue) > 0 && Math.abs(value - guessValue) <= tolerance && directionMatches(value, guessValue, field.direction);
      };
      return candidate => {
        const value = numberOrNull(candidate[key]);
        return value !== null && Math.abs(value - guessValue) > tolerance && directionMatches(value, guessValue, field.direction);
      };
    }
    if (key === 'country') {
      const guessCountry = field.guess?.country;
      const guessRegion = field.guess?.region;
      if (field.color === 'correct') return candidate => rawGameValue(candidate, 'country') === guessCountry;
      if (!guessRegion) return () => false;
      if (field.color === 'close') return candidate => rawGameValue(candidate, 'country') !== guessCountry && gameRegionOf(candidate) === guessRegion;
      return candidate => {
        const candidateRegion = gameRegionOf(candidate);
        return Boolean(candidateRegion) && candidateRegion !== guessRegion;
      };
    }
    if (field.color === 'correct') return candidate => rawGameValue(candidate, key) === field.guess;
    if (field.color === 'wrong') return candidate => rawGameValue(candidate, key) !== field.guess;
    return () => false;
  }

  function compileFeedbackMatcher(feedback) {
    if (!validateFeedback(feedback).valid) return null;
    const fieldMatchers = Object.entries(feedback.fields).map(([key, field]) => compileFieldMatcher(key, field));
    return candidate => fieldMatchers.every(matches => matches(candidate));
  }

  function filterCandidates(players, feedbacks, excludedKeys = new Set()) {
    const usableFeedback = (feedbacks || []).filter(Boolean);
    // Compile each screenshot row once, before scanning the pool.  This avoids
    // reparsing the same colors, arrows and text for every candidate.
    const matchers = usableFeedback.map(compileFeedbackMatcher);
    if (matchers.some(matcher => !matcher)) return [];
    return (players || []).filter(player => (
      player.enabled !== false
      && !excludedKeys.has(playerKey(player))
      && matchers.every(matcher => matcher(player))
    ));
  }

  function rankDataDriftCandidates(
    players,
    feedbacks,
    excludedKeys = new Set(),
    maxViolationFields = 1,
    { weights = null, maxScore = null } = {},
  ) {
    const usableFeedback = (feedbacks || []).filter(Boolean);
    if (!usableFeedback.length || usableFeedback.some(feedback => !validateFeedback(feedback).valid)) {
      return Object.freeze({ candidates: [], minViolationFields: null, conflicts: [] });
    }
    const ranked = (players || [])
      .filter(player => player.enabled !== false && !excludedKeys.has(playerKey(player)))
      .map(player => {
        const violatingFields = new Set();
        usableFeedback.forEach(feedback => {
          Object.entries(feedback.fields || {}).forEach(([key, field]) => {
            if (!matchesField(player, key, field)) violatingFields.add(key);
          });
        });
        const fields = Array.from(violatingFields);
        const score = weights
          ? fields.reduce((total, key) => total + (Number(weights[key]) || 1), 0)
          : fields.length;
        return { player, fields, count: fields.length, score };
      })
      .sort((left, right) => left.score - right.score
        || left.count - right.count
        || normalize(left.player.nick).localeCompare(normalize(right.player.nick)));
    const eligible = ranked.filter(entry => (
      entry.count >= 1
      && entry.count <= maxViolationFields
      && (maxScore === null || entry.score <= maxScore)
    ));
    const minScore = eligible[0]?.score ?? null;
    if (minScore === null) {
      return Object.freeze({
        candidates: [],
        minViolationFields: ranked[0]?.count ?? null,
        minScore: ranked[0]?.score ?? null,
        conflicts: [],
      });
    }
    const best = eligible.filter(entry => Math.abs(entry.score - minScore) < 1e-9);
    const minViolationFields = Math.min(...best.map(entry => entry.count));
    return Object.freeze({
      candidates: best.map(entry => entry.player),
      minViolationFields,
      minScore,
      conflicts: best.map(entry => Object.freeze({
        playerKey: playerKey(entry.player),
        nickname: entry.player.nick,
        fields: Object.freeze(entry.fields.slice()),
        score: entry.score,
      })),
    });
  }

  function numericColor(answerValue, probeValue, tolerance) {
    const answer = numberOrNull(answerValue);
    const probe = numberOrNull(probeValue);
    if (answer === null || probe === null) return 'unknown';
    if (answer === probe) return 'correct';
    return Math.abs(answer - probe) <= tolerance ? 'close' : 'wrong';
  }

  function numericDirection(answerValue, probeValue) {
    const answer = numberOrNull(answerValue);
    const probe = numberOrNull(probeValue);
    if (answer === null || probe === null || answer === probe) return 'none';
    return answer > probe ? 'up' : 'down';
  }

  function classifyFeedback(answer, probe, key) {
    if (NUMERIC_FIELDS.has(key)) {
      return {
        color: numericColor(answer[key], probe[key], NUMERIC_TOLERANCE[key]),
        direction: numericDirection(answer[key], probe[key]),
      };
    }
    if (key === 'country') {
      if (rawGameValue(answer, 'country') === rawGameValue(probe, 'country')) return { color: 'correct', direction: 'none' };
      const answerRegion = gameRegionOf(answer);
      const probeRegion = gameRegionOf(probe);
      if (answerRegion && probeRegion && answerRegion === probeRegion) return { color: 'close', direction: 'none' };
      return { color: 'wrong', direction: 'none' };
    }
    return { color: rawGameValue(answer, key) === rawGameValue(probe, key) ? 'correct' : 'wrong', direction: 'none' };
  }

  function feedbackSignature(answer, probe) {
    return FIELD_ORDER.map(key => {
      const feedback = classifyFeedback(answer, probe, key);
      return `${key}:${feedback.color}${feedback.direction === 'none' ? '' : `-${feedback.direction}`}`;
    }).join('|');
  }

  const api = Object.freeze({
    FIELD_ORDER,
    NUMERIC_FIELDS,
    NUMERIC_TOLERANCE,
    DATA_DRIFT_WEIGHTS,
    normalize,
    cleanKey,
    numberOrNull,
    canonicalRegion,
    inferGameRegion,
    gameRegionOf,
    gameRegionFromValue,
    normalizeRole,
    normalizeStatus,
    normalizeGameStatus,
    normalizeGamePlayer,
    normalizeGamePlayers,
    playerKey,
    buildFeedback,
    validateFeedback,
    matchesField,
    matchesFeedback,
    compileFeedbackMatcher,
    filterCandidates,
    rankDataDriftCandidates,
    classifyFeedback,
    feedbackSignature,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GameSolver = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));

(function bootstrapFribergAutomation(root, factory) {
  const solver = root.GameSolver || (typeof module !== 'undefined' && module.exports ? require('./solver.js') : null);
  const api = factory(solver);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FribergAutomation = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createAutomationApi(GameSolver) {
  'use strict';

  if (!GameSolver) throw new Error('FribergAutomation requires GameSolver.');

  const MODES = Object.freeze({ RECOMMEND: 'recommend', SEMI: 'semi', AUTO: 'auto' });
  const STATES = Object.freeze({
    IDLE: 'IDLE',
    WAITING_FOR_ROUND: 'WAITING_FOR_ROUND',
    CHOOSING_GUESS: 'CHOOSING_GUESS',
    FILLING_INPUT: 'FILLING_INPUT',
    WAITING_FOR_DROPDOWN: 'WAITING_FOR_DROPDOWN',
    SUBMITTING: 'SUBMITTING',
    WAITING_FOR_FEEDBACK: 'WAITING_FOR_FEEDBACK',
    SOLVING: 'SOLVING',
    WON: 'WON',
    LOST: 'LOST',
    PAUSED: 'PAUSED',
    ERROR: 'ERROR',
  });

  const COLOR_MAP = Object.freeze({
    green: 'correct', correct: 'correct',
    yellow: 'close', close: 'close',
    gray: 'wrong', grey: 'wrong', wrong: 'wrong',
  });
  const DIRECTION_MAP = Object.freeze({ up: 'up', down: 'down', none: 'none', '': 'none' });
  const ACTION_MODES = new Set([MODES.SEMI, MODES.AUTO]);
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
  const PUBLIC_HOST = 'shnlfriberg.online';

  const transitionGraph = Object.freeze({
    [STATES.IDLE]: new Set([STATES.WAITING_FOR_ROUND, STATES.PAUSED, STATES.ERROR]),
    [STATES.WAITING_FOR_ROUND]: new Set([STATES.CHOOSING_GUESS, STATES.PAUSED, STATES.ERROR, STATES.LOST]),
    [STATES.CHOOSING_GUESS]: new Set([STATES.FILLING_INPUT, STATES.WAITING_FOR_FEEDBACK, STATES.PAUSED, STATES.ERROR, STATES.WON, STATES.LOST]),
    [STATES.FILLING_INPUT]: new Set([STATES.WAITING_FOR_DROPDOWN, STATES.PAUSED, STATES.ERROR]),
    [STATES.WAITING_FOR_DROPDOWN]: new Set([STATES.SUBMITTING, STATES.PAUSED, STATES.ERROR]),
    [STATES.SUBMITTING]: new Set([STATES.WAITING_FOR_FEEDBACK, STATES.PAUSED, STATES.ERROR]),
    [STATES.WAITING_FOR_FEEDBACK]: new Set([STATES.SOLVING, STATES.WON, STATES.LOST, STATES.PAUSED, STATES.ERROR]),
    [STATES.SOLVING]: new Set([STATES.CHOOSING_GUESS, STATES.WON, STATES.LOST, STATES.PAUSED, STATES.ERROR]),
    [STATES.WON]: new Set([STATES.WAITING_FOR_ROUND, STATES.IDLE]),
    [STATES.LOST]: new Set([STATES.WAITING_FOR_ROUND, STATES.IDLE]),
    [STATES.PAUSED]: new Set([STATES.WAITING_FOR_ROUND, STATES.CHOOSING_GUESS, STATES.ERROR, STATES.IDLE]),
    [STATES.ERROR]: new Set([STATES.IDLE, STATES.WAITING_FOR_ROUND, STATES.PAUSED]),
  });

  const makeError = (code, message, details = {}) => Object.assign(new Error(message), { code, details });

  function asUrl(origin) {
    try { return new URL(origin); } catch { return null; }
  }

  function originPolicy(origin, privateOrigins = []) {
    const url = asUrl(origin);
    if (!url) return Object.freeze({ origin, kind: 'unknown', allowedModes: [MODES.RECOMMEND], canRead: false, canAct: false });
    const normalizedOrigin = url.origin;
    const isPublic = url.protocol === 'https:' && url.hostname === PUBLIC_HOST;
    const isLocal = LOCAL_HOSTS.has(url.hostname);
    const isPrivate = privateOrigins.map(String).includes(normalizedOrigin);
    const canAct = isLocal || isPrivate;
    return Object.freeze({
      origin: normalizedOrigin,
      kind: isPublic ? 'public' : isLocal ? 'local' : isPrivate ? 'private' : 'unknown',
      allowedModes: canAct ? [MODES.RECOMMEND, MODES.SEMI, MODES.AUTO] : [MODES.RECOMMEND],
      canRead: isPublic || canAct,
      canAct,
    });
  }

  function assertModeAllowed(policy, mode) {
    if (!policy || !policy.allowedModes.includes(mode)) {
      throw makeError('MODE_NOT_ALLOWED', `模式 ${mode} 不允许在当前来源运行。`, { origin: policy?.origin, mode });
    }
  }

  function canPerformPageAction(policy, mode, adapterAuthorized) {
    return Boolean(policy?.canAct && ACTION_MODES.has(mode) && adapterAuthorized);
  }

  function normalizeColor(value) {
    const color = COLOR_MAP[String(value ?? '').trim().toLowerCase()];
    if (!color) throw makeError('UNKNOWN_COLOR', `无法识别反馈颜色：${value}`);
    return color;
  }

  function normalizeDirection(value) {
    const direction = DIRECTION_MAP[String(value ?? '').trim().toLowerCase()];
    if (!direction) throw makeError('UNKNOWN_DIRECTION', `无法识别数字箭头：${value}`);
    return direction;
  }

  function feedbackFromVisibleReading(guess, reading) {
    if (!guess || !reading) throw makeError('INVALID_READING', '缺少猜测选手或可见反馈。');
    const colors = [
      normalizeColor(reading.team),
      normalizeColor(reading.country),
      normalizeColor(reading.age?.color ?? reading.age),
      normalizeColor(reading.role),
      normalizeColor(reading.majorWins?.color ?? reading.majorWins),
      normalizeColor(reading.majorAppearances?.color ?? reading.majorAppearances),
      normalizeColor(reading.status),
    ];
    const feedback = GameSolver.buildFeedback(guess, colors, {
      age: normalizeDirection(reading.age?.direction),
      majorWins: normalizeDirection(reading.majorWins?.direction),
      majorApps: normalizeDirection(reading.majorAppearances?.direction),
    });
    const validation = GameSolver.validateFeedback(feedback);
    if (!validation.valid) throw makeError('INVALID_FEEDBACK', validation.errors.join(' '), { validation, feedback });
    return feedback;
  }

  function guessFromVisibleReading(guess, reading, referencePlayers = []) {
    const values = reading?.visibleValues;
    if (!guess || !values) return guess;
    const usable = value => value !== null
      && value !== undefined
      && String(value).trim() !== ''
      && !/^[·•.\-—]+$/.test(String(value).trim());
    const valueOr = (key, fallback) => usable(values[key]) ? values[key] : fallback;
    const country = valueOr('country', guess.gameCountry ?? guess.country);
    const status = valueOr('status', guess.gameActive ? 'active' : 'inactive');
    const normalizedStatus = GameSolver.normalizeStatus(status);
    const visibleRole = valueOr('role', guess.gameRole ?? guess.role);
    const canonicalRole = {
      awper: 'AWPer',
      coach: 'Coach',
      rifler: 'Rifler',
    }[GameSolver.normalizeRole(visibleRole)] || visibleRole;
    return GameSolver.normalizeGamePlayer({
      id: guess.id,
      nickname: guess.nick,
      real_name: guess.realName,
      nationality: country,
      region: GameSolver.gameRegionFromValue(country, referencePlayers) || guess.region,
      team: valueOr('team', guess.gameTeam ?? guess.team),
      age: valueOr('age', guess.age),
      role: canonicalRole,
      major_championships: valueOr('majorWins', guess.majorWins),
      major_appearances: valueOr('majorApps', guess.majorApps),
      is_active: normalizedStatus === 'active',
      is_enabled: guess.enabled !== false,
      difficulty: guess.difficulty,
    });
  }

  function buildFeedbackMatrix(players) {
    const roster = (players || []).filter(player => player.enabled !== false);
    const keys = roster.map(GameSolver.playerKey);
    const indexByKey = new Map(keys.map((key, index) => [key, index]));
    const signatures = roster.map(probe => roster.map(answer => GameSolver.feedbackSignature(answer, probe)));
    return Object.freeze({ roster, keys, indexByKey, signatures });
  }

  function candidateSet(players, history, guessedKeys = new Set()) {
    return GameSolver.filterCandidates(players, history, guessedKeys);
  }

  function pickRandomPlayer({ players = [], guessedKeys = new Set(), random = Math.random } = {}) {
    const available = players.filter(player => player?.enabled !== false && !guessedKeys.has(GameSolver.playerKey(player)));
    if (!available.length) return null;
    const sample = Number(random());
    const normalized = Number.isFinite(sample) ? Math.max(0, Math.min(sample, 0.9999999999999999)) : 0;
    return available[Math.floor(normalized * available.length)];
  }

  function calculateEntropy(groups, total) {
    let entropy = 0;
    groups.forEach(size => {
      const probability = size / total;
      entropy -= probability * Math.log2(probability);
    });
    return entropy;
  }

  function compareProbe(left, right) {
    if (!right) return -1;
    if (left.worstGroup !== right.worstGroup) return left.worstGroup - right.worstGroup;
    if (left.expectedRemaining !== right.expectedRemaining) return left.expectedRemaining - right.expectedRemaining;
    if (left.entropy !== right.entropy) return right.entropy - left.entropy;
    if (left.isCandidate !== right.isCandidate) return left.isCandidate ? -1 : 1;
    return GameSolver.normalize(left.player.nick).localeCompare(GameSolver.normalize(right.player.nick));
  }

  function recommendNext({ players, matrix, candidates, guessedKeys = new Set(), remainingGuesses = 8 }) {
    const roster = matrix?.roster || (players || []).filter(player => player.enabled !== false);
    const feedbackMatrix = matrix || buildFeedbackMatrix(roster);
    const legalCandidates = (candidates || []).filter(player => feedbackMatrix.indexByKey.has(GameSolver.playerKey(player)));
    if (!legalCandidates.length) throw makeError('NO_CANDIDATES', '没有满足全部反馈的候选。');

    const candidateIndices = legalCandidates.map(player => feedbackMatrix.indexByKey.get(GameSolver.playerKey(player)));
    const candidateKeys = new Set(legalCandidates.map(GameSolver.playerKey));
    const mustGuessCandidate = legalCandidates.length <= 3 || remainingGuesses <= 2;
    const probeIndices = (mustGuessCandidate ? legalCandidates : roster)
      .map(player => feedbackMatrix.indexByKey.get(GameSolver.playerKey(player)))
      .filter(index => index !== undefined && !guessedKeys.has(feedbackMatrix.keys[index]));
    const usableProbeIndices = probeIndices.length ? probeIndices : candidateIndices;
    let best = null;

    for (const probeIndex of usableProbeIndices) {
      const groups = new Map();
      for (const answerIndex of candidateIndices) {
        const signature = feedbackMatrix.signatures[probeIndex][answerIndex];
        groups.set(signature, (groups.get(signature) || 0) + 1);
      }
      let squares = 0;
      let worstGroup = 0;
      groups.forEach(size => { squares += size * size; worstGroup = Math.max(worstGroup, size); });
      const player = roster[probeIndex];
      const evaluation = {
        player,
        worstGroup,
        expectedRemaining: squares / legalCandidates.length,
        entropy: calculateEntropy(groups, legalCandidates.length),
        partitions: groups.size,
        isCandidate: candidateKeys.has(GameSolver.playerKey(player)),
      };
      if (compareProbe(evaluation, best) < 0) best = evaluation;
    }

    return Object.freeze({
      ...best,
      purpose: best.isCandidate ? 'answer' : 'probe',
      reason: mustGuessCandidate
        ? `剩余 ${remainingGuesses} 次或候选过少，直接猜合法候选。`
        : '先最小化最坏反馈分区，再最小化期望剩余候选。',
    });
  }

  class AssistantSession {
    constructor({
      players,
      origin,
      privateOrigins = [],
      mode = MODES.RECOMMEND,
      matrix = null,
      dataDriftMaxFields = 0,
      dataDriftMaxScore = 0,
    } = {}) {
      this.players = (players || []).filter(player => player.enabled !== false);
      this.policy = originPolicy(origin || '');
      if (privateOrigins.length) this.policy = originPolicy(origin || '', privateOrigins);
      assertModeAllowed(this.policy, mode);
      this.mode = mode;
      this.matrix = matrix || buildFeedbackMatrix(this.players);
      this.state = STATES.IDLE;
      this.history = [];
      this.guessedKeys = new Set();
      this.events = [];
      this.roundId = null;
      this.lastRecommendation = null;
      this.lastCandidates = this.players.slice();
      this.lastResolution = Object.freeze({ mode: 'strict', conflicts: [] });
      this.dataDriftMaxFields = Math.max(0, Number(dataDriftMaxFields) || 0);
      this.dataDriftMaxScore = Math.max(0, Number(dataDriftMaxScore) || 0);
    }

    transition(next, details = {}) {
      if (next !== this.state && !transitionGraph[this.state]?.has(next)) {
        throw makeError('INVALID_TRANSITION', `${this.state} 不能转换为 ${next}。`, { from: this.state, to: next });
      }
      this.state = next;
      this.events.push({ at: new Date().toISOString(), state: next, ...details });
      return this.state;
    }

    setMode(mode) {
      assertModeAllowed(this.policy, mode);
      this.mode = mode;
      return mode;
    }

    startRound(roundId = `local-${Date.now()}`) {
      this.roundId = roundId;
      this.history = [];
      this.guessedKeys = new Set();
      this.lastRecommendation = null;
      this.lastCandidates = this.players.slice();
      this.lastResolution = Object.freeze({ mode: 'strict', conflicts: [] });
      this.transition(STATES.WAITING_FOR_ROUND, { roundId });
      return this.recommend();
    }

    recommend(maxGuesses = 8) {
      let candidates = candidateSet(this.players, this.history, this.guessedKeys);
      let resolution = Object.freeze({ mode: 'strict', conflicts: [] });
      const remainingGuesses = Math.max(0, maxGuesses - this.history.length);
      if (!candidates.length) {
        const weightedDrift = this.dataDriftMaxScore > 0;
        const drift = weightedDrift
          ? GameSolver.rankDataDriftCandidates(
            this.players,
            this.history,
            this.guessedKeys,
            GameSolver.FIELD_ORDER.length,
            { weights: GameSolver.DATA_DRIFT_WEIGHTS, maxScore: this.dataDriftMaxScore },
          )
          : this.dataDriftMaxFields
            ? GameSolver.rankDataDriftCandidates(this.players, this.history, this.guessedKeys, this.dataDriftMaxFields)
          : null;
        if (!drift?.candidates.length) {
          this.transition(STATES.ERROR, { reason: 'NO_CANDIDATES' });
          throw makeError('NO_CANDIDATES', '历史反馈没有合法候选；已停止。');
        }
        candidates = drift.candidates;
        resolution = Object.freeze({
          mode: 'data-drift',
          minViolationFields: drift.minViolationFields,
          minScore: drift.minScore,
          weighted: weightedDrift,
          conflicts: drift.conflicts,
        });
      }
      this.transition(STATES.CHOOSING_GUESS, {
        candidatesBefore: candidates.length,
        resolution: resolution.mode,
      });
      this.lastCandidates = candidates;
      this.lastResolution = resolution;
      this.lastRecommendation = recommendNext({
        players: this.players,
        matrix: this.matrix,
        candidates,
        guessedKeys: this.guessedKeys,
        remainingGuesses,
      });
      return Object.freeze({
        candidates,
        recommendation: this.lastRecommendation,
        remainingGuesses,
        dataDrift: resolution.mode === 'data-drift' ? resolution : null,
      });
    }

    beginPageAction(adapterAuthorized) {
      if (!canPerformPageAction(this.policy, this.mode, adapterAuthorized)) {
        throw makeError('PAGE_ACTION_BLOCKED', '当前来源或模式不允许填写或提交。', { policy: this.policy, mode: this.mode });
      }
      this.transition(STATES.FILLING_INPUT);
      this.transition(STATES.WAITING_FOR_DROPDOWN);
      this.transition(STATES.SUBMITTING);
      this.transition(STATES.WAITING_FOR_FEEDBACK, { guessedKey: GameSolver.playerKey(this.lastRecommendation?.player) });
    }

    recordVisibleFeedback(guess, reading, { won = false, lost = false, maxGuesses = 8 } = {}) {
      const checkpoint = {
        state: this.state,
        historyLength: this.history.length,
        guessedKeys: new Set(this.guessedKeys),
        eventsLength: this.events.length,
        lastRecommendation: this.lastRecommendation,
        lastCandidates: this.lastCandidates,
        lastResolution: this.lastResolution,
      };
      try {
        this.transition(STATES.SOLVING, { guessedKey: GameSolver.playerKey(guess) });
        if (won) {
          this.transition(STATES.WON, { guessedKey: GameSolver.playerKey(guess) });
          return Object.freeze({ won: true, candidates: [guess], recommendation: null });
        }
        const feedback = feedbackFromVisibleReading(guess, reading);
        this.history.push(feedback);
        this.guessedKeys.add(GameSolver.playerKey(guess));
        if (lost || this.history.length >= maxGuesses) {
          this.transition(STATES.LOST, { guessedKey: GameSolver.playerKey(guess) });
          return Object.freeze({ lost: true, feedback, candidates: [] });
        }
        const next = this.recommend(maxGuesses);
        return Object.freeze({ feedback, ...next });
      } catch (cause) {
        this.state = checkpoint.state;
        this.history.splice(checkpoint.historyLength);
        this.guessedKeys = checkpoint.guessedKeys;
        this.events.splice(checkpoint.eventsLength);
        this.lastRecommendation = checkpoint.lastRecommendation;
        this.lastCandidates = checkpoint.lastCandidates;
        this.lastResolution = checkpoint.lastResolution;
        throw cause;
      }
    }

    // A visible row can arrive after a person submits a guess themselves.  That
    // is intentionally different from beginPageAction(): there was no scripted
    // click, but it is still a valid, observable transition into feedback.
    recordObservedVisibleFeedback(guess, reading, options = {}) {
      if (this.state === STATES.WAITING_FOR_ROUND) this.transition(STATES.CHOOSING_GUESS, { source: 'visible-row' });
      if (this.state === STATES.CHOOSING_GUESS) this.transition(STATES.WAITING_FOR_FEEDBACK, { source: 'visible-row', guessedKey: GameSolver.playerKey(guess) });
      return this.recordVisibleFeedback(guess, reading, options);
    }

    pause(reason = 'USER_PAUSED') {
      this.transition(STATES.PAUSED, { reason });
    }
  }

  return Object.freeze({
    MODES,
    STATES,
    COLOR_MAP,
    originPolicy,
    assertModeAllowed,
    canPerformPageAction,
    normalizeColor,
    normalizeDirection,
    feedbackFromVisibleReading,
    guessFromVisibleReading,
    buildFeedbackMatrix,
    candidateSet,
    pickRandomPlayer,
    recommendNext,
    AssistantSession,
  });
}));

(function bootstrapFribergLiveDomAdapter(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FribergLiveDomAdapter = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createFribergLiveDomAdapter() {
  'use strict';

  const ROOT_IDS = new Set(['friberg-assistant-overlay', 'friberg-scriptcat-assistant']);
  const SELF_MARKERS = ['我的猜测', '我的竞猜', 'my guesses', 'my guess'];
  const OPPONENT_MARKERS = ['对方猜测', '对手猜测', 'opponent guesses', 'opponent guess'];
  const WAITING_MARKERS = ['正在获取房间状态', '等待对局', '等待对手', '匹配中', 'waiting for room', 'waiting for opponent'];
  const SENSITIVE_NAME = /(cookie|token|secret|password|passcode|credential|authorization|session|api[-_]?key)/i;
  const EXCLUDED_SELECTOR = '[data-friberg-assistant-overlay], #friberg-assistant-overlay, #friberg-scriptcat-assistant, [class*="chat" i], [class*="message" i], [data-chat], [name*="password" i], [type="password"]';
  const BOARD_SELECTOR = 'table.game-table, [data-friberg-board], [role="grid"], .guess-board, .single-game-board';
  const INPUT_SELECTOR = 'input:not([type="hidden"]):not([type="password"]), textarea';
  const OPTION_SELECTOR = '[role="option"], [data-player-id], [data-playerid], .option, .opt, [class*="dropdown" i] li, [class*="autocomplete" i] li';
  const marks = new Map();

  const FIELD_DEFINITIONS = Object.freeze([
    { key: 'nickname', labels: ['昵称', 'nickname', 'nick'] },
    { key: 'team', labels: ['队伍', '战队', 'team'] },
    { key: 'country', labels: ['国家或地区', '国家', '地区', 'nationality', 'country', 'region'] },
    { key: 'age', labels: ['年龄', 'age'] },
    { key: 'role', labels: ['位置', '角色', 'role', 'position'] },
    { key: 'majorWins', labels: ['major 冠军数', 'major冠军', 'major titles', 'major championships', 'major wins'] },
    { key: 'majorApps', labels: ['major 次数', 'major次数', 'major appearances', 'major appearance'] },
    { key: 'status', labels: ['状态', 'status'] },
  ]);

  const FIELD_NAMES = FIELD_DEFINITIONS.map(field => field.key);

  function isElement(value) {
    return typeof Element !== 'undefined' && value instanceof Element;
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeKey(value) {
    return normalizeText(value).toLocaleLowerCase();
  }

  function compact(value, limit = 440) {
    const text = normalizeText(value);
    return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
  }

  function redact(value) {
    return String(value || '')
      .replace(/(bearer\s+)[a-z0-9._~+/=-]+/ig, '$1[REDACTED]')
      .replace(/([?&](?:token|secret|password|passcode|session|authorization|api[_-]?key)=)[^&#\s"'<]+/ig, '$1[REDACTED]')
      .replace(/(eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})/ig, '[REDACTED_JWT]');
  }

  function isVisible(element) {
    if (!isElement(element)) return false;
    if (element.closest(EXCLUDED_SELECTOR)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
  }

  function isSensitiveElement(element) {
    if (!isElement(element)) return true;
    if (element.closest(EXCLUDED_SELECTOR)) return true;
    const attributes = Array.from(element.attributes || []);
    return attributes.some(attribute => SENSITIVE_NAME.test(attribute.name));
  }

  function classWords(element) {
    return isElement(element) && typeof element.className === 'string'
      ? element.className.split(/\s+/).filter(Boolean).map(normalizeKey)
      : [];
  }

  function pathFor(element, depth = 6) {
    if (!isElement(element)) return '';
    const parts = [];
    let node = element;
    while (isElement(node) && parts.length < depth) {
      const id = node.id && !SENSITIVE_NAME.test(node.id) ? `#${node.id.slice(0, 48)}` : '';
      const classes = classWords(node).filter(name => !SENSITIVE_NAME.test(name)).slice(0, 2).map(name => `.${name}`).join('');
      parts.unshift(`${node.tagName.toLowerCase()}${id || classes}`);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function safeAttributes(element) {
    if (!isElement(element)) return { data: {}, aria: {}, attributes: {} };
    const data = {};
    const aria = {};
    const attributes = {};
    for (const attribute of Array.from(element.attributes || [])) {
      const name = attribute.name.toLowerCase();
      if (SENSITIVE_NAME.test(name)) continue;
      if (!(name === 'id' || name === 'class' || name === 'role' || name.startsWith('data-') || name.startsWith('aria-'))) continue;
      const value = compact(redact(attribute.value), 180);
      if (name.startsWith('data-')) data[name] = value;
      else if (name.startsWith('aria-')) aria[name] = value;
      else attributes[name] = value;
    }
    return { data, aria, attributes };
  }

  function safeOuterHTML(element, limit = 2800) {
    if (!isElement(element)) return '';
    const clone = element.cloneNode(true);
    clone.querySelectorAll?.('script,style,iframe,video,audio,canvas,[type="password"],input,.chat,.message,[data-chat]').forEach(node => node.remove());
    const nodes = [clone, ...Array.from(clone.querySelectorAll?.('*') || [])];
    nodes.forEach((node, index) => {
      if (index > 180) {
        node.remove();
        return;
      }
      Array.from(node.attributes || []).forEach(attribute => {
        const name = attribute.name.toLowerCase();
        if (SENSITIVE_NAME.test(name) || name === 'value' || name === 'srcdoc') node.removeAttribute(attribute.name);
      });
      if (node.matches?.('input,textarea,select')) node.removeAttribute('value');
    });
    return compact(redact(clone.outerHTML), limit);
  }

  function elementDescriptor(element, extra = {}) {
    if (!isElement(element)) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      path: pathFor(element),
      tag: element.tagName.toLowerCase(),
      id: !SENSITIVE_NAME.test(element.id || '') ? element.id || '' : '',
      className: typeof element.className === 'string' ? compact(element.className, 280) : '',
      visibleText: compact(redact(element.innerText || element.textContent || ''), 520),
      attributes: safeAttributes(element),
      outerHTML: safeOuterHTML(element),
      computedStyle: {
        backgroundColor: style.backgroundColor,
        color: style.color,
        borderColor: style.borderColor,
        display: style.display,
      },
      rect: {
        x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
      },
      childElementCount: element.children.length,
      ...extra,
    };
  }

  function textFor(element, limit = 1200) {
    return compact(redact(element?.innerText || element?.textContent || ''), limit);
  }

  function fieldForHeader(value) {
    const normalized = normalizeKey(value);
    if (!normalized) return null;
    if (normalized.includes('major')) {
      if (/(冠军|championship|title|win)/.test(normalized)) return 'majorWins';
      if (/(次数|appearance|attend|参加)/.test(normalized)) return 'majorApps';
    }
    for (const field of FIELD_DEFINITIONS) {
      if (field.labels.some(label => normalized.includes(normalizeKey(label)))) return field.key;
    }
    return null;
  }

  function headersFor(element) {
    if (!isElement(element)) return [];
    const headerNodes = Array.from(element.querySelectorAll('thead th, th, [role="columnheader"]')).filter(isVisible);
    const keys = headerNodes.map(node => fieldForHeader(textFor(node, 120))).filter(Boolean);
    return [...new Set(keys)];
  }

  function cellElements(row) {
    if (!isElement(row)) return [];
    const direct = Array.from(row.children).filter(isVisible);
    const semantic = direct.filter(cell => cell.matches('td,th,[role="gridcell"],[role="cell"]'));
    if (semantic.length) return semantic;
    return direct.filter(cell => normalizeText(cell.innerText) || cell.querySelector('svg,img'));
  }

  function rowElements(board) {
    if (!isElement(board)) return [];
    const candidates = new Set();
    board.querySelectorAll('tbody > tr, tr, [role="row"]').forEach(row => candidates.add(row));
    Array.from(board.children).forEach(row => {
      if (cellElements(row).length >= 7) candidates.add(row);
    });
    return Array.from(candidates).filter(row => isVisible(row) && !isSensitiveElement(row));
  }

  function feedbackRows(board) {
    return rowElements(board).filter(row => {
      if (row.closest('thead')) return false;
      const cells = cellElements(row);
      // Header rows can also contain eight cells. A feedback row must not be
      // composed solely of column headers, whether it is a table or a grid.
      const headerOnly = cells.length > 0 && cells.every(cell => cell.matches('th,[role="columnheader"]'));
      return cells.length === FIELD_NAMES.length && !headerOnly;
    });
  }

  function boardStructuresWithin(element) {
    if (!isElement(element)) return [];
    const structures = Array.from(element.querySelectorAll(BOARD_SELECTOR));
    if (element.matches(BOARD_SELECTOR)) structures.unshift(element);
    return [...new Set(structures)];
  }

  function directBoardLabel(element) {
    if (!isElement(element)) return '';
    const label = Array.from(element.children).find(child => child.matches('h1,h2,h3,h4,[data-board-title],[class*="board-title" i]'));
    return normalizeKey(textFor(label, 240));
  }

  function ownershipForBoard(element) {
    if (!isElement(element)) return { ownership: 'unknown', label: '', container: null };
    const explicitSelf = element.closest('.player-board-self,[data-board-owner="self"],[data-player-board="self"]');
    if (explicitSelf) return { ownership: 'self', label: directBoardLabel(explicitSelf), container: explicitSelf };
    const explicitOpponent = element.closest('.player-board-opponent,[data-board-owner="opponent"],[data-player-board="opponent"]');
    if (explicitOpponent) return { ownership: 'opponent', label: directBoardLabel(explicitOpponent), container: explicitOpponent };
    if (element.querySelector('.masked-cell,[data-masked="true"]')) {
      return { ownership: 'opponent', label: '', container: element };
    }

    let node = element;
    for (let level = 0; isElement(node) && level < 5; level += 1, node = node.parentElement) {
      // Never let a page/boards wrapper containing both players lend its
      // “我的猜测” heading to every nested candidate.
      if (boardStructuresWithin(node).length > 1) break;
      const label = directBoardLabel(node);
      if (!label) continue;
      if (SELF_MARKERS.some(marker => label.includes(marker))) return { ownership: 'self', label, container: node };
      if (OPPONENT_MARKERS.some(marker => label.includes(marker)) || /(?:^|\s)(?:访客|游客|guest|visitor)[#：:\s]/i.test(label)) {
        return { ownership: 'opponent', label, container: node };
      }
    }
    return { ownership: 'unknown', label: '', container: null };
  }

  function evidenceForBoard(element) {
    if (!isElement(element) || !isVisible(element) || isSensitiveElement(element)) return null;
    if (!element.matches(BOARD_SELECTOR) && boardStructuresWithin(element).length > 1) return null;
    const words = classWords(element);
    const headerKeys = headersFor(element);
    const rows = feedbackRows(element);
    const ownershipEvidence = ownershipForBoard(element);
    const reasons = [];
    let score = 0;
    if (element.matches('table')) { score += 2; reasons.push('table'); }
    if (words.includes('game-table')) { score += 10; reasons.push('real-class:game-table'); }
    if (words.some(word => word.includes('guess-board') || word.includes('single-game-board'))) { score += 5; reasons.push('board-class'); }
    if (element.matches('[role="grid"]')) { score += 4; reasons.push('role:grid'); }
    if (headerKeys.length >= 5) { score += headerKeys.length * 2; reasons.push(`headers:${headerKeys.join(',')}`); }
    if (rows.length) { score += 6; reasons.push(`eight-cell-rows:${rows.length}`); }
    const selfEvidence = ownershipEvidence.ownership === 'self';
    if (selfEvidence) { score += 12; reasons.push('self-label'); }
    if (ownershipEvidence.ownership === 'opponent') { score -= 12; reasons.push('opponent-board'); }
    if (element.querySelector('.masked-cell,[data-masked="true"]')) { score -= 8; reasons.push('masked-feedback'); }
    if (element.querySelector(INPUT_SELECTOR)) { score += 1; reasons.push('near-input'); }
    const likelyBoard = words.includes('game-table') || headerKeys.length >= 5 || (rows.length > 0 && score >= 8);
    if (!likelyBoard) return null;
    return {
      element,
      score,
      reasons,
      headers: headerKeys,
      rowCount: rows.length,
      selfEvidence,
      ownership: ownershipEvidence.ownership,
      ownerLabel: ownershipEvidence.label,
    };
  }

  function boardCandidates(documentRef = document) {
    const seeds = new Set();
    documentRef.querySelectorAll(BOARD_SELECTOR).forEach(node => seeds.add(node));
    documentRef.querySelectorAll('table').forEach(node => {
      if (seeds.size > 900) return;
      if (!isVisible(node) || node.closest(EXCLUDED_SELECTOR)) return;
      if (headersFor(node).length >= 5) seeds.add(node);
    });
    const candidates = Array.from(seeds).map(evidenceForBoard).filter(Boolean);
    candidates.sort((left, right) => right.score - left.score || right.rowCount - left.rowCount);
    const deDuplicated = [];
    for (const candidate of candidates) {
      const duplicate = deDuplicated.some(existing => {
        if (existing.element === candidate.element) return true;
        // A table and its presentational wrapper both inherit the same headers
        // and rows. Treat them as one board, while preserving wrappers that
        // actually contain multiple independent tables.
        if (!candidate.element.contains(existing.element)) return false;
        const sameRows = candidate.rowCount === existing.rowCount;
        const sameHeaders = candidate.headers.length === existing.headers.length
          && candidate.headers.every(key => existing.headers.includes(key));
        const nestedTables = candidate.element.querySelectorAll('table').length;
        return sameRows && sameHeaders && nestedTables <= 1;
      });
      if (!duplicate) deDuplicated.push(candidate);
    }
    return deDuplicated.slice(0, 12);
  }

  function scoreInput(element) {
    const text = [element.getAttribute('placeholder'), element.getAttribute('aria-label'), element.name, element.id, element.className].map(normalizeKey).join(' ');
    let score = 0;
    if (/(昵称|选手|player|nick)/.test(text)) score += 8;
    if (element.closest('.input-bar,.player-search-content,[class*="search" i]')) score += 3;
    return score;
  }

  function inputCandidates(documentRef = document) {
    return Array.from(documentRef.querySelectorAll(INPUT_SELECTOR))
      .filter(element => isVisible(element) && !isSensitiveElement(element))
      .map(element => ({ element, score: scoreInput(element), descriptor: elementDescriptor(element) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 12);
  }

  function scoreButton(element) {
    const text = normalizeKey([textFor(element, 150), element.getAttribute('aria-label'), element.title, element.className].join(' '));
    let score = 0;
    if (/(提交猜测|submit guess|提交|guess)/.test(text)) score += 8;
    if (element.matches('[type="submit"]')) score += 3;
    if (element.closest('.input-bar')) score += 2;
    return score;
  }

  function buttonCandidates(documentRef = document) {
    return Array.from(documentRef.querySelectorAll('button,[role="button"],input[type="submit"]'))
      .filter(element => isVisible(element) && !isSensitiveElement(element))
      .map(element => ({ element, score: scoreButton(element), descriptor: elementDescriptor(element) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 16);
  }

  function dropdownCandidates(documentRef = document) {
    return Array.from(documentRef.querySelectorAll('[role="listbox"],[role="option"],.option,.opt,[class*="dropdown" i],[class*="autocomplete" i]'))
      .filter(element => isVisible(element) && !isSensitiveElement(element))
      .map(element => ({ element, descriptor: elementDescriptor(element) }))
      .slice(0, 16);
  }

  function scan(documentRef = document) {
    const boards = boardCandidates(documentRef);
    const ownBoards = boards.filter(candidate => candidate.selfEvidence);
    const autoBoard = ownBoards.length === 1 ? ownBoards[0] : null;
    const main = documentRef.querySelector('main') || documentRef.body;
    const mainText = normalizeKey(textFor(main, 2500));
    return {
      url: location.href,
      route: location.pathname,
      documentTitle: documentRef.title,
      boardCandidates: boards,
      autoBoard,
      ownBoardCount: ownBoards.length,
      inputCandidates: inputCandidates(documentRef),
      buttonCandidates: buttonCandidates(documentRef),
      dropdownCandidates: dropdownCandidates(documentRef),
      waiting: WAITING_MARKERS.some(marker => mainText.includes(marker)),
    };
  }

  function serializeScan(scanResult) {
    const serializeBoard = candidate => ({
      score: candidate.score,
      reasons: candidate.reasons,
      headers: candidate.headers,
      rowCount: candidate.rowCount,
      selfEvidence: candidate.selfEvidence,
      ownership: candidate.ownership,
      ownerLabel: candidate.ownerLabel,
      ...elementDescriptor(candidate.element),
    });
    return {
      url: scanResult.url,
      route: scanResult.route,
      documentTitle: scanResult.documentTitle,
      waiting: scanResult.waiting,
      ownBoardCount: scanResult.ownBoardCount,
      activeAutoBoard: scanResult.autoBoard ? elementDescriptor(scanResult.autoBoard.element) : null,
      candidateBoards: scanResult.boardCandidates.map(serializeBoard),
      candidateTables: Array.from(document.querySelectorAll('table')).filter(isVisible).filter(element => !isSensitiveElement(element)).slice(0, 16).map(elementDescriptor),
      candidateInputs: scanResult.inputCandidates.map(candidate => ({ score: candidate.score, ...candidate.descriptor })),
      candidateButtons: scanResult.buttonCandidates.map(candidate => ({ score: candidate.score, ...candidate.descriptor })),
      candidateDropdowns: scanResult.dropdownCandidates.map(candidate => candidate.descriptor),
    };
  }

  function clearMarks() {
    marks.forEach((previous, element) => {
      if (!isElement(element)) return;
      element.style.outline = previous.outline;
      element.style.outlineOffset = previous.outlineOffset;
      element.style.boxShadow = previous.boxShadow;
      element.removeAttribute('data-friberg-assistant-candidate');
    });
    marks.clear();
  }

  function markBoardCandidates(candidates, activeBoard = null) {
    clearMarks();
    candidates.forEach((candidate, index) => {
      const element = candidate.element || candidate;
      if (!isElement(element)) return;
      marks.set(element, { outline: element.style.outline, outlineOffset: element.style.outlineOffset, boxShadow: element.style.boxShadow });
      const active = element === activeBoard;
      element.style.outline = active ? '3px solid #46e0a0' : `3px solid ${index % 2 ? '#ffb64e' : '#71b8ff'}`;
      element.style.outlineOffset = '4px';
      element.style.boxShadow = active ? '0 0 0 6px rgb(70 224 160 / .18)' : '0 0 0 5px rgb(113 184 255 / .13)';
      element.setAttribute('data-friberg-assistant-candidate', active ? 'active' : 'candidate');
    });
  }

  function findBoardForTarget(target, scanResult) {
    if (!isElement(target)) return null;
    const candidates = scanResult?.boardCandidates || [];
    const found = candidates.filter(candidate => candidate.element === target || candidate.element.contains(target));
    if (found.length) return found.sort((left, right) => right.score - left.score)[0];
    let node = target;
    while (isElement(node)) {
      const candidate = evidenceForBoard(node);
      if (candidate) return candidate;
      node = node.parentElement;
    }
    return null;
  }

  function colorFromClass(cell) {
    if (!isElement(cell)) return null;
    const nodes = [cell, ...Array.from(cell.querySelectorAll(':scope > *')).slice(0, 5)];
    for (const node of nodes) {
      const tokens = [
        ...classWords(node),
        normalizeKey(node.getAttribute('data-feedback')),
        normalizeKey(node.getAttribute('data-state')),
        normalizeKey(node.getAttribute('aria-label')),
      ].filter(Boolean);
      if (tokens.some(token => token === 'correct' || token === 'green')) return 'correct';
      if (tokens.some(token => token === 'close' || token === 'yellow')) return 'close';
      if (tokens.some(token => token === 'wrong' || token === 'gray' || token === 'grey')) return 'wrong';
    }
    return null;
  }

  function directionFromCell(cell) {
    if (!isElement(cell)) return null;
    const nodes = [cell, ...Array.from(cell.querySelectorAll('.dir,svg,[class*="arrow" i],[data-direction],[data-lucide],[aria-label],[title]')).slice(0, 16)];
    for (const node of nodes) {
      const className = node.getAttribute?.('class') || (typeof node.className === 'string' ? node.className : '');
      const signal = normalizeKey([
        node.getAttribute?.('data-direction'),
        node.getAttribute?.('data-lucide'),
        node.getAttribute?.('aria-label'),
        node.getAttribute?.('title'),
        node.innerText,
        node.textContent,
        className,
      ].join(' '));
      if (signal.includes('↑') || /(?:^|[\s_-])(?:arrow[\s_-])?(?:up|increase|higher)(?:$|[\s_-])|向上/.test(signal)) return 'up';
      if (signal.includes('↓') || /(?:^|[\s_-])(?:arrow[\s_-])?(?:down|decrease|lower)(?:$|[\s_-])|向下/.test(signal)) return 'down';
    }
    return null;
  }

  function feedbackRowFingerprint(row) {
    if (!isElement(row)) return '';
    return cellElements(row).map(cell => [
      normalizeText(cell.innerText || cell.textContent),
      cell.getAttribute('class') || '',
      cell.getAttribute('data-feedback') || '',
      cell.getAttribute('data-state') || '',
      Array.from(cell.querySelectorAll('svg,[class*="arrow" i]'))
        .map(node => node.getAttribute('class') || node.getAttribute('data-lucide') || '')
        .join(','),
    ].join('~')).join('||');
  }

  function readFeedbackRow(row) {
    const cells = cellElements(row);
    if (cells.length !== FIELD_NAMES.length) return { valid: false, errors: [`反馈行应有 8 格，当前为 ${cells.length} 格。`] };
    const fields = {};
    const errors = [];
    const visibleValues = {};
    FIELD_NAMES.slice(1).forEach((field, index) => {
      const cell = cells[index + 1];
      const color = colorFromClass(cell);
      const visibleText = normalizeText(cell.innerText || cell.textContent);
      visibleValues[field] = ['age', 'majorWins', 'majorApps'].includes(field)
        ? (visibleText.match(/-?\d+(?:\.\d+)?/)?.[0] || '')
        : visibleText;
      if (!color) {
        errors.push(`${field} 缺少已知 correct/close/wrong 类。`);
        fields[field] = { color: null, direction: null };
        return;
      }
      const numeric = ['age', 'majorWins', 'majorApps'].includes(field);
      const direction = numeric ? directionFromCell(cell) : 'none';
      if (numeric && color !== 'correct' && !direction) errors.push(`${field} 缺少明确的 ↑/↓ 箭头。`);
      fields[field] = { color, direction: direction || 'none' };
    });
    return {
      valid: errors.length === 0,
      errors,
      row,
      nickname: normalizeText(cells[0].innerText),
      cells,
      visibleValues,
      reading: {
        team: fields.team?.color,
        country: fields.country?.color,
        age: fields.age,
        role: fields.role?.color,
        majorWins: fields.majorWins,
        majorAppearances: fields.majorApps,
        status: fields.status?.color,
        visibleValues,
      },
    };
  }

  function summarizeMutation(record) {
    const added = Array.from(record.addedNodes || []).filter(isElement).slice(0, 6).map(node => ({
      tag: node.tagName.toLowerCase(),
      className: typeof node.className === 'string' ? compact(node.className, 120) : '',
      text: compact(redact(node.innerText || node.textContent || ''), 180),
    }));
    return {
      at: new Date().toISOString(),
      type: record.type,
      target: pathFor(record.target),
      attributeName: record.attributeName && !SENSITIVE_NAME.test(record.attributeName) ? record.attributeName : undefined,
      added,
      removedCount: record.removedNodes?.length || 0,
    };
  }

  function appendMutations(buffer, records, limit = 40) {
    records.forEach(record => buffer.push(summarizeMutation(record)));
    if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
    return buffer;
  }

  function diagnostic({ scanResult, activeBoard, recentMutations = [], errors = [], extensionVersion = 'unknown', gamePoolSize = null, adapterState = {} } = {}) {
    const current = scanResult || scan(document);
    const serialized = serializeScan(current);
    return {
      url: location.href,
      timestamp: new Date().toISOString(),
      extensionVersion,
      gamePoolSize,
      documentTitle: document.title,
      route: location.pathname,
      ...serialized,
      activeBoard: activeBoard ? elementDescriptor(activeBoard) : null,
      recentMutations: recentMutations.slice(-40),
      adapterState,
      errors: errors.slice(-20).map(error => compact(redact(error), 560)),
      privacy: {
        cookies: 'not collected',
        storage: 'not collected',
        tokens: 'redacted from supported element text/attributes',
        chat: 'excluded',
      },
    };
  }

  function routeWatcher(onChange) {
    let current = location.href;
    const notify = () => {
      if (current === location.href) return;
      const previous = current;
      current = location.href;
      onChange?.({ previous, current, route: location.pathname });
    };
    const push = history.pushState;
    const replace = history.replaceState;
    history.pushState = function fribergPushState(...args) { const result = push.apply(this, args); queueMicrotask(notify); return result; };
    history.replaceState = function fribergReplaceState(...args) { const result = replace.apply(this, args); queueMicrotask(notify); return result; };
    addEventListener('popstate', notify);
    addEventListener('hashchange', notify);
    return () => {
      if (history.pushState.name === 'fribergPushState') history.pushState = push;
      if (history.replaceState.name === 'fribergReplaceState') history.replaceState = replace;
      removeEventListener('popstate', notify);
      removeEventListener('hashchange', notify);
    };
  }

  function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function exactNicknameIn(text, nickname) {
    const source = normalizeText(text);
    const wanted = normalizeText(nickname);
    if (!wanted) return false;
    if (normalizeKey(source) === normalizeKey(wanted)) return true;
    const boundary = new RegExp(`(^|[\\s·•,，;；:/()（）\\[\\]{}|])${escapeRegExp(wanted)}(?=$|[\\s·•,，;；:/()（）\\[\\]{}|])`, 'i');
    return boundary.test(source);
  }

  function playerIdentityScore(element, player) {
    const text = textFor(element, 800);
    const attributes = safeAttributes(element);
    const allAttributes = Object.values(attributes.data).concat(Object.values(attributes.aria), Object.values(attributes.attributes)).join(' ');
    const nickname = player?.nick || player?.nickname || '';
    const exactNickname = exactNicknameIn(text, nickname) || exactNicknameIn(allAttributes, nickname);
    const knownId = player?.id || player?.playerId || player?.player_id || '';
    const dataId = element.getAttribute('data-player-id') || element.getAttribute('data-playerid') || element.getAttribute('data-id') || '';
    const idMatches = Boolean(knownId && dataId && String(knownId) === String(dataId));
    const details = [player?.team, player?.country, player?.nationality, player?.region].filter(Boolean);
    const matches = details.filter(value => normalizeKey(text).includes(normalizeKey(value)) || normalizeKey(allAttributes).includes(normalizeKey(value)));
    return { exactNickname, idMatches, matchedDetails: matches.length, text, element };
  }

  function optionElements(documentRef = document) {
    return Array.from(documentRef.querySelectorAll(OPTION_SELECTOR))
      .filter(element => isVisible(element) && !isSensitiveElement(element))
      .filter(element => !element.closest('#friberg-assistant-overlay,#friberg-scriptcat-assistant'));
  }

  function uniqueOptionForPlayer({ player, players = [], documentRef = document } = {}) {
    const nickname = player?.nick || player?.nickname;
    if (!nickname) return { status: 'error', message: '缺少要填入的选手昵称。' };
    const sameNicknameCount = players.filter(candidate => normalizeKey(candidate.nick || candidate.nickname) === normalizeKey(nickname)).length;
    const entries = optionElements(documentRef).map(element => playerIdentityScore(element, player));
    const matching = entries.filter(entry => entry.exactNickname || entry.idMatches);
    const strict = sameNicknameCount > 1
      ? matching.filter(entry => entry.idMatches || entry.matchedDetails > 0)
      : matching;
    if (!strict.length) return { status: 'missing', message: `下拉列表未出现可唯一确认的 ${nickname}。` };
    const top = strict.filter(entry => entry.idMatches || entry.matchedDetails === Math.max(...strict.map(item => item.matchedDetails)));
    if (top.length !== 1) return { status: 'ambiguous', message: `${nickname} 有 ${top.length} 个相似下拉候选，未选择第一项。`, candidates: top.map(entry => elementDescriptor(entry.element)) };
    return { status: 'unique', element: top[0].element, descriptor: elementDescriptor(top[0].element), message: `已唯一确认 ${nickname}。` };
  }

  function setNativeInputValue(input, value) {
    if (!isElement(input)) throw new Error('没有可写入的搜索框。');
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) throw new Error('浏览器未提供原生 value setter。');
    setter.call(input, value);
    const inputEvent = typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })
      : new Event('input', { bubbles: true });
    input.dispatchEvent(inputEvent);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Unidentified' }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
  }

  function waitForUniqueOption({ player, players, documentRef, timeoutMs = 1600 } = {}) {
    return new Promise(resolve => {
      const immediate = uniqueOptionForPlayer({ player, players, documentRef });
      if (immediate.status === 'unique' || immediate.status === 'ambiguous') {
        resolve(immediate);
        return;
      }
      let observer = null;
      const finish = result => {
        observer?.disconnect();
        clearTimeout(timer);
        resolve(result);
      };
      observer = new MutationObserver(() => {
        const result = uniqueOptionForPlayer({ player, players, documentRef });
        if (result.status === 'unique' || result.status === 'ambiguous') finish(result);
      });
      observer.observe(documentRef.body, { childList: true, subtree: true });
      const timer = setTimeout(() => finish(uniqueOptionForPlayer({ player, players, documentRef })), timeoutMs);
    });
  }

  async function fillAndSelectUniqueOption({ input, player, players = [], documentRef = document, timeoutMs = 1600 } = {}) {
    const nickname = player?.nick || player?.nickname;
    if (!nickname) return { status: 'error', message: '没有可填入的推荐选手。' };
    setNativeInputValue(input, nickname);
    const option = await waitForUniqueOption({ player, players, documentRef, timeoutMs });
    if (option.status !== 'unique') {
      const exactLocalMatches = players.filter(candidate => normalizeKey(candidate.nick || candidate.nickname) === normalizeKey(nickname));
      const textOnlyAccepted = option.status === 'missing'
        && exactLocalMatches.length === 1
        && normalizeKey(input.value) === normalizeKey(nickname);
      if (textOnlyAccepted) {
        return {
          status: 'selected',
          selectionMode: 'validated-text',
          filled: nickname,
          selected: null,
          submitted: false,
          message: `原网页没有提供下拉列表；已按 646 人题库唯一昵称确认 ${nickname}。`,
        };
      }
      return { ...option, filled: nickname, submitted: false };
    }
    option.element.click();
    return {
      status: 'selected',
      selectionMode: 'dropdown',
      filled: nickname,
      selected: option.descriptor,
      submitted: false,
      message: `已填入并选择 ${nickname}；未点击最终提交。`,
    };
  }

  function uniqueSubmitButton({ scanResult = null, input = null, documentRef = document } = {}) {
    const candidates = (scanResult || scan(documentRef)).buttonCandidates
      .filter(candidate => candidate.score >= 8)
      .map(candidate => {
        const inputContainer = input?.closest('.input-bar,.player-search-content,[class*="search" i]') || null;
        const sameContainer = Boolean(input && (
          candidate.element.form && candidate.element.form === input.form
          || inputContainer && candidate.element.closest('.input-bar,.player-search-content,[class*="search" i]') === inputContainer
        ));
        return { ...candidate, submitScore: candidate.score + (sameContainer ? 4 : 0) };
      })
      .sort((left, right) => right.submitScore - left.submitScore);
    if (!candidates.length) return { status: 'missing', message: '未找到原网页的“提交猜测”按钮。' };
    const topScore = candidates[0].submitScore;
    const top = candidates.filter(candidate => candidate.submitScore === topScore);
    if (top.length !== 1) {
      return {
        status: 'ambiguous',
        message: `发现 ${top.length} 个同分提交按钮，未执行提交。`,
        candidates: top.map(candidate => candidate.descriptor),
      };
    }
    return { status: 'unique', element: top[0].element, descriptor: top[0].descriptor };
  }

  function submitSelectedGuess({ input, player, scanResult = null, documentRef = document } = {}) {
    const nickname = player?.nick || player?.nickname;
    if (!input || !nickname) return { status: 'error', submitted: false, message: '缺少已选择的选手或搜索框。' };
    if (normalizeKey(input.value) !== normalizeKey(nickname)) {
      return { status: 'mismatch', submitted: false, message: `搜索框内容已变化；当前不是已选择的 ${nickname}。` };
    }
    const submit = uniqueSubmitButton({ scanResult, input, documentRef });
    if (submit.status !== 'unique') return { ...submit, submitted: false };
    const button = submit.element;
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
      return { status: 'disabled', submitted: false, button: submit.descriptor, message: '原网页提交按钮尚未启用；请确认已选中下拉选手。' };
    }
    button.click();
    return {
      status: 'submitted',
      submitted: true,
      player: nickname,
      button: submit.descriptor,
      message: `已按你的点击提交 ${nickname}，正在等待反馈行。`,
    };
  }

  return Object.freeze({
    VERSION: '0.9.3',
    FIELD_NAMES,
    scan,
    serializeScan,
    elementDescriptor,
    boardCandidates,
    feedbackRows,
    feedbackRowFingerprint,
    readFeedbackRow,
    findBoardForTarget,
    markBoardCandidates,
    clearMarks,
    appendMutations,
    diagnostic,
    routeWatcher,
    uniqueOptionForPlayer,
    setNativeInputValue,
    fillAndSelectUniqueOption,
    uniqueSubmitButton,
    submitSelectedGuess,
    normalizeText,
  });
}));


(() => {
  'use strict';

  const RAW_PLAYERS = [
  {
    "nickname": "1eer",
    "nationality": "白俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "910",
    "nationality": "蒙古",
    "region": "亚太",
    "team": "The MongolZ",
    "age": 24,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "abe",
    "nationality": "美国",
    "region": "北美洲",
    "team": "未签约/已下放",
    "age": 33,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "ablej",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "退役",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "ace",
    "nationality": "印度",
    "region": "亚太",
    "team": "退役",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "Acilion",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "Preasy",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "acor",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "Sashi",
    "age": 29,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "adamb",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "OG",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "adams",
    "nationality": "罗马尼亚",
    "region": "欧洲",
    "team": "Sangal",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "adren（哈萨克斯坦）",
    "nationality": "哈萨克斯坦",
    "region": "独联体",
    "team": "NOVAQ",
    "age": 36,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 12,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "adren（美国）",
    "nationality": "美国",
    "region": "北美洲",
    "team": "未签约/已下放",
    "age": 36,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "advent",
    "nationality": "中国",
    "region": "亚太",
    "team": "退役",
    "age": 34,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "aerial",
    "nationality": "芬兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "afro",
    "nationality": "法国",
    "region": "欧洲",
    "team": "Luminosity",
    "age": 27,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "aizy",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "Preasy",
    "age": 30,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 11,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Aleksib",
    "nationality": "芬兰",
    "region": "欧洲",
    "team": "Natus Vincere",
    "age": 29,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 10,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "ALEX（英国）",
    "nationality": "英国",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "alex（西班牙）",
    "nationality": "西班牙",
    "region": "欧洲",
    "team": "Gentle Mates",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "alex666",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "B8",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "alexrr",
    "nationality": "德国",
    "region": "欧洲",
    "team": "退役",
    "age": 31,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "alistair",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "THUNDER dOWNUNDER",
    "age": 28,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "allu",
    "nationality": "芬兰",
    "region": "欧洲",
    "team": "ENCE",
    "age": 34,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 7,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "almazer",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "amanek",
    "nationality": "法国",
    "region": "欧洲",
    "team": "Julie&Cie",
    "age": 32,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "android",
    "nationality": "加拿大",
    "region": "北美洲",
    "team": "退役",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "ange1",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "退役",
    "age": 36,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 9,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "anger",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 38,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "annihilation",
    "nationality": "蒙古",
    "region": "亚太",
    "team": "The Huns",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "apEX",
    "nationality": "法国",
    "region": "欧洲",
    "team": "Vitality",
    "age": 33,
    "role": "Rifler",
    "major_championships": 4,
    "major_appearances": 22,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "ariucle",
    "nationality": "蒙古",
    "region": "亚太",
    "team": "5star",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "arrozdoce",
    "nationality": "葡萄牙",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "arT",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Legacy",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 10,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "arya",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 33,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "asap",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "THUNDER dOWNUNDER",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "astarr",
    "nationality": "印度",
    "region": "亚太",
    "team": "退役",
    "age": 34,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "Attacker",
    "nationality": "中国",
    "region": "亚太",
    "team": "退役",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "auman",
    "nationality": "中国",
    "region": "亚太",
    "team": "退役",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "autimatic",
    "nationality": "美国",
    "region": "北美洲",
    "team": "未签约/已下放",
    "age": 29,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 5,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "AW",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "magic",
    "age": 20,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Ax1le",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "TDK",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "azk",
    "nationality": "加拿大",
    "region": "北美洲",
    "team": "退役",
    "age": 35,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "azr",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "FlyQuest",
    "age": 33,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 8,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "AZUWU",
    "nationality": "英国",
    "region": "欧洲",
    "team": "Luminosity",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "b1ad3",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "Natus Vincere",
    "age": 39,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 9,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "b1t",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "Natus Vincere",
    "age": 23,
    "role": "Rifler",
    "major_championships": 2,
    "major_appearances": 9,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "b4rtin",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "balblna",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "K27",
    "age": 30,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "bart4k",
    "nationality": "蒙古",
    "region": "亚太",
    "team": "The Huns",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "beastik",
    "nationality": "捷克",
    "region": "欧洲",
    "team": "SINNERS",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "BELCHONOKK",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "TDK",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "bendji",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 30,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "berg",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "退役",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "biguzera",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "paiN",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 7,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "blackpoison",
    "nationality": "南非",
    "region": "非洲与以色列",
    "team": "退役",
    "age": 33,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "blameF",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "BIG",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "blitz",
    "nationality": "蒙古",
    "region": "亚太",
    "team": "The MongolZ",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 8,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "bnTeT",
    "nationality": "印度尼西亚",
    "region": "亚太",
    "team": "Alter Ego",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "bodyy",
    "nationality": "法国",
    "region": "欧洲",
    "team": "OG",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 9,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "boltz",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "bondik",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "FAVBET",
    "age": 33,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 7,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "boombl4",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "BetBoom",
    "age": 27,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 10,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "boros",
    "nationality": "约旦",
    "region": "亚太",
    "team": "Alter Ego",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "br0",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "Eternal Fire",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "brehze",
    "nationality": "美国",
    "region": "北美洲",
    "team": "未签约/已下放",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "brnz4n",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "MIBR",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "broky",
    "nationality": "拉脱维亚",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 25,
    "role": "AWPer",
    "major_championships": 1,
    "major_appearances": 7,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Brollan",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "HEROIC",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 9,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "buda",
    "nationality": "阿根廷",
    "region": "南美洲",
    "team": "BESTIA",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "buster",
    "nationality": "哈萨克斯坦",
    "region": "独联体",
    "team": "DEPO",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "buzz",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "byali",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 32,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 13,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "bymas",
    "nationality": "立陶宛",
    "region": "欧洲",
    "team": "Luminosity",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "C4LLM3SU3",
    "nationality": "中国",
    "region": "亚太",
    "team": "Lynn Vision",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "cacanito",
    "nationality": "北马其顿",
    "region": "欧洲",
    "team": "JiJieHao",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "cadian",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "OG",
    "age": 31,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 8,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "cajunb",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "退役",
    "age": 36,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 13,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "calyx",
    "nationality": "土耳其",
    "region": "亚太",
    "team": "未签约/已下放",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "CaptainMo",
    "nationality": "中国",
    "region": "亚太",
    "team": "Steel Helmet",
    "age": 37,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "ceh9",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "退役",
    "age": 37,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "cent",
    "nationality": "南非",
    "region": "非洲与以色列",
    "team": "退役",
    "age": 39,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "centeks",
    "nationality": "挪威",
    "region": "欧洲",
    "team": "退役",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "cerq",
    "nationality": "保加利亚",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 26,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "chayjesus",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "chelo",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Imperial",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "childking",
    "nationality": "中国",
    "region": "亚太",
    "team": "未签约/已下放",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "chopper",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 29,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 11,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "chr1zn",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "HEROIC",
    "age": 19,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "chrisj",
    "nationality": "荷兰",
    "region": "欧洲",
    "team": "退役",
    "age": 36,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 10,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "cmtry",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "FUT",
    "age": 18,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "cobrazera",
    "nationality": "蒙古",
    "region": "亚太",
    "team": "未签约/已下放",
    "age": 20,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "coldyy1",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "退役",
    "age": 34,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "coldzera",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 31,
    "role": "Rifler",
    "major_championships": 2,
    "major_appearances": 11,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "colon",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "退役",
    "age": 35,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "controlez",
    "nationality": "蒙古",
    "region": "亚太",
    "team": "The Huns",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "cool4st",
    "nationality": "蒙古",
    "region": "亚太",
    "team": "未签约/已下放",
    "age": 24,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "cruc1al",
    "nationality": "荷兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 29,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "crush",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Cxzi",
    "nationality": "美国",
    "region": "北美洲",
    "team": "Wildcard",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "cype",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "退役",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "cypher",
    "nationality": "英国",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "d1Ledez",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "BetBoom",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "dank1ng",
    "nationality": "中国",
    "region": "亚太",
    "team": "未签约/已下放",
    "age": 26,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "daps",
    "nationality": "加拿大",
    "region": "北美洲",
    "team": "NRG",
    "age": 32,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "dav1deus",
    "nationality": "智利",
    "region": "南美洲",
    "team": "Fluxo",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "dav1g",
    "nationality": "西班牙",
    "region": "欧洲",
    "team": "Gentle Mates",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "davcost",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 30,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "davey",
    "nationality": "加拿大",
    "region": "北美洲",
    "team": "退役",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "dazed",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 36,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "DD",
    "nationality": "中国",
    "region": "亚太",
    "team": "退役",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "deadfox",
    "nationality": "匈牙利",
    "region": "欧洲",
    "team": "退役",
    "age": 31,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "DeathZz",
    "nationality": "西班牙",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "decenty",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Imperial",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "degster",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 24,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "delpan",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "退役",
    "age": 36,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "dem0n",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "FUT",
    "age": 18,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "DemQQ",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "denis",
    "nationality": "德国",
    "region": "欧洲",
    "team": "退役",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 9,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "dennis",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "退役",
    "age": 35,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 10,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "dephh",
    "nationality": "英国",
    "region": "欧洲",
    "team": "M80",
    "age": 34,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "desi",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 33,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "destiny",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "detrony",
    "nationality": "南非",
    "region": "非洲与以色列",
    "team": "退役",
    "age": 35,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "deviant",
    "nationality": "南非",
    "region": "非洲与以色列",
    "team": "退役",
    "age": 38,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "device",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "100 Thieves",
    "age": 30,
    "role": "AWPer",
    "major_championships": 4,
    "major_appearances": 17,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "devil",
    "nationality": "法国",
    "region": "欧洲",
    "team": "退役",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "devilwalk",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "退役",
    "age": 35,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "devoduvek",
    "nationality": "法国",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "dexter",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "THUNDER dOWNUNDER",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 7,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "dgt",
    "nationality": "乌拉圭",
    "region": "南美洲",
    "team": "9z",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "dickstacy",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "退役",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "dimaoneshot",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "退役",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "dimasick",
    "nationality": "哈萨克斯坦",
    "region": "独联体",
    "team": "退役",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "disco-doplan",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "退役",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "disturbed",
    "nationality": "芬兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 33,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Djoko",
    "nationality": "法国",
    "region": "欧洲",
    "team": "GenOne",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "doc",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Sharks",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "donk",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "Spirit",
    "age": 19,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 5,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "dosia",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "退役",
    "age": 38,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 11,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "doto",
    "nationality": "芬兰",
    "region": "欧洲",
    "team": "HEROIC",
    "age": 30,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "draken",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "Johnny Speeds",
    "age": 30,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "drop",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "dumau",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Legacy",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "dumz",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "退役",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "dupreeh",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "退役",
    "age": 33,
    "role": "Rifler",
    "major_championships": 5,
    "major_appearances": 18,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "dycha",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "dziugss",
    "nationality": "立陶宛",
    "region": "欧洲",
    "team": "FUT",
    "age": 17,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "edward",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "退役",
    "age": 38,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 13,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "Efire",
    "nationality": "蒙古",
    "region": "亚太",
    "team": "Chinggis Warriors",
    "age": 20,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "el1an",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "SPARTA",
    "age": 26,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "electronic",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "BC.Game",
    "age": 27,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 13,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "elige",
    "nationality": "美国",
    "region": "北美洲",
    "team": "Liquid",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 17,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "emagine",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "退役",
    "age": 35,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "EmiliaQAQ",
    "nationality": "中国",
    "region": "亚太",
    "team": "Lynn Vision",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "erkast",
    "nationality": "蒙古",
    "region": "亚太",
    "team": "NEXVOID",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "es3tag",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "esenthial",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "B8",
    "age": 20,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "espiranto",
    "nationality": "立陶宛",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "ethan",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "ewjerkz",
    "nationality": "葡萄牙",
    "region": "欧洲",
    "team": "SAW",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "ex3rcice",
    "nationality": "法国",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "ex6tenz",
    "nationality": "比利时",
    "region": "欧洲",
    "team": "退役",
    "age": 36,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 8,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "exit",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Fluxo",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "exr",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "退役",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "f0rest",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "退役",
    "age": 38,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 12,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "F1KU",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "Metizport",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "facecrack",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "PsychoFace",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Fallen",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "FURIA",
    "age": 35,
    "role": "Rifler",
    "major_championships": 2,
    "major_appearances": 19,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "fame",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "TDK",
    "age": 23,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "FaNg",
    "nationality": "加拿大",
    "region": "北美洲",
    "team": "未签约/已下放",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Farlig",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "退役",
    "age": 27,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "fashr",
    "nationality": "荷兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "faveN",
    "nationality": "德国",
    "region": "欧洲",
    "team": "BIG",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "fEAR",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "fnatic",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "fel1x",
    "nationality": "德国",
    "region": "欧洲",
    "team": "退役",
    "age": 38,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "felps",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 7,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "fer",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 34,
    "role": "Rifler",
    "major_championships": 2,
    "major_appearances": 14,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "fetish",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 39,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "fifflaren",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "退役",
    "age": 38,
    "role": "AWPer",
    "major_championships": 1,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "fitch",
    "nationality": "哈萨克斯坦",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 34,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "FL1T",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 25,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 7,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "fl4mus",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "GamerLegion",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "flameZ",
    "nationality": "以色列",
    "region": "非洲与以色列",
    "team": "Vitality",
    "age": 23,
    "role": "Rifler",
    "major_championships": 2,
    "major_appearances": 7,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "flamie",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 12,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "floppy",
    "nationality": "美国",
    "region": "北美洲",
    "team": "未签约/已下放",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "flusha",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "退役",
    "age": 32,
    "role": "Rifler",
    "major_championships": 3,
    "major_appearances": 14,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "FNS",
    "nationality": "加拿大",
    "region": "北美洲",
    "team": "退役",
    "age": 34,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "fnx",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "退役",
    "age": 36,
    "role": "Rifler",
    "major_championships": 2,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "forester",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "fox",
    "nationality": "葡萄牙",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 39,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "freakazoid",
    "nationality": "美国",
    "region": "北美洲",
    "team": "未签约/已下放",
    "age": 33,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "freeman",
    "nationality": "中国",
    "region": "亚太",
    "team": "未签约/已下放",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "friberg",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "退役",
    "age": 34,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 9,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "friis",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 37,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "frozen",
    "nationality": "斯洛伐克",
    "region": "欧洲",
    "team": "FaZe",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 8,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "fugly",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "furlan",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "退役",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "fxy0",
    "nationality": "法国",
    "region": "欧洲",
    "team": "退役",
    "age": 34,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "gade",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "FaZe Up Next",
    "age": 31,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "gafolo",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Sharks",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "GeT-RiGhT",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "退役",
    "age": 36,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 12,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "Gizmy",
    "nationality": "英国",
    "region": "欧洲",
    "team": "100 Thieves",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "gla1ve",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "100 Thieves",
    "age": 31,
    "role": "Coach",
    "major_championships": 4,
    "major_appearances": 14,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "GMX",
    "nationality": "法国",
    "region": "欧洲",
    "team": "退役",
    "age": 33,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "gob-b",
    "nationality": "德国",
    "region": "欧洲",
    "team": "退役",
    "age": 38,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "golden",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Goofy",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "gr1ks",
    "nationality": "白俄罗斯",
    "region": "独联体",
    "team": "BIG",
    "age": 20,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "gratisfaction",
    "nationality": "新西兰",
    "region": "大洋洲",
    "team": "未签约/已下放",
    "age": 30,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Graviti",
    "nationality": "法国",
    "region": "欧洲",
    "team": "3DMAX",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Grim",
    "nationality": "美国",
    "region": "北美洲",
    "team": "NRG",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 8,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "gruby",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "guardian",
    "nationality": "斯洛伐克",
    "region": "欧洲",
    "team": "退役",
    "age": 35,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 14,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "gxx-",
    "nationality": "塞尔维亚科索沃",
    "region": "欧洲",
    "team": "ASTRAL",
    "age": 27,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "hades",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 26,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "hallzerk",
    "nationality": "挪威",
    "region": "欧洲",
    "team": "NRG",
    "age": 26,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "hampus",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "Johnny Speeds",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "happy",
    "nationality": "法国",
    "region": "欧洲",
    "team": "退役",
    "age": 34,
    "role": "Rifler",
    "major_championships": 2,
    "major_appearances": 11,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "hardstyle",
    "nationality": "土耳其",
    "region": "亚太",
    "team": "未签约/已下放",
    "age": 43,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "hardzao",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Fake do Biru",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "harts",
    "nationality": "法国",
    "region": "欧洲",
    "team": "退役",
    "age": 40,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "hasteka",
    "nationality": "蒙古",
    "region": "亚太",
    "team": "Chinggis Warriors",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "hatz",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "未签约/已下放",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "havoc",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "退役",
    "age": 36,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "hazed",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 37,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "headtr1ck",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "Inner Circle",
    "age": 22,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "heavygod",
    "nationality": "以色列",
    "region": "非洲与以色列",
    "team": "G2",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "hen1",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 31,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "HexT",
    "nationality": "加拿大",
    "region": "北美洲",
    "team": "Wildcard",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "hiko",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 36,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 9,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "history",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Patins da Ferrari",
    "age": 22,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "hobbit",
    "nationality": "哈萨克斯坦",
    "region": "独联体",
    "team": "PARIVISION",
    "age": 32,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 9,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "hooch",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 39,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "hooxi",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "Astralis",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "HS",
    "nationality": "爱沙尼亚",
    "region": "欧洲",
    "team": "Millennium",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "HUASOPEEK",
    "nationality": "智利",
    "region": "南美洲",
    "team": "9z",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "hunden",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "Sashi",
    "age": 35,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "hunter-",
    "nationality": "波黑",
    "region": "欧洲",
    "team": "G2",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 9,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "hutji",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "退役",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "hyper",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "退役",
    "age": 36,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "hypex",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "GamerLegion",
    "age": 22,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "icy",
    "nationality": "哈萨克斯坦",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 20,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "iM",
    "nationality": "罗马尼亚",
    "region": "欧洲",
    "team": "Natus Vincere",
    "age": 26,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 7,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "imoRR",
    "nationality": "土耳其",
    "region": "亚太",
    "team": "未签约/已下放",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "innocent",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "KOLESIE",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "ins",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "FlyQuest",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 8,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "insani",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "MIBR",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "interz",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "iorek",
    "nationality": "法国",
    "region": "欧洲",
    "team": "退役",
    "age": 37,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "isak",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "iSSAA",
    "nationality": "约旦",
    "region": "亚太",
    "team": "退役",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "jabbi",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "Astralis",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "jackasmo",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "fnatic",
    "age": 19,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "jackz",
    "nationality": "法国",
    "region": "欧洲",
    "team": "Hashiras",
    "age": 34,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "jambo",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "fnatic",
    "age": 21,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Jame",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "PARIVISION",
    "age": 27,
    "role": "AWPer",
    "major_championships": 1,
    "major_appearances": 10,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "James",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "未签约/已下放",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Jamyoung",
    "nationality": "中国",
    "region": "亚太",
    "team": "TYLOO",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "jasonR",
    "nationality": "加拿大",
    "region": "北美洲",
    "team": "退役",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "JBa",
    "nationality": "美国",
    "region": "北美洲",
    "team": "M80",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "jcobbb",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "FaZe",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "JDC",
    "nationality": "德国",
    "region": "欧洲",
    "team": "BIG",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Jdm64",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 36,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "jee",
    "nationality": "中国",
    "region": "亚太",
    "team": "TYLOO",
    "age": 21,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Jeorge",
    "nationality": "美国",
    "region": "北美洲",
    "team": "NRG",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Jerry",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Jimpphat",
    "nationality": "芬兰",
    "region": "欧洲",
    "team": "Aurora",
    "age": 19,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "jkaem",
    "nationality": "挪威",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 9,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "jks",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "FlyQuest",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 11,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "jL",
    "nationality": "立陶宛",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 26,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "jmqa",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 29,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "jnt",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 32,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "JOTA",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "jottAAA",
    "nationality": "土耳其",
    "region": "亚太",
    "team": "Eternal Fire",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "jR",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "Inner Circle",
    "age": 33,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "JT",
    "nationality": "南非",
    "region": "非洲与以色列",
    "team": "Liquid",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "juanflatroo",
    "nationality": "塞尔维亚科索沃",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "jugi",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "退役",
    "age": 29,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "junior",
    "nationality": "美国",
    "region": "北美洲",
    "team": "Voca",
    "age": 25,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "just",
    "nationality": "葡萄牙",
    "region": "欧洲",
    "team": "退役",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "JW",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "EYEBALLERS",
    "age": 31,
    "role": "AWPer",
    "major_championships": 3,
    "major_appearances": 14,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "k0nfig",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "退役",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 7,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "k1to",
    "nationality": "德国",
    "region": "欧洲",
    "team": "AM",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "kabal",
    "nationality": "蒙古",
    "region": "亚太",
    "team": "未签约/已下放",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "karrigan",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "Falcons",
    "age": 36,
    "role": "Rifler",
    "major_championships": 2,
    "major_appearances": 22,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "karsa",
    "nationality": "中国",
    "region": "亚太",
    "team": "未签约/已下放",
    "age": 34,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "kauez",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "kaze",
    "nationality": "马来西亚",
    "region": "亚太",
    "team": "未签约/已下放",
    "age": 31,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "keev",
    "nationality": "德国",
    "region": "欧洲",
    "team": "退役",
    "age": 34,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "KEi",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "Phantom",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "kennys",
    "nationality": "法国",
    "region": "欧洲",
    "team": "退役",
    "age": 31,
    "role": "AWPer",
    "major_championships": 1,
    "major_appearances": 14,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "kensi",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "Lavked",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "kensizor",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "B8",
    "age": 20,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Keoz",
    "nationality": "比利时",
    "region": "欧洲",
    "team": "GenOne",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "keshandr",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "退役",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "khan",
    "nationality": "哈萨克斯坦",
    "region": "独联体",
    "team": "Nemiga",
    "age": 22,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "khrn",
    "nationality": "芬兰",
    "region": "欧洲",
    "team": "退役",
    "age": 36,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "kinqie",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "BET-M",
    "age": 34,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "kioshima",
    "nationality": "法国",
    "region": "欧洲",
    "team": "退役",
    "age": 31,
    "role": "Rifler",
    "major_championships": 2,
    "major_appearances": 11,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "kisserek",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "SINNERS",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "kjaerbye",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 28,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 7,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "kl1m",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 21,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "kngv",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 33,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "koala",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Sharks",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "koosta",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 30,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "KQLY",
    "nationality": "法国",
    "region": "欧洲",
    "team": "退役",
    "age": 35,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "Krabeni",
    "nationality": "塞尔维亚科索沃",
    "region": "欧洲",
    "team": "FUT",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "krad",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "kraghen",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "9INE",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "krasnal",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "krimbo",
    "nationality": "德国",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "krimz",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "EYEBALLERS",
    "age": 32,
    "role": "Rifler",
    "major_championships": 2,
    "major_appearances": 18,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "krizzen",
    "nationality": "哈萨克斯坦",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "krystal",
    "nationality": "德国",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 32,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "KSCERATO",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "FURIA",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 11,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "kucheR",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "退役",
    "age": 37,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "kvem",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "Eternal Fire",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "kvik",
    "nationality": "立陶宛",
    "region": "欧洲",
    "team": "退役",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "kye",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Fluxo",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "kylar",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "Phantom",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "kyojin",
    "nationality": "法国",
    "region": "欧洲",
    "team": "Clutchain",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "kyousuke",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "Falcons",
    "age": 18,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "kyxsan",
    "nationality": "北马其顿",
    "region": "欧洲",
    "team": "Aurora",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "l00m1",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "Entropy",
    "age": 25,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "L1hang",
    "nationality": "中国",
    "region": "亚太",
    "team": "Rare Atom",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "lack1",
    "nationality": "哈萨克斯坦",
    "region": "独联体",
    "team": "FORZE Reload",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "lake",
    "nationality": "美国",
    "region": "北美洲",
    "team": "M80",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "latto",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Legacy",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "launx",
    "nationality": "罗马尼亚",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "legija",
    "nationality": "德国",
    "region": "欧洲",
    "team": "退役",
    "age": 35,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "lekr0",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 33,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "letn1",
    "nationality": "塞尔维亚",
    "region": "欧洲",
    "team": "MIBR",
    "age": 33,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "liazz",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "THUNDER dOWNUNDER",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 8,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "LNZ",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "MIBR",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "lomme",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "LOVEYY",
    "nationality": "中国",
    "region": "亚太",
    "team": "退役",
    "age": 37,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "lowel",
    "nationality": "西班牙",
    "region": "欧洲",
    "team": "退役",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "lucaozy",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "lucas1",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "luchov",
    "nationality": "阿根廷",
    "region": "南美洲",
    "team": "9z",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Lucky（丹麦）",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "Washed",
    "age": 23,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Lucky（法国）",
    "nationality": "法国",
    "region": "欧洲",
    "team": "3DMAX",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "luken",
    "nationality": "阿根廷",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "lux",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Luminosity",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "m0nesy",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "Falcons",
    "age": 21,
    "role": "AWPer",
    "major_championships": 1,
    "major_appearances": 7,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "maden",
    "nationality": "黑山",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Magisk",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "BC.Game",
    "age": 28,
    "role": "Rifler",
    "major_championships": 4,
    "major_appearances": 11,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "magixx",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "Spirit",
    "age": 23,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 7,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "magnojez",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "BetBoom",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "maikelele",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "退役",
    "age": 35,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "maj3r",
    "nationality": "土耳其",
    "region": "亚太",
    "team": "未签约/已下放",
    "age": 35,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "MaKa",
    "nationality": "法国",
    "region": "欧洲",
    "team": "3DMAX",
    "age": 29,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "makazze",
    "nationality": "塞尔维亚科索沃",
    "region": "欧洲",
    "team": "Natus Vincere",
    "age": 19,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "malbsmd",
    "nationality": "危地马拉",
    "region": "北美洲",
    "team": "Liquid",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "malta",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "退役",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "maniac",
    "nationality": "瑞士",
    "region": "欧洲",
    "team": "退役",
    "age": 36,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "marek",
    "nationality": "中国",
    "region": "亚太",
    "team": "Rare Atom",
    "age": 32,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "markeloff",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "退役",
    "age": 38,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 12,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "MATYS",
    "nationality": "斯洛伐克",
    "region": "欧洲",
    "team": "G2",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "max",
    "nationality": "乌拉圭",
    "region": "南美洲",
    "team": "9z",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "maxxkor",
    "nationality": "阿根廷",
    "region": "南美洲",
    "team": "Sharks",
    "age": 23,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "mercury",
    "nationality": "中国",
    "region": "亚太",
    "team": "TYLOO",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "meyern",
    "nationality": "阿根廷",
    "region": "南美洲",
    "team": "9z",
    "age": 23,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "mezii",
    "nationality": "英国",
    "region": "欧洲",
    "team": "Vitality",
    "age": 27,
    "role": "Rifler",
    "major_championships": 2,
    "major_appearances": 7,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "michu",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "minise",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "退役",
    "age": 32,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "mir",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "Virtus.pro",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "misutaaa",
    "nationality": "法国",
    "region": "欧洲",
    "team": "3DMAX",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "mithilf",
    "nationality": "印度",
    "region": "亚太",
    "team": "退役",
    "age": 33,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "mixwell",
    "nationality": "西班牙",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 30,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "mlhzin",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Patins da Ferrari",
    "age": 20,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "moddii",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "退役",
    "age": 36,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "MoDo",
    "nationality": "罗马尼亚",
    "region": "欧洲",
    "team": "SINNERS",
    "age": 23,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "molodoy",
    "nationality": "哈萨克斯坦",
    "region": "独联体",
    "team": "FURIA",
    "age": 21,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "mopoz",
    "nationality": "西班牙",
    "region": "欧洲",
    "team": "Gentle Mates",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "moseyuh",
    "nationality": "中国",
    "region": "亚太",
    "team": "TYLOO",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "mou",
    "nationality": "哈萨克斯坦",
    "region": "独联体",
    "team": "HOTU",
    "age": 34,
    "role": "Coach",
    "major_championships": 1,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "mouz",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "退役",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "MSL",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "退役",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 9,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "MUTiRiS",
    "nationality": "葡萄牙",
    "region": "欧洲",
    "team": "SAW",
    "age": 33,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "mynio",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "mzinho",
    "nationality": "蒙古",
    "region": "亚太",
    "team": "BC.Game",
    "age": 19,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "n0rb3r7",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "HOTU",
    "age": 25,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "n0thing",
    "nationality": "美国",
    "region": "北美洲",
    "team": "未签约/已下放",
    "age": 35,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 10,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "n1ssim",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Legacy",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "NAF",
    "nationality": "加拿大",
    "region": "北美洲",
    "team": "Liquid",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 14,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "nafany",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "TDK",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "natu",
    "nationality": "芬兰",
    "region": "欧洲",
    "team": "退役",
    "age": 41,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "nawwk",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 28,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "NBK-",
    "nationality": "法国",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 32,
    "role": "Rifler",
    "major_championships": 2,
    "major_appearances": 14,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "nealan",
    "nationality": "哈萨克斯坦",
    "region": "独联体",
    "team": "NOVAQ",
    "age": 25,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "nekiz",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "neo",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "Astralis",
    "age": 39,
    "role": "Coach",
    "major_championships": 1,
    "major_appearances": 14,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "neofrag",
    "nationality": "捷克",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "NertZ",
    "nationality": "以色列",
    "region": "非洲与以色列",
    "team": "G2",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "nettik",
    "nationality": "新西兰",
    "region": "大洋洲",
    "team": "FlyQuest",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "nex",
    "nationality": "德国",
    "region": "欧洲",
    "team": "退役",
    "age": 34,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 10,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "nexa",
    "nationality": "塞尔维亚",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "ngiN",
    "nationality": "土耳其",
    "region": "亚太",
    "team": "退役",
    "age": 33,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "nickelback",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "SPARTA",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Nico",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "退役",
    "age": 34,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "nicoodoz",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "Phantom",
    "age": 25,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "nicx",
    "nationality": "美国",
    "region": "北美洲",
    "team": "Marsborne",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "nifty",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 28,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "niko(丹麦)",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "Millennium",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "NiKo（波黑）",
    "nationality": "波黑",
    "region": "欧洲",
    "team": "Falcons",
    "age": 29,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 17,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "nilo",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "HEROIC",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "nin9",
    "nationality": "蒙古",
    "region": "亚太",
    "team": "The Huns",
    "age": 28,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "nitr0",
    "nationality": "美国",
    "region": "北美洲",
    "team": "NRG",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 14,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "nodios",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "norwi",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "Lavked",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "nota",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 19,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "noway",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Imperial",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "npl",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "B8",
    "age": 20,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "nqz",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "MIBR",
    "age": 21,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "nukkye",
    "nationality": "立陶宛",
    "region": "欧洲",
    "team": "ALGO",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "obo",
    "nationality": "美国",
    "region": "北美洲",
    "team": "未签约/已下放",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "olofmeister",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 34,
    "role": "Rifler",
    "major_championships": 2,
    "major_appearances": 16,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "oSee",
    "nationality": "美国",
    "region": "北美洲",
    "team": "未签约/已下放",
    "age": 27,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "oskar",
    "nationality": "捷克",
    "region": "欧洲",
    "team": "退役",
    "age": 35,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "ottond",
    "nationality": "芬兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 28,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "pancc",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "UNO MILLE",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "pashabiceps",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "退役",
    "age": 38,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 13,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "patsi",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Patti",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "STATE",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "paz",
    "nationality": "土耳其",
    "region": "亚太",
    "team": "未签约/已下放",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "peet",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "退役",
    "age": 35,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "perfecto",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 26,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "phzy",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "Astralis",
    "age": 23,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "pimp",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "piriajr",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "paiN",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "pita",
    "nationality": "波黑",
    "region": "欧洲",
    "team": "EYEBALLERS",
    "age": 35,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "PKL",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Fake do Biru",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "plopski",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "Metizport",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "polly",
    "nationality": "挪威",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 35,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "PR",
    "nationality": "捷克",
    "region": "欧洲",
    "team": "MOUZ",
    "age": 19,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "prb",
    "nationality": "挪威",
    "region": "欧洲",
    "team": "退役",
    "age": 38,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "professor-chaos",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 36,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "pronax",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "退役",
    "age": 35,
    "role": "Rifler",
    "major_championships": 3,
    "major_appearances": 8,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "ptr",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 36,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "pyth",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "退役",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "Qikert",
    "nationality": "哈萨克斯坦",
    "region": "独联体",
    "team": "1win",
    "age": 27,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 7,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Queenix",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "Hashiras",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "r0bs3n",
    "nationality": "德国",
    "region": "欧洲",
    "team": "退役",
    "age": 33,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "r1nkle",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "G2",
    "age": 21,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "r3salt",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "Nemesis",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "raalz",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "9INE",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "racno",
    "nationality": "南非",
    "region": "非洲与以色列",
    "team": "退役",
    "age": 39,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "rain",
    "nationality": "挪威",
    "region": "欧洲",
    "team": "100 Thieves",
    "age": 31,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 19,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Rainwaker",
    "nationality": "保加利亚",
    "region": "欧洲",
    "team": "Luminosity",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "rallen",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "ramz1kbo$$",
    "nationality": "哈萨克斯坦",
    "region": "独联体",
    "team": "退役",
    "age": 26,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "rdnzao",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Sharks",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "realz1n",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "退役",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "reck",
    "nationality": "美国",
    "region": "北美洲",
    "team": "Wildcard",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "refrezh",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "regali",
    "nationality": "罗马尼亚",
    "region": "欧洲",
    "team": "Eternal Fire",
    "age": 23,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "reltuc",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 37,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "rez",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "GamerLegion",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 9,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "rickeh",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "退役",
    "age": 34,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "rigoN",
    "nationality": "瑞士",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "riskyb0b",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "ritz",
    "nationality": "印度",
    "region": "亚太",
    "team": "未签约/已下放",
    "age": 37,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "rix",
    "nationality": "印度",
    "region": "亚太",
    "team": "未签约/已下放",
    "age": 37,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "robiin",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "roeJ",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "退役",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "roman",
    "nationality": "葡萄牙",
    "region": "欧洲",
    "team": "退役",
    "age": 34,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "ropz",
    "nationality": "爱沙尼亚",
    "region": "欧洲",
    "team": "Vitality",
    "age": 26,
    "role": "Rifler",
    "major_championships": 3,
    "major_appearances": 13,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "ROUX",
    "nationality": "蒙古",
    "region": "亚太",
    "team": "Chinggis Warriors",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "rox",
    "nationality": "阿根廷",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "RpK",
    "nationality": "法国",
    "region": "欧洲",
    "team": "退役",
    "age": 36,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 9,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "rubino",
    "nationality": "挪威",
    "region": "欧洲",
    "team": "退役",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "RUSH",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 32,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 5,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "ryu",
    "nationality": "立陶宛",
    "region": "欧洲",
    "team": "Astralis",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "s-chilla",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "S0tF1k",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 31,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "s1mple",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "BC.Game",
    "age": 28,
    "role": "AWPer",
    "major_championships": 1,
    "major_appearances": 14,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "s1n",
    "nationality": "德国",
    "region": "欧洲",
    "team": "M80",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "S1ren",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "BetBoom",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "s1zzi",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "B8",
    "age": 16,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "saadzin",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Imperial",
    "age": 22,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "saffee",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "paiN",
    "age": 31,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 7,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "salazar",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "Echo",
    "age": 21,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "sanji",
    "nationality": "乌兹别克斯坦",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "scream",
    "nationality": "比利时",
    "region": "欧洲",
    "team": "Clutchain",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 9,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "sdy",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "seang@res",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 38,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 8,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "seized",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "退役",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 12,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "semphis",
    "nationality": "加拿大",
    "region": "北美洲",
    "team": "Voca",
    "age": 36,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "sener1",
    "nationality": "塞尔维亚科索沃",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "sense",
    "nationality": "挪威",
    "region": "欧洲",
    "team": "Nordix",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "senzu",
    "nationality": "蒙古",
    "region": "亚太",
    "team": "BC.Game",
    "age": 19,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "sergej",
    "nationality": "芬兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "sf",
    "nationality": "法国",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 34,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "sh1ro",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "Spirit",
    "age": 25,
    "role": "AWPer",
    "major_championships": 1,
    "major_appearances": 8,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "shahzam",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 32,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "shalfey",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "shara",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "ALGO",
    "age": 34,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "SHOCK",
    "nationality": "捷克",
    "region": "欧洲",
    "team": "SINNERS",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "shox",
    "nationality": "法国",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 34,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 17,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "shroud",
    "nationality": "加拿大",
    "region": "北美洲",
    "team": "退役",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 7,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "sick",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "sico",
    "nationality": "新西兰",
    "region": "大洋洲",
    "team": "未签约/已下放",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "sinnopsyy",
    "nationality": "塞尔维亚科索沃",
    "region": "欧洲",
    "team": "JiJieHao",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "siuhy",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 7,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "sixer",
    "nationality": "法国",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 35,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "sjuush",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "Ninjas in Pyjamas",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 7,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "sk0r",
    "nationality": "蒙古",
    "region": "亚太",
    "team": "未签约/已下放",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "skadoodle",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 32,
    "role": "AWPer",
    "major_championships": 1,
    "major_appearances": 10,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "skullz",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "skurk",
    "nationality": "挪威",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 33,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "skytten",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 33,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "sl3nd",
    "nationality": "匈牙利",
    "region": "欧洲",
    "team": "INFINITE",
    "age": 21,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "slaxz-",
    "nationality": "德国",
    "region": "欧洲",
    "team": "M80",
    "age": 27,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "SLOWLY",
    "nationality": "中国",
    "region": "亚太",
    "team": "退役",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "smF",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 34,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "smithzz",
    "nationality": "法国",
    "region": "欧洲",
    "team": "退役",
    "age": 37,
    "role": "AWPer",
    "major_championships": 1,
    "major_appearances": 11,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "smooya",
    "nationality": "英国",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 26,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "snappi",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "Ninjas in Pyjamas",
    "age": 36,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "snatchie",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "NAVI Junior",
    "age": 28,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Snax",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "GamerLegion",
    "age": 33,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 17,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "snow",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "paiN",
    "age": 19,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "snyper",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "未签约/已下放",
    "age": 39,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "somebody",
    "nationality": "中国",
    "region": "亚太",
    "team": "未签约/已下放",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "sonic",
    "nationality": "南非",
    "region": "非洲与以色列",
    "team": "NRG",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "soulfly",
    "nationality": "土耳其",
    "region": "亚太",
    "team": "未签约/已下放",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "spaze",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "speed4k",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 30,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "spiidi",
    "nationality": "德国",
    "region": "欧洲",
    "team": "BIG Academy",
    "age": 30,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 7,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "spinx",
    "nationality": "以色列",
    "region": "非洲与以色列",
    "team": "MOUZ",
    "age": 25,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 9,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "spooke",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "OG",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "spunj",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "退役",
    "age": 36,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "stadodo",
    "nationality": "葡萄牙",
    "region": "欧洲",
    "team": "Rebels",
    "age": 29,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "staehr",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "Astralis",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "stanislaw",
    "nationality": "加拿大",
    "region": "北美洲",
    "team": "Metizport",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 8,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "starix",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 38,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "starry",
    "nationality": "中国",
    "region": "亚太",
    "team": "Lynn Vision",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "stavn",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "Ninjas in Pyjamas",
    "age": 24,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "stavros",
    "nationality": "德国",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 33,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "steel(加拿大)",
    "nationality": "加拿大",
    "region": "北美洲",
    "team": "未签约/已下放",
    "age": 36,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "steel（巴西）",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "退役",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "sterling",
    "nationality": "新西兰",
    "region": "大洋洲",
    "team": "未签约/已下放",
    "age": 28,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "stewie2k",
    "nationality": "美国",
    "region": "北美洲",
    "team": "未签约/已下放",
    "age": 28,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 7,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "stonde",
    "nationality": "芬兰",
    "region": "欧洲",
    "team": "退役",
    "age": 33,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "story",
    "nationality": "葡萄牙",
    "region": "欧洲",
    "team": "SAW",
    "age": 24,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "stressarN",
    "nationality": "北马其顿",
    "region": "欧洲",
    "team": "SINNERS",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "strux1",
    "nationality": "德国",
    "region": "欧洲",
    "team": "退役",
    "age": 35,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "styko",
    "nationality": "斯洛伐克",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "summer",
    "nationality": "中国",
    "region": "亚太",
    "team": "Rare Atom",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "sunny",
    "nationality": "芬兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "sunpayus",
    "nationality": "西班牙",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 27,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "susp",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "HEROIC",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "svyat",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "swag",
    "nationality": "美国",
    "region": "北美洲",
    "team": "Third Prime",
    "age": 29,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "swisher",
    "nationality": "美国",
    "region": "北美洲",
    "team": "M80",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "syrson",
    "nationality": "德国",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 30,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "szpero",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "退役",
    "age": 35,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "t0rick",
    "nationality": "阿塞拜疆",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "tabsen",
    "nationality": "德国",
    "region": "欧洲",
    "team": "BIG",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 10,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "taco",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 31,
    "role": "Rifler",
    "major_championships": 2,
    "major_appearances": 10,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "tarik",
    "nationality": "美国",
    "region": "北美洲",
    "team": "未签约/已下放",
    "age": 30,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 9,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "tauson",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "GamerLegion",
    "age": 20,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "taz",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "BC.Game",
    "age": 40,
    "role": "Coach",
    "major_championships": 1,
    "major_appearances": 12,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "techno",
    "nationality": "蒙古",
    "region": "亚太",
    "team": "The MongolZ",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 8,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "tenzki",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "退役",
    "age": 32,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "TeSeS",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "Falcons",
    "age": 25,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 9,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "thomas",
    "nationality": "英国",
    "region": "欧洲",
    "team": "退役",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "threat",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "退役",
    "age": 38,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "tiger",
    "nationality": "中国",
    "region": "亚太",
    "team": "未签约/已下放",
    "age": 23,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "tizian",
    "nationality": "德国",
    "region": "欧洲",
    "team": "退役",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "TjP",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "THUNDER dOWNUNDER",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "tN1R",
    "nationality": "白俄罗斯",
    "region": "独联体",
    "team": "Spirit",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "tonyblack",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "Aurora Young Blud",
    "age": 33,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "topgun",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "未签约/已下放",
    "age": 37,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "torzsi",
    "nationality": "匈牙利",
    "region": "欧洲",
    "team": "MOUZ",
    "age": 24,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 7,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "travis",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "SPARTA",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "troubley",
    "nationality": "德国",
    "region": "欧洲",
    "team": "退役",
    "age": 33,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "try",
    "nationality": "阿根廷",
    "region": "南美洲",
    "team": "Legacy",
    "age": 21,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "tuurtle",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Fake do Biru",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "twist",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "Alliance",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 5,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "twistzz",
    "nationality": "加拿大",
    "region": "北美洲",
    "team": "FaZe",
    "age": 26,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 11,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "ub1que",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "退役",
    "age": 34,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "ultimate",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 22,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "ultra",
    "nationality": "挪威",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 33,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "ustilo",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "未签约/已下放",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "uzzziii",
    "nationality": "法国",
    "region": "欧洲",
    "team": "退役",
    "age": 36,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "valde",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "venomzera",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "MIBR",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Vexite",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "FlyQuest",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "vice",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "VINI",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Imperial",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 9,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "volt",
    "nationality": "罗马尼亚",
    "region": "欧洲",
    "team": "INFINITE",
    "age": 24,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "vsm",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "paiN",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "w0nderful",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "Natus Vincere",
    "age": 21,
    "role": "AWPer",
    "major_championships": 1,
    "major_appearances": 6,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "waterfallz",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "NEW VISION",
    "age": 31,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "waylander",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "退役",
    "age": 32,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 6,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "Westmelon",
    "nationality": "中国",
    "region": "亚太",
    "team": "Lynn Vision",
    "age": 25,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "wicadia",
    "nationality": "土耳其",
    "region": "亚太",
    "team": "Aurora",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "wood7",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 31,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "worldedit",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 34,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 10,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "woro2k",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 24,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "woxic",
    "nationality": "土耳其",
    "region": "亚太",
    "team": "Aurora",
    "age": 27,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 8,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "xand",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "退役",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "xant3r",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "未签约/已下放",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "xantares",
    "nationality": "土耳其",
    "region": "亚太",
    "team": "Aurora",
    "age": 30,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 8,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "xarte",
    "nationality": "芬兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 34,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "xccurate",
    "nationality": "印度尼西亚",
    "region": "亚太",
    "team": "退役",
    "age": 28,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "xelex",
    "nationality": "匈牙利",
    "region": "欧洲",
    "team": "MOUZ",
    "age": 18,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "xelos",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 33,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "xerolte",
    "nationality": "蒙古",
    "region": "亚太",
    "team": "未签约/已下放",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "xertion",
    "nationality": "以色列",
    "region": "非洲与以色列",
    "team": "MOUZ",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 7,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "xfl0ud",
    "nationality": "土耳其",
    "region": "亚太",
    "team": "FUT",
    "age": 23,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "xielo",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "PARIVISION",
    "age": 20,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "xizt",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "Ninjas in Pyjamas",
    "age": 35,
    "role": "Coach",
    "major_championships": 1,
    "major_appearances": 11,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "xkacpersky",
    "nationality": "波兰",
    "region": "欧洲",
    "team": "Ninjas in Pyjamas",
    "age": 19,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "xms",
    "nationality": "法国",
    "region": "欧洲",
    "team": "退役",
    "age": 29,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "xotic",
    "nationality": "美国",
    "region": "北美洲",
    "team": "未签约/已下放",
    "age": 25,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "xsepower",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "bankaPEPSI",
    "age": 28,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "xseven",
    "nationality": "芬兰",
    "region": "欧洲",
    "team": "退役",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "Xyp9x",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 30,
    "role": "Rifler",
    "major_championships": 4,
    "major_appearances": 17,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "yam",
    "nationality": "澳大利亚",
    "region": "大洋洲",
    "team": "未签约/已下放",
    "age": 37,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "yay",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "YEKINDAR",
    "nationality": "拉脱维亚",
    "region": "欧洲",
    "team": "FURIA",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 8,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "yel",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "退役",
    "age": 34,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "yuurih",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "FURIA",
    "age": 26,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 11,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "yxngstxr",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 21,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "z4kr",
    "nationality": "中国",
    "region": "亚太",
    "team": "Lynn Vision",
    "age": 23,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "zehn",
    "nationality": "芬兰",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 34,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Zellsis",
    "nationality": "美国",
    "region": "北美洲",
    "team": "退役",
    "age": 28,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "zende",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 31,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Zero（中国）",
    "nationality": "中国",
    "region": "亚太",
    "team": "TYLOO",
    "age": 20,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "Zero（斯洛伐克）",
    "nationality": "斯洛伐克",
    "region": "欧洲",
    "team": "退役",
    "age": 27,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "zerrofix",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "Inner Circle",
    "age": 19,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "zeus",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "退役",
    "age": 38,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 15,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "zEVES",
    "nationality": "挪威",
    "region": "欧洲",
    "team": "未签约/已下放",
    "age": 35,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "zevy",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "Fluxo",
    "age": 25,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "zews",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 38,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "zhokiNg",
    "nationality": "中国",
    "region": "亚太",
    "team": "TYLOO",
    "age": 32,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "znajder",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "退役",
    "age": 33,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy"
    ],
    "is_active": false,
    "is_enabled": true
  },
  {
    "nickname": "zonic",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "Falcons",
    "age": 39,
    "role": "Coach",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "zont1x",
    "nationality": "乌克兰",
    "region": "欧洲",
    "team": "Spirit",
    "age": 21,
    "role": "Rifler",
    "major_championships": 1,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "zorte",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "BetBoom",
    "age": 28,
    "role": "AWPer",
    "major_championships": 0,
    "major_appearances": 4,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "zqks",
    "nationality": "巴西",
    "region": "南美洲",
    "team": "未签约/已下放",
    "age": 34,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 1,
    "difficulties": [
      "normal"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "ztr",
    "nationality": "瑞典",
    "region": "欧洲",
    "team": "FOKUS",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 2,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "zweih",
    "nationality": "俄罗斯",
    "region": "独联体",
    "team": "PARIVISION",
    "age": 18,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "zyphon",
    "nationality": "丹麦",
    "region": "欧洲",
    "team": "Sashi",
    "age": 22,
    "role": "Rifler",
    "major_championships": 0,
    "major_appearances": 3,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  },
  {
    "nickname": "ZywOo",
    "nationality": "法国",
    "region": "欧洲",
    "team": "Vitality",
    "age": 25,
    "role": "AWPer",
    "major_championships": 3,
    "major_appearances": 11,
    "difficulties": [
      "normal",
      "easy",
      "beginner"
    ],
    "is_active": true,
    "is_enabled": true
  }
]
;
  const { GameSolver, FribergAutomation, FribergLiveDomAdapter } = globalThis;
  if (!GameSolver || !FribergAutomation || !FribergLiveDomAdapter || document.getElementById('friberg-scriptcat-assistant')) return;

  const VERSION = '0.9.3';
  const ROOT_ID = 'friberg-scriptcat-assistant';
  const STORAGE_KEY = 'friberg-scriptcat-calibration-v2';
  const LAYOUT_STORAGE_KEY = 'friberg-scriptcat-layout-v1';
  const FIELD_NAMES = ['nickname', 'team', 'country', 'age', 'role', 'majorWins', 'majorApps', 'status'];
  const NUMERIC_FIELDS = new Set(['age', 'majorWins', 'majorApps']);
  const SUBMIT_COOLDOWN_MS = 2100;
  const SUBMIT_RETRY_INTERVAL_MS = 100;
  const SUBMIT_QUEUE_TIMEOUT_MS = 10000;
  const SUBMIT_FEEDBACK_TIMEOUT_MS = 6000;

  const state = {
    players: GameSolver.normalizeGamePlayers(RAW_PLAYERS).filter(player => player.enabled !== false),
    matrix: null,
    session: null,
    board: null,
    rowSeed: null,
    rowParent: null,
    rowShape: null,
    observer: null,
    processedRows: new WeakSet(),
    processedFingerprints: new Set(),
    captureMode: null,
    calibration: { colors: {}, arrows: {} },
    lastError: '',
    lastFeedback: null,
    lastRow: '',
    lastCandidates: [],
    route: location.href,
    status: '等待对局',
    scan: null,
    recentMutations: [],
    errors: [],
    pageObserver: null,
    routeStop: null,
    listening: true,
    choosingBoard: false,
    scanTimer: null,
    lastDiagnostic: null,
    lastFill: null,
    lastFilledPlayer: null,
    lastSubmit: null,
    submissionInFlight: false,
    lastSubmitAt: 0,
    lastObservedRowCount: 0,
    lastBoardGuessCount: null,
    lastFeedbackAt: 0,
    roundMarker: null,
    submitQueue: null,
    submitQueueTimer: null,
    submissionWatchdogTimer: null,
    healthTimer: null,
    feedbackPaused: false,
    layout: { x: null, y: null, collapsed: false },
  };

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  const isTerminalState = value => ['WON', 'LOST'].includes(value);

  function visiblePageGuessCooldownMs() {
    const text = document.body?.innerText || '';
    const patterns = [
      /猜测间隔[：:\s]*还需等待\s*([\d.]+)\s*秒/i,
      /guess cooldown[：:\s]*([\d.]+)\s*s(?:econds?)?\s*remaining/i,
      /次の予想まで\s*([\d.]+)\s*秒/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      const seconds = Number(match?.[1]);
      if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
    }
    return 0;
  }

  function visibleRoundMarker() {
    const text = document.body?.innerText || '';
    const match = text.match(/第\s*(\d+)\s*局(?:\s*[·•]\s*先胜\s*(\d+)\s*局)?/);
    return match ? `round-${match[1]}-first-${match[2] || '?'}` : null;
  }

  function visibleBoardGuessCount(board) {
    if (!(board instanceof Element)) return null;
    let node = board;
    for (let level = 0; node instanceof Element && level < 6; level += 1, node = node.parentElement) {
      const structures = node.querySelectorAll('table,[role="grid"],.game-table');
      if (level > 0 && structures.length > 1) break;
      const headings = Array.from(node.querySelectorAll('h1,h2,h3,h4,[class*="title" i],[class*="heading" i]'));
      const ownHeading = headings.find(element => /我的猜测|my guesses?/i.test(element.textContent || ''));
      if (!ownHeading) continue;
      const match = (ownHeading.textContent || '').match(/(\d+)\s*\/\s*8\b/);
      const count = Number(match?.[1]);
      if (Number.isInteger(count) && count >= 0 && count <= 8) return count;
    }
    return null;
  }

  function visible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function visibleChildren(element) {
    return Array.from(element.children).filter(visible);
  }

  function elementSummary(element) {
    if (!element) return null;
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || '',
      className: typeof element.className === 'string' ? element.className : '',
      role: element.getAttribute('role') || '',
      childCount: visibleChildren(element).length,
      text: normalizeText(element.innerText).slice(0, 260),
    };
  }

  function describePath(element, limit = 5) {
    const parts = [];
    let node = element;
    while (node instanceof Element && parts.length < limit) {
      const id = node.id ? `#${CSS.escape(node.id)}` : '';
      const classes = typeof node.className === 'string'
        ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(name => `.${CSS.escape(name)}`).join('')
        : '';
      parts.unshift(`${node.tagName.toLowerCase()}${id || classes}`);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function cellSignal(cell) {
    const candidates = [cell, ...Array.from(cell.querySelectorAll(':scope > *')).slice(0, 3)];
    for (const element of candidates) {
      const style = getComputedStyle(element);
      const opaque = style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent';
      if (opaque || style.backgroundImage !== 'none') {
        return JSON.stringify({
          bg: style.backgroundColor,
          image: style.backgroundImage,
          border: style.borderColor,
          classes: typeof element.className === 'string' ? element.className.split(/\s+/).filter(Boolean).sort() : [],
        });
      }
    }
    const style = getComputedStyle(cell);
    return JSON.stringify({
      bg: style.backgroundColor,
      image: style.backgroundImage,
      border: style.borderColor,
      classes: typeof cell.className === 'string' ? cell.className.split(/\s+/).filter(Boolean).sort() : [],
    });
  }

  function arrowSignal(cell) {
    const arrow = cell.querySelector('svg, [class*="arrow" i], [aria-label*="up" i], [aria-label*="down" i], [aria-label*="上"], [aria-label*="下"]');
    if (!arrow) return '';
    return JSON.stringify({
      tag: arrow.tagName.toLowerCase(),
      classes: typeof arrow.className === 'string' ? arrow.className.split(/\s+/).filter(Boolean).sort() : [],
      aria: arrow.getAttribute('aria-label') || '',
      path: arrow.querySelector('path')?.getAttribute('d') || '',
      text: normalizeText(arrow.textContent),
    });
  }

  function directionFor(cell) {
    const text = normalizeText(cell.innerText);
    if (/[↑↑]/.test(text)) return 'up';
    if (/[↓↓]/.test(text)) return 'down';
    const hint = [cell, ...cell.querySelectorAll('[aria-label], [class]')]
      .map(element => `${element.getAttribute('aria-label') || ''} ${typeof element.className === 'string' ? element.className : ''}`.toLowerCase())
      .join(' ');
    if (/\b(up|increase|higher)\b|上/.test(hint)) return 'up';
    if (/\b(down|decrease|lower)\b|下/.test(hint)) return 'down';
    const signal = arrowSignal(cell);
    if (signal && signal === state.calibration.arrows.up) return 'up';
    if (signal && signal === state.calibration.arrows.down) return 'down';
    return 'none';
  }

  function hasUnknownArrow(cell) {
    return Boolean(arrowSignal(cell)) && directionFor(cell) === 'none';
  }

  function colorFor(cell) {
    const signal = cellSignal(cell);
    return Object.entries(state.calibration.colors).find(([, known]) => known === signal)?.[0] || '';
  }

  function looksLikeBoard(element) {
    const scan = state.scan || FribergLiveDomAdapter.scan(document);
    return scan.boardCandidates.some(candidate => candidate.element === element);
  }

  function findBoard(target) {
    const scan = FribergLiveDomAdapter.scan(document);
    state.scan = scan;
    return FribergLiveDomAdapter.findBoardForTarget(target, scan)?.element || null;
  }

  function cellsFor(row) {
    return visibleChildren(row).filter(cell => normalizeText(cell.innerText) || cell.querySelector('svg, img'));
  }

  function findRow(target) {
    let element = target instanceof Element ? target : null;
    while (element && element !== state.board) {
      const cells = cellsFor(element);
      if (cells.length === FIELD_NAMES.length) return element;
      element = element.parentElement;
    }
    return null;
  }

  function rowSignature(row) {
    return cellsFor(row).map(cell => cell.tagName).join('|');
  }

  function rowCandidates() {
    return state.board ? FribergLiveDomAdapter.feedbackRows(state.board) : [];
  }

  function playerForNickname(value) {
    const wanted = GameSolver.normalize(value);
    const matches = state.players.filter(player => GameSolver.normalize(player.nick) === wanted);
    if (matches.length !== 1) {
      throw new Error(matches.length ? `昵称“${value}”在题库中不唯一，已停止。` : `题库中没有昵称“${value}”，已停止。`);
    }
    return matches[0];
  }

  function readingFromRow(row) {
    const knownReading = FribergLiveDomAdapter.readFeedbackRow(row);
    if (knownReading.valid) return knownReading.reading;
    throw new Error(`反馈未通过共享 DOM 适配器校验：${knownReading.errors.join(' ')}`);
  }

  function resetSession(reason, { resetSubmitCooldown = false } = {}) {
    const previousSubmitAt = state.lastSubmitAt || 0;
    clearQueuedSubmit();
    clearSubmissionWatchdog();
    state.session = new FribergAutomation.AssistantSession({
      players: state.players,
      matrix: state.matrix,
      origin: location.origin,
      mode: FribergAutomation.MODES.RECOMMEND,
      dataDriftMaxScore: 1,
    });
    state.session.startRound(`scriptcat-${Date.now()}`);
    state.processedRows = new WeakSet();
    state.processedFingerprints = new Set();
    state.lastCandidates = state.players.slice();
    state.lastFeedback = null;
    state.lastRow = '';
    state.lastFill = null;
    state.lastFilledPlayer = null;
    state.lastSubmit = null;
    state.submissionInFlight = false;
    state.lastSubmitAt = resetSubmitCooldown ? 0 : previousSubmitAt;
    state.lastObservedRowCount = 0;
    state.lastBoardGuessCount = visibleBoardGuessCount(state.board);
    state.lastFeedbackAt = 0;
    state.roundMarker = visibleRoundMarker() || state.roundMarker || null;
    state.lastError = '';
    state.feedbackPaused = false;
    state.status = reason;
  }

  function processRow(row) {
    const fingerprint = FribergLiveDomAdapter.feedbackRowFingerprint(row);
    if (state.processedRows.has(row) || state.processedFingerprints.has(fingerprint)) return;
    const parsed = FribergLiveDomAdapter.readFeedbackRow(row);
    if (!parsed.valid) throw new Error(`反馈未通过共享 DOM 适配器校验：${parsed.errors.join(' ')}`);
    const baseGuess = playerForNickname(parsed.nickname);
    const visibleGuess = FribergAutomation.guessFromVisibleReading(baseGuess, parsed.reading, state.players);
    const result = state.session.recordObservedVisibleFeedback(visibleGuess, parsed.reading, { maxGuesses: 8 });
    state.processedRows.add(row);
    state.processedFingerprints.add(fingerprint);
    state.lastFeedback = parsed.reading;
    state.lastRow = normalizeText(parsed.cells.map(cell => cell.innerText).join(' | ')).slice(0, 320);
    state.lastCandidates = result.candidates || [];
    state.lastFill = null;
    state.lastFilledPlayer = null;
    clearQueuedSubmit();
    clearSubmissionWatchdog();
    state.submissionInFlight = false;
    state.lastFeedbackAt = Date.now();
    state.lastBoardGuessCount = visibleBoardGuessCount(state.board);
    state.lastError = '';
    state.status = result.won
      ? '页面报告本局胜利'
      : result.lost
        ? '本局已结束'
        : result.dataDrift
          ? '已用加权数据漂移恢复候选'
          : '已读取新的自己的可见反馈';
  }

  function synchronizeRows() {
    if (!state.session || !state.board) throw new Error('请先选择自己的棋盘。');
    const marker = visibleRoundMarker();
    const markerChanged = Boolean(marker && state.roundMarker && marker !== state.roundMarker);
    if (marker) state.roundMarker = marker;
    let rows = rowCandidates();
    const fingerprints = rows.map(row => FribergLiveDomAdapter.feedbackRowFingerprint(row));
    const boardGuessCount = visibleBoardGuessCount(state.board);
    const terminal = isTerminalState(state.session.state);
    const hadRoundEvidence = Boolean(
      state.session.history.length
      || state.processedFingerprints.size
      || state.feedbackPaused
      || state.lastError
      || terminal,
    );
    const boardCleared = rows.length === 0 && hadRoundEvidence;
    const rowCountRewound = rows.length < (state.lastObservedRowCount || 0);
    const guessCountRewound = boardGuessCount !== null
      && state.lastBoardGuessCount !== null
      && boardGuessCount < state.lastBoardGuessCount;
    const counterReturnedToZero = boardGuessCount === 0 && hadRoundEvidence;
    const allRowsReplacedAfterTerminal = terminal
      && rows.length > 0
      && fingerprints.every(fingerprint => !state.processedFingerprints.has(fingerprint));
    if (markerChanged || boardCleared || rowCountRewound || guessCountRewound || counterReturnedToZero || allRowsReplacedAfterTerminal) {
      resetSession(
        markerChanged
          ? `检测到 ${marker}；已清除上一小局状态并开放随机首猜。`
          : '检测到棋盘已进入新一小局；已清除上一局状态并开放随机首猜。',
        { resetSubmitCooldown: true },
      );
      rows = rowCandidates();
    }
    state.lastObservedRowCount = rows.length;
    state.lastBoardGuessCount = visibleBoardGuessCount(state.board);
    state.feedbackPaused = false;
    for (const row of rows) processRow(row);
    state.lastError = '';
    render();
  }

  function stopWithError(cause) {
    state.lastError = cause instanceof Error ? cause.message : String(cause);
    state.errors.push(state.lastError);
    if (state.errors.length > 20) state.errors.shift();
    state.feedbackPaused = true;
    state.status = '最新反馈尚未识别：监听将自动重试';
    render();
  }

  function installObserver() {
    state.observer?.disconnect();
    if (!state.board) return;
    state.observer = new MutationObserver(records => {
      FribergLiveDomAdapter.appendMutations(state.recentMutations, records);
      try { synchronizeRows(); } catch (cause) { stopWithError(cause); }
    });
    state.observer.observe(state.board, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'data-feedback', 'data-state', 'aria-label'],
    });
  }

  function bindBoard(board, source) {
    if (!board) return;
    state.board = board;
    state.rowSeed = null;
    state.rowParent = null;
    state.rowShape = null;
    state.observer?.disconnect();
    const rows = FribergLiveDomAdapter.feedbackRows(board);
    resetSession(source === 'automatic'
      ? '已自动绑定“我的猜测”棋盘，正在同步可见反馈。'
      : '已绑定自己的棋盘，正在同步可见反馈。');
    installObserver();
    if (rows.length) synchronizeRows();
  }

  function queueLiveScan(reason) {
    if (!state.listening || state.scanTimer) return;
    state.scanTimer = setTimeout(() => {
      state.scanTimer = null;
      try { refreshLiveScan(reason); } catch (cause) { stopWithError(cause); }
    }, 120);
  }

  function startHealthMonitor() {
    clearInterval(state.healthTimer);
    state.healthTimer = setInterval(() => {
      if (!state.listening) return;
      try {
        const marker = visibleRoundMarker();
        const count = visibleBoardGuessCount(state.board);
        const markerChanged = Boolean(marker && state.roundMarker && marker !== state.roundMarker);
        const countRewound = count !== null
          && state.lastBoardGuessCount !== null
          && count < state.lastBoardGuessCount;
        const staleAtFreshBoard = count === 0 && Boolean(
          state.feedbackPaused
          || state.lastError
          || state.session?.history.length
          || state.processedFingerprints.size
          || isTerminalState(state.session?.state),
        );
        if (state.board && state.session && (markerChanged || countRewound || staleAtFreshBoard)) {
          synchronizeRows();
          state.scan = FribergLiveDomAdapter.scan(document);
          render();
          return;
        }
        const input = state.scan?.inputCandidates?.[0]?.element;
        if (!state.board || !input?.isConnected || state.feedbackPaused) {
          queueLiveScan('状态巡检发现页面已变化。');
        }
      } catch (cause) {
        stopWithError(cause);
      }
    }, 350);
  }

  function refreshLiveScan(reason) {
    if (!state.listening) return;
    state.scan = FribergLiveDomAdapter.scan(document);
    if (state.board && !document.documentElement.contains(state.board)) {
      state.board = null;
      state.rowSeed = null;
      state.rowParent = null;
      state.rowShape = null;
      state.observer?.disconnect();
      resetSession('先前绑定的棋盘已移除，正在重新扫描。');
    }
    if (!state.board && state.scan.autoBoard) {
      try { bindBoard(state.scan.autoBoard.element, 'automatic'); } catch (cause) { stopWithError(cause); return; }
    }
    if (!state.board) {
      state.status = '等待对局';
      state.lastError = '';
      const selectableBoards = state.scan.boardCandidates.filter(candidate => candidate.ownership !== 'opponent');
      if (selectableBoards.length > 1) {
        FribergLiveDomAdapter.markBoardCandidates(selectableBoards);
        state.status = '请选择自己的棋盘';
        state.lastError = '发现多个可能棋盘；点击“选择自己的棋盘”后再点击有边框的棋盘。';
      }
    } else {
      try { synchronizeRows(); } catch (cause) { stopWithError(cause); }
    }
    if (reason) state.status = state.board ? state.status : '等待对局';
    render();
  }

  function previewCandidates() {
    const candidates = state.lastCandidates;
    if (!candidates.length) return '—';
    return candidates.slice(0, 3).map(player => player.nick).join(' / ');
  }

  function recommendation() {
    return state.session?.history?.length ? state.session.lastRecommendation?.player || null : null;
  }

  function uniquePlayerForText(value) {
    const wanted = GameSolver.normalize(value);
    if (!wanted) return null;
    const matches = state.players.filter(player => GameSolver.normalize(player.nick) === wanted);
    return matches.length === 1 ? matches[0] : null;
  }

  function setCapture(mode) {
    state.captureMode = mode;
    if (mode === 'board') {
      state.scan = FribergLiveDomAdapter.scan(document);
      state.choosingBoard = true;
      FribergLiveDomAdapter.markBoardCandidates(
        state.scan.boardCandidates.filter(candidate => candidate.ownership !== 'opponent'),
        state.board,
      );
    }
    state.status = mode === 'board'
      ? '选择模式：请点击你自己的“我的猜测”棋盘区域；该次点击不会提交游戏操作。'
      : mode === 'row'
        ? '选择模式：请点击一条你自己的真实反馈行；该次点击不会提交游戏操作。'
        : `校准模式：请点击一个${mode === 'green' ? '绿色' : mode === 'yellow' ? '黄色' : mode === 'gray' ? '灰色' : mode === 'up' ? '向上箭头' : '向下箭头'}反馈格；该次点击不会提交游戏操作。`;
    render();
  }

  function handleCapture(event) {
    if (!state.captureMode) return;
    const path = event.composedPath();
    if (path.includes(host)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const mode = state.captureMode;
    state.captureMode = null;
    if (mode === 'board') {
      state.choosingBoard = false;
      FribergLiveDomAdapter.clearMarks();
    }
    try {
      if (mode === 'board') {
        const candidate = FribergLiveDomAdapter.findBoardForTarget(event.target, state.scan);
        if (!candidate) throw new Error('这里没有发现包含全部字段标题的棋盘；请点击“我的猜测”的表格区域。');
        if (candidate.ownership === 'opponent') throw new Error('该棋盘属于对方或含 masked-cell，已拒绝绑定。');
        bindBoard(candidate.element, 'manual');
      } else if (mode === 'row') {
        if (!state.board) throw new Error('请先选择自己的棋盘。');
        const row = findRow(event.target);
        if (!row) throw new Error('未找到 8 格反馈行；请直接点击一条猜测结果的任意格。');
        state.rowSeed = row;
        state.rowParent = row.parentElement;
        state.rowShape = rowSignature(row);
        resetSession('已锁定自己的反馈行结构，正在同步已可见历史。');
        installObserver();
        synchronizeRows();
      } else {
        if (!state.rowSeed) throw new Error('请先选择自己的反馈行，才能校准颜色与箭头。');
        const row = findRow(event.target);
        if (!row) throw new Error('请点击已选择棋盘中的反馈格。');
        const directCell = cellsFor(row).find(cell => cell === event.target || cell.contains(event.target));
        if (!directCell) throw new Error('未能定位被点击的反馈格。');
        if (['green', 'yellow', 'gray'].includes(mode)) {
          state.calibration.colors[mode] = cellSignal(directCell);
          state.status = `已校准${mode}反馈颜色。`;
        } else {
          const signal = arrowSignal(directCell);
          if (!signal) throw new Error('该格没有可识别的箭头元素，请点击数字旁的箭头图标。');
          state.calibration.arrows[mode] = signal;
          state.status = `已校准${mode === 'up' ? '向上' : '向下'}箭头。`;
        }
        saveCalibration();
      }
    } catch (cause) {
      stopWithError(cause);
      return;
    }
    render();
  }

  async function gmGet(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') return await GM_getValue(key, fallback);
      if (globalThis.GM?.getValue) return await globalThis.GM.getValue(key, fallback);
    } catch { /* ScriptCat storage is optional */ }
    return fallback;
  }

  async function gmSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') return await GM_setValue(key, value);
      if (globalThis.GM?.setValue) return await globalThis.GM.setValue(key, value);
    } catch { /* ScriptCat storage is optional */ }
    return undefined;
  }

  function saveCalibration() {
    void gmSet(STORAGE_KEY, state.calibration);
  }

  function auditCandidates() {
    const scan = state.scan || FribergLiveDomAdapter.scan(document);
    return scan.boardCandidates.map(candidate => ({
      score: candidate.score,
      reasons: candidate.reasons,
      headers: candidate.headers,
      selfEvidence: candidate.selfEvidence,
      ...FribergLiveDomAdapter.elementDescriptor(candidate.element),
    }));
  }

  function diagnostic() {
    state.scan = FribergLiveDomAdapter.scan(document);
    const recommendationValue = recommendation();
    const report = FribergLiveDomAdapter.diagnostic({
      scanResult: state.scan,
      activeBoard: state.board,
      recentMutations: state.recentMutations,
      errors: [...state.errors, state.lastError].filter(Boolean),
      extensionVersion: VERSION,
      gamePoolSize: state.players.length,
      adapterState: {
        listening: state.listening,
        choosingBoard: state.choosingBoard,
        rowCount: rowCandidates().length,
        processedRows: state.session?.history.length || 0,
        lastFill: state.lastFill,
        lastSubmit: state.lastSubmit,
        submitQueued: state.submitQueue ? {
          nickname: state.submitQueue.nickname,
          createdAt: state.submitQueue.createdAt,
          deadline: state.submitQueue.deadline,
        } : null,
        submissionInFlight: state.submissionInFlight,
        feedbackPaused: state.feedbackPaused,
      },
    });
    return {
      ...report,
      generatedAt: new Date().toISOString(),
      extension: 'ScriptCat userscript',
      version: VERSION,
      policy: FribergAutomation.originPolicy(location.origin),
      players: state.players.length,
      matrixReady: Boolean(state.matrix),
      pageMode: 'public-visible-dom-assist',
      board: elementSummary(state.board),
      boardPath: describePath(state.board),
      rowSeed: elementSummary(state.rowSeed),
      rowContainer: elementSummary(state.rowParent),
      rowCount: rowCandidates().length,
      processedRows: state.session?.history.length || 0,
      lastProcessedRow: state.lastRow,
      lastFeedback: state.lastFeedback,
      candidateCount: state.lastCandidates.length,
      recommendation: recommendationValue?.nick || null,
      bestProbe: state.session?.lastRecommendation?.purpose || null,
      currentError: state.lastError || null,
      legacyBoardCandidates: auditCandidates(),
    };
  }

  function copyText(value) {
    if (!value) return;
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(value, 'text');
      } else if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(value);
      }
      state.status = `已复制：${value}`;
    } catch (cause) {
      state.lastError = `复制失败：${cause.message}`;
    }
    render();
  }

  function exportDiagnostic() {
    const blob = new Blob([JSON.stringify(diagnostic(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `friberg-diagnostic-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    state.status = '已下载本地诊断 JSON；可把它交给我继续完成真实 DOM 合约。';
    render();
  }

  function copyDiagnostic() {
    const report = diagnostic();
    const text = JSON.stringify(report, null, 2);
    try {
      if (typeof GM_setClipboard === 'function') GM_setClipboard(text, 'text');
      else if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text);
      else throw new Error('当前浏览器没有可用的剪贴板接口。');
      state.status = '诊断 JSON 已复制；可直接粘贴到此任务。';
      state.lastError = '';
    } catch (cause) {
      state.lastError = `复制诊断失败：${cause.message}`;
    }
    render();
  }

  async function fillPlayer(player, sourceLabel) {
    state.scan = FribergLiveDomAdapter.scan(document);
    const input = state.scan.inputCandidates?.[0]?.element;
    if (state.feedbackPaused || !input || !player || state.submissionInFlight) {
      state.status = '无法填入选手';
      state.lastError = state.feedbackPaused
        ? '最新反馈尚未识别；监听仍会自动重试，也可点击“扫描页面”。'
        : state.submissionInFlight
          ? '上一猜已经提交，正在等待反馈行。'
          : '需要可用选手和已发现的搜索框。';
      render();
      return;
    }
    state.status = sourceLabel === '随机首猜' ? '正在生成随机首猜' : '正在填入下一猜';
    state.lastError = '';
    render();
    try {
      const result = await FribergLiveDomAdapter.fillAndSelectUniqueOption({ input, player, players: state.players, documentRef: document });
      state.lastFill = result;
      state.lastFilledPlayer = result.status === 'selected' ? player : null;
      state.lastSubmit = null;
      state.status = result.status === 'selected'
        ? `${sourceLabel || '下一猜'}已选中，等待提交`
        : '未自动选择下拉项';
      state.lastError = result.status === 'selected' ? '' : result.message || '';
    } catch (cause) {
      state.lastError = cause instanceof Error ? cause.message : String(cause);
      state.errors.push(state.lastError);
      state.status = '填入已停止';
    }
    render();
  }

  function fillRecommended() {
    const player = recommendation();
    if (!state.board || !player) {
      state.status = '无法填入下一猜';
      state.lastError = '需要已绑定自己的棋盘并产生下一猜推荐。';
      render();
      return;
    }
    void fillPlayer(player, '下一猜');
  }

  function fillRandomFirstGuess() {
    if ((state.session?.history.length || 0) > 0) {
      state.status = '随机首猜已停用';
      state.lastError = '本局已有反馈；请使用求解器给出的“填入下一猜”。';
      render();
      return;
    }
    const player = FribergAutomation.pickRandomPlayer({
      players: state.players,
      guessedKeys: state.session?.guessedKeys || new Set(),
    });
    if (!player) {
      state.status = '没有可用的随机首猜';
      state.lastError = '题库中没有尚未猜过的启用选手。';
      render();
      return;
    }
    void fillPlayer(player, '随机首猜');
  }

  function clearQueuedSubmit() {
    clearTimeout(state.submitQueueTimer);
    state.submitQueueTimer = null;
    state.submitQueue = null;
  }

  function clearSubmissionWatchdog() {
    clearTimeout(state.submissionWatchdogTimer);
    state.submissionWatchdogTimer = null;
  }

  function beginSubmissionWatchdog(player) {
    clearSubmissionWatchdog();
    state.submissionWatchdogTimer = setTimeout(() => {
      if (!state.submissionInFlight) return;
      state.submissionInFlight = false;
      state.lastSubmit = {
        status: 'feedback-timeout',
        submitted: false,
        player: player.nick,
        message: '提交后未检测到新的反馈行。',
      };
      state.status = '提交后未收到反馈';
      state.lastError = '';
      state.scan = FribergLiveDomAdapter.scan(document);
      render();
    }, SUBMIT_FEEDBACK_TIMEOUT_MS);
  }

  function scheduleSubmitRetry(delay = SUBMIT_RETRY_INTERVAL_MS) {
    if (!state.submitQueue || state.submitQueueTimer) return;
    state.submitQueueTimer = setTimeout(() => {
      state.submitQueueTimer = null;
      attemptQueuedSubmit();
    }, Math.max(20, delay));
  }

  function stopQueuedSubmit(result) {
    clearQueuedSubmit();
    state.lastSubmit = result;
    state.status = '提交已停止';
    state.lastError = result?.message || '提交前校验失败。';
    render();
  }

  function attemptQueuedSubmit() {
    const queued = state.submitQueue;
    if (!queued || state.submissionInFlight) return;
    if (!state.listening || state.feedbackPaused || Date.now() >= queued.deadline) {
      stopQueuedSubmit({
        status: 'queue-timeout',
        submitted: false,
        message: '网页提交按钮在 10 秒内没有恢复；本次没有点击原网页按钮。',
      });
      return;
    }

    state.scan = FribergLiveDomAdapter.scan(document);
    const input = state.scan.inputCandidates?.[0]?.element;
    const player = uniquePlayerForText(input?.value);
    if (!player || GameSolver.playerKey(player) !== queued.playerKey) {
      stopQueuedSubmit({
        status: 'mismatch',
        submitted: false,
        message: '等待期间搜索框内容发生变化，已取消排队提交。',
      });
      return;
    }

    const localCooldownRemaining = state.lastSubmitAt + SUBMIT_COOLDOWN_MS - Date.now();
    const pageCooldownRemaining = visiblePageGuessCooldownMs();
    const cooldownRemaining = Math.max(localCooldownRemaining, pageCooldownRemaining);
    if (cooldownRemaining > 0) {
      state.status = `等待网页提交冷却：${Math.max(0.1, Math.ceil(cooldownRemaining / 100) / 10)} 秒`;
      state.lastError = '';
      scheduleSubmitRetry(Math.min(250, Math.max(SUBMIT_RETRY_INTERVAL_MS, cooldownRemaining)));
      render();
      return;
    }

    const result = FribergLiveDomAdapter.submitSelectedGuess({
      input,
      player,
      scanResult: state.scan,
      documentRef: document,
    });
    state.lastSubmit = result;
    if (result.status === 'submitted') {
      clearQueuedSubmit();
      state.submissionInFlight = true;
      state.lastSubmitAt = Date.now();
      state.status = '猜测已提交';
      state.lastError = '';
      beginSubmissionWatchdog(player);
      render();
      return;
    }
    if (['disabled', 'missing'].includes(result.status)) {
      state.status = `等待网页提交冷却：已排队 ${player.nick}`;
      state.lastError = '';
      scheduleSubmitRetry();
      render();
      return;
    }
    stopQueuedSubmit(result);
  }

  function submitCurrentGuess() {
    if (state.submissionInFlight || state.submitQueue) return;
    state.scan = FribergLiveDomAdapter.scan(document);
    const input = state.scan.inputCandidates?.[0]?.element;
    const player = uniquePlayerForText(input?.value);
    if (!input || !player) {
      stopQueuedSubmit({
        status: 'error',
        submitted: false,
        message: '搜索框中不是题库内唯一选手昵称。',
      });
      return;
    }
    state.submitQueue = {
      playerKey: GameSolver.playerKey(player),
      nickname: player.nick,
      createdAt: Date.now(),
      deadline: Date.now() + SUBMIT_QUEUE_TIMEOUT_MS,
    };
    state.status = `正在检查网页提交冷却：${player.nick}`;
    state.lastError = '';
    render();
    attemptQueuedSubmit();
  }

  function startPageListening() {
    state.pageObserver?.disconnect();
    state.routeStop?.();
    state.listening = true;
    state.pageObserver = new MutationObserver(records => {
      const meaningful = records.filter(record => !record.target.closest?.(`#${ROOT_ID}`));
      FribergLiveDomAdapter.appendMutations(state.recentMutations, meaningful);
      queueLiveScan('页面发生变化。');
    });
    state.pageObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'disabled', 'data-feedback', 'data-state', 'aria-disabled', 'aria-label'],
    });
    state.routeStop = FribergLiveDomAdapter.routeWatcher(handleRouteChange);
    startHealthMonitor();
    refreshLiveScan('监听已启动。');
  }

  function pauseListening() {
    clearQueuedSubmit();
    clearSubmissionWatchdog();
    clearInterval(state.healthTimer);
    state.healthTimer = null;
    state.captureMode = null;
    state.choosingBoard = false;
    FribergLiveDomAdapter.clearMarks();
    state.listening = false;
    state.pageObserver?.disconnect();
    state.routeStop?.();
    state.observer?.disconnect();
    state.status = '监听已暂停';
    state.lastError = '';
    render();
  }

  function handleRouteChange() {
    if (state.route === location.href) return;
    state.route = location.href;
    state.board = null;
    state.rowSeed = null;
    state.rowParent = null;
    state.rowShape = null;
    state.observer?.disconnect();
    resetSession('页面路由已变化；正在重新扫描自己的棋盘。', { resetSubmitCooldown: true });
    state.scan = null;
    try { refreshLiveScan('SPA 路由已变化。'); } catch (cause) { stopWithError(cause); }
  }

  const host = document.createElement('aside');
  host.id = ROOT_ID;
  host.setAttribute('aria-label', '弗一把助手，只读诊断模式');
  Object.assign(host.style, {
    position: 'fixed',
    zIndex: '2147483646',
    top: '16px',
    right: '16px',
  });
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .panel { width: min(328px, calc(100vw - 24px)); color: #eef5ff; background: #111a2c; border: 1px solid #465a80; box-shadow: 0 18px 56px rgba(3, 9, 23, .46); font: 13px/1.36 ui-sans-serif, system-ui, sans-serif; transition: width .16s ease, box-shadow .16s ease; }
      .head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; padding: 11px 11px 10px 14px; cursor: grab; touch-action: none; user-select: none; background: linear-gradient(135deg, #22385e, #171f35); border-bottom: 1px solid #465a80; }
      .panel[data-dragging="true"] { box-shadow: 0 22px 70px rgba(3, 9, 23, .62); } .panel[data-dragging="true"] .head { cursor: grabbing; }
      .title { min-width: 0; pointer-events: none; }
      .eyebrow { margin: 0 0 4px; color: #9bb7ff; font: 700 10px/1 ui-monospace, Consolas, monospace; letter-spacing: .13em; }
      h1 { margin: 0; color: #fff; font: 780 19px/1.05 Georgia, 'Noto Serif SC', serif; }
      .window-controls { display: flex; align-items: flex-start; gap: 4px; }
      .chip { padding: 6px; border: 1px solid #83d4c3; color: #c7fff3; font: 700 10px/1 ui-monospace, Consolas, monospace; letter-spacing: .04em; }
      button.window-button { width: 27px; min-width: 27px; min-height: 27px; padding: 0; color: #dbe7ff; background: #263653; border: 1px solid #4a618c; font: 800 15px/1 ui-monospace, Consolas, monospace; }
      button.window-button:hover { color: #102333; background: #83d4c3; border-color: #a3f2e1; }
      .rail { display: flex; gap: 3px; padding: 8px 14px 0; }
      .rail i { width: 24px; height: 4px; display: block; }
      .rail i:nth-child(1) { background: #34c48d; } .rail i:nth-child(2) { background: #e1a54f; } .rail i:nth-child(3) { background: #778495; }
      .body { display: grid; gap: 10px; padding: 12px 14px 14px; }
      .status { margin: 0; min-height: 34px; color: #b7c8e8; font-size: 12px; }
      .metrics { display: grid; grid-template-columns: 1fr 1fr; margin: 0; border-top: 1px solid #34445f; border-left: 1px solid #34445f; }
      .metrics div { min-width: 0; padding: 7px; border-right: 1px solid #34445f; border-bottom: 1px solid #34445f; }
      dt { color: #9aaac6; font-size: 10px; } dd { overflow: hidden; margin: 2px 0 0; color: #fff; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
      .next { padding: 9px; border-left: 3px solid #83d4c3; background: #17283a; } .next small { display: block; color: #a2b5d1; } .next strong { color: #d6fff4; font: 750 16px/1.1 Georgia, 'Noto Serif SC', serif; }
      .controls { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
      button { min-height: 31px; padding: 6px 7px; cursor: pointer; color: #e7f0ff; background: #263653; border: 1px solid #4a618c; border-radius: 0; font: 700 11px/1.1 ui-sans-serif, system-ui, sans-serif; }
      button:hover:not(:disabled) { background: #31486e; } button.primary { color: #102333; background: #83d4c3; border-color: #a3f2e1; } button.random { color: #102333; background: #b9c9ff; border-color: #d5defe; } button.submit { color: #14230b; background: #d8f36a; border-color: #efffa4; } button.warn { color: #ffdbc4; border-color: #9d5f57; background: #472a31; } button:disabled { cursor: not-allowed; opacity: .45; }
      .detail { margin: 0; color: #aebed8; font-size: 11px; } .error { color: #ffb5ad; } .tiny { color: #8799b9; font-size: 10px; }
      .panel[data-collapsed="true"] { width: min(210px, calc(100vw - 16px)); }
      .panel[data-collapsed="true"] .head { padding-top: 9px; padding-bottom: 9px; border-bottom: 0; }
      .panel[data-collapsed="true"] .eyebrow,.panel[data-collapsed="true"] .rail,.panel[data-collapsed="true"] .body { display: none; }
      .panel[data-collapsed="true"] h1 { overflow: hidden; font-size: 16px; line-height: 27px; text-overflow: ellipsis; white-space: nowrap; }
      @media (prefers-reduced-motion: reduce) { .panel { transition: none; } }
      @media (max-width: 580px) { .panel { width: min(328px, calc(100vw - 16px)); } }
    </style>
    <section class="panel" data-collapsed="false">
      <header class="head" data-drag-handle>
        <div class="title"><p class="eyebrow">SCRIPT CAT / LIVE ASSIST</p><h1>弗一把助手</h1></div>
        <div class="window-controls"><span class="chip">646</span><button class="window-button" data-window="reset" title="归位" aria-label="将悬浮窗归位">⌖</button><button class="window-button" data-window="collapse" title="最小化" aria-label="最小化悬浮窗" aria-expanded="true">—</button></div>
      </header>
      <div class="rail"><i></i><i></i><i></i></div>
      <div class="body">
        <p class="status" data-status></p>
        <dl class="metrics"><div><dt>题库</dt><dd>646</dd></div><div><dt>监听</dt><dd data-listener>运行中</dd></div><div><dt>当前 URL</dt><dd data-route>/multi</dd></div><div><dt>自己的棋盘</dt><dd data-board>尚未发现</dd></div><div><dt>搜索框</dt><dd data-search>未发现</dd></div><div><dt>下拉菜单</dt><dd data-dropdown>未发现</dd></div><div><dt>本局猜测</dt><dd data-guesses>0 / 8</dd></div><div><dt>剩余候选</dt><dd data-candidates>646</dd></div></dl>
        <div class="next"><small>当前推荐 / 最佳探针</small><strong data-next>等待反馈</strong></div>
        <div class="controls"><button class="primary" data-action="scan">扫描页面</button><button data-action="board">选择自己的棋盘</button><button data-action="sync">重新读取反馈</button><button data-action="copy">复制下一猜</button><button class="primary" data-action="fill">填入下一猜</button><button class="random" data-action="random-first">随机首猜并填入</button><button class="submit" data-action="submit">提交当前猜测</button><button data-action="diagnostic">采集诊断</button><button data-action="copy-diagnostic">复制诊断</button><button data-action="export">下载诊断 JSON</button><button class="warn" data-action="pause">暂停监听</button></div>
        <p class="detail" data-detail></p><p class="detail error" data-error></p><p class="tiny">填入与提交均只响应你的点击；提交前会再次核对选手、搜索框和原网页提交按钮。</p>
      </div>
    </section>`;
  document.documentElement.append(host);

  const $ = selector => shadow.querySelector(selector);
  const panel = $('.panel');
  let drag = null;

  function clampLayoutPoint(x, y) {
    const width = host.offsetWidth || panel.offsetWidth || 210;
    const height = host.offsetHeight || panel.offsetHeight || 48;
    return {
      x: Math.max(8, Math.min(Number(x) || 8, Math.max(8, innerWidth - width - 8))),
      y: Math.max(8, Math.min(Number(y) || 8, Math.max(8, innerHeight - height - 8))),
    };
  }

  function placePanel(x, y) {
    const point = clampLayoutPoint(x, y);
    host.style.left = `${Math.round(point.x)}px`;
    host.style.top = `${Math.round(point.y)}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    state.layout = { ...state.layout, ...point };
  }

  function savePanelLayout() {
    void gmSet(LAYOUT_STORAGE_KEY, state.layout);
  }

  function setPanelCollapsed(collapsed, persist = true) {
    state.layout = { ...state.layout, collapsed: Boolean(collapsed) };
    panel.dataset.collapsed = String(state.layout.collapsed);
    const button = $('[data-window="collapse"]');
    button.textContent = state.layout.collapsed ? '□' : '—';
    button.title = state.layout.collapsed ? '恢复' : '最小化';
    button.setAttribute('aria-label', state.layout.collapsed ? '恢复悬浮窗' : '最小化悬浮窗');
    button.setAttribute('aria-expanded', String(!state.layout.collapsed));
    if (state.layout.x !== null && state.layout.y !== null) requestAnimationFrame(() => placePanel(state.layout.x, state.layout.y));
    if (persist) savePanelLayout();
  }

  function resetPanelPosition(persist = true) {
    host.style.left = 'auto';
    host.style.top = '16px';
    host.style.right = '16px';
    host.style.bottom = 'auto';
    state.layout = { ...state.layout, x: null, y: null };
    if (persist) savePanelLayout();
  }

  $('[data-drag-handle]').addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    const rect = host.getBoundingClientRect();
    drag = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    panel.dataset.dragging = 'true';
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  $('[data-drag-handle]').addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    placePanel(event.clientX - drag.dx, event.clientY - drag.dy);
  });
  const finishPanelDrag = event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    delete panel.dataset.dragging;
    savePanelLayout();
  };
  $('[data-drag-handle]').addEventListener('pointerup', finishPanelDrag);
  $('[data-drag-handle]').addEventListener('pointercancel', finishPanelDrag);
  addEventListener('resize', () => {
    if (state.layout.x !== null && state.layout.y !== null) placePanel(state.layout.x, state.layout.y);
  });

  function render() {
    const recommendationValue = recommendation();
    const scan = state.scan;
    $('[data-status]').textContent = state.status;
    $('[data-listener]').textContent = state.listening ? '运行中' : '已暂停';
    $('[data-route]').textContent = location.href;
    $('[data-guesses]').textContent = `${state.session?.history.length || 0} / 8`;
    $('[data-candidates]').textContent = String(state.session ? state.lastCandidates.length : state.players.length);
    $('[data-board]').textContent = state.board ? '已绑定' : '尚未发现';
    $('[data-search]').textContent = scan?.inputCandidates?.length ? '已发现' : '未发现';
    $('[data-dropdown]').textContent = scan?.dropdownCandidates?.length ? '已发现' : '未发现';
    $('[data-next]').textContent = state.feedbackPaused
      ? '最新反馈待识别'
      : recommendationValue
        ? `${recommendationValue.nick} · ${state.session.lastRecommendation.purpose === 'probe' ? '探针' : '直接猜'}${state.session.lastResolution?.mode === 'data-drift' ? ' · 数据漂移恢复' : ''}`
        : '等待反馈';
    $('[data-action="fill"]').disabled = Boolean(state.feedbackPaused || !state.board || !recommendationValue);
    const input = scan?.inputCandidates?.[0]?.element;
    const inputPlayer = uniquePlayerForText(input?.value);
    const submitCandidate = input
      ? FribergLiveDomAdapter.uniqueSubmitButton({ scanResult: scan, input, documentRef: document })
      : null;
    const submitButtonFound = submitCandidate?.status === 'unique';
    const randomDisabled = Boolean(
      state.feedbackPaused
      || !input
      || (state.session?.history.length || 0) > 0
      || isTerminalState(state.session?.state)
      || state.submissionInFlight
    );
    const randomBlockedReason = !randomDisabled
      ? ''
      : state.feedbackPaused
        ? '等待换局重置'
        : !input
          ? '未发现输入框'
          : state.submissionInFlight
            ? '等待上一猜反馈'
            : isTerminalState(state.session?.state)
              ? '等待下一小局'
              : '本局已有反馈';
    $('[data-action="random-first"]').disabled = randomDisabled;
    $('[data-action="random-first"]').textContent = randomDisabled ? `随机首猜（${randomBlockedReason}）` : '随机首猜并填入';
    $('[data-action="random-first"]').title = randomDisabled ? randomBlockedReason : '随机选择一名尚未猜过的选手并填入原网页。';
    $('[data-action="submit"]').disabled = Boolean(
      state.feedbackPaused
      || state.submissionInFlight
      || state.submitQueue
      || !inputPlayer
      || !submitButtonFound,
    );
    $('[data-action="submit"]').textContent = state.submitQueue ? '等待网页 CD…' : '提交当前猜测';
    $('[data-detail]').textContent = state.submitQueue
      ? `已排队 ${state.submitQueue.nickname}；原网页按钮恢复后会自动提交一次。`
      : state.feedbackPaused
        ? '此前历史已保留；监听会在 DOM 变化或手动扫描时自动重试最新一行。'
      : state.board
        ? state.session?.lastResolution?.mode === 'data-drift'
          ? `严格候选归零；已按资料稳定性加权恢复。疑似漂移：${state.session.lastResolution.conflicts.map(item => `${item.nickname}(${item.fields.join('、')})`).slice(0, 4).join('；')}。`
          : `反馈行：${rowCandidates().length} 行；候选预览：${previewCandidates()}`
        : '等待对局。出现“我的猜测”棋盘会自动绑定；也可手动选择自己的棋盘。';
    $('[data-error]').textContent = state.lastError;
  }

  shadow.addEventListener('click', event => {
    const windowAction = event.target.closest('button')?.dataset.window;
    if (windowAction === 'collapse') {
      setPanelCollapsed(!state.layout.collapsed);
      return;
    }
    if (windowAction === 'reset') {
      resetPanelPosition();
      return;
    }
    const action = event.target.closest('button')?.dataset.action;
    if (!action) return;
    if (action === 'scan') {
      if (!state.listening) startPageListening();
      else {
        try { refreshLiveScan('已按你的点击重新扫描页面。'); } catch (cause) { stopWithError(cause); }
      }
    }
    else if (action === 'board') setCapture('board');
    else if (action === 'row') setCapture('row');
    else if (['green', 'yellow', 'gray', 'up', 'down'].includes(action)) setCapture(action);
    else if (action === 'sync') { try { synchronizeRows(); } catch (cause) { stopWithError(cause); } }
    else if (action === 'copy') copyText(recommendation()?.nick || '');
    else if (action === 'fill') fillRecommended();
    else if (action === 'random-first') fillRandomFirstGuess();
    else if (action === 'submit') submitCurrentGuess();
    else if (action === 'diagnostic') {
      const report = diagnostic();
      state.status = `诊断：${report.boardCandidates.length} 个可能棋盘、${report.rowCount} 条可见反馈行、${report.candidateCount} 名候选。需要完整内容请点击“导出诊断 JSON”。`;
      render();
    }
    else if (action === 'copy-diagnostic') copyDiagnostic();
    else if (action === 'export') exportDiagnostic();
    else if (action === 'pause') {
      pauseListening();
    }
  });

  document.addEventListener('click', handleCapture, true);
  document.addEventListener('input', event => {
    if (event.composedPath().includes(host)) return;
    if (state.submitQueue) {
      const player = uniquePlayerForText(event.target?.value);
      if (!player || GameSolver.playerKey(player) !== state.submitQueue.playerKey) {
        clearQueuedSubmit();
        state.status = '已取消排队提交';
        state.lastError = '';
      }
    }
    queueMicrotask(render);
  }, true);

  (async () => {
    const stored = await gmGet(STORAGE_KEY, { colors: {}, arrows: {} });
    if (stored && typeof stored === 'object') {
      state.calibration = {
        colors: stored.colors && typeof stored.colors === 'object' ? stored.colors : {},
        arrows: stored.arrows && typeof stored.arrows === 'object' ? stored.arrows : {},
      };
    }
    const storedLayout = await gmGet(LAYOUT_STORAGE_KEY, null);
    if (storedLayout && typeof storedLayout === 'object') {
      state.layout = {
        x: Number.isFinite(storedLayout.x) ? storedLayout.x : null,
        y: Number.isFinite(storedLayout.y) ? storedLayout.y : null,
        collapsed: Boolean(storedLayout.collapsed),
      };
      setPanelCollapsed(state.layout.collapsed, false);
      if (state.layout.x !== null && state.layout.y !== null) requestAnimationFrame(() => placePanel(state.layout.x, state.layout.y));
    }
    const started = performance.now();
    state.matrix = FribergAutomation.buildFeedbackMatrix(state.players);
    resetSession(`已载入 ${state.players.length} 人严格矩阵（${Math.round(performance.now() - started)} ms）。`);
    startPageListening();
  })().catch(stopWithError);
})();
