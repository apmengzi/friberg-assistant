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
  const LOCAL_HOSTS = new Set([]);
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
