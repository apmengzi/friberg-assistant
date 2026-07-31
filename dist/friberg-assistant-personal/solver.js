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
