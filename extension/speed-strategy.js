(() => {
  'use strict';

  const Automation = globalThis.FribergAutomation;
  const Solver = globalThis.GameSolver;
  if (!Automation?.AssistantSession || !Solver) return;

  const CACHE_LIMIT = 8192;
  const cache = new Map();

  const entropyOf = (groups, total) => {
    let entropy = 0;
    groups.forEach(size => {
      const probability = size / total;
      entropy -= probability * Math.log2(probability);
    });
    return entropy;
  };

  function remember(key, value) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }

  function indicesFor(matrix, players) {
    return (players || [])
      .map(player => matrix.indexByKey.get(Solver.playerKey(player)))
      .filter(index => index !== undefined);
  }

  function stateKey(matrix, candidates, guessedKeys, remainingGuesses, priorVersion = '') {
    const ids = indicesFor(matrix, candidates).sort((a, b) => a - b);
    const guessed = Array.from(guessedKeys || [])
      .map(key => matrix.indexByKey.get(key))
      .filter(index => index !== undefined)
      .sort((a, b) => a - b);
    return `${remainingGuesses}|${ids.join(',')}|g:${guessed.join(',')}|p:${priorVersion}`;
  }

  function normalizedPrior(matrix, answerIndices, priorWeights) {
    const weights = new Map();
    let total = 0;
    for (const index of answerIndices) {
      const key = matrix.keys[index];
      const raw = Number(priorWeights?.get?.(key) ?? priorWeights?.[key] ?? 1);
      const weight = Number.isFinite(raw) && raw > 0 ? raw : 1;
      weights.set(index, weight);
      total += weight;
    }
    return { weights, total: total || answerIndices.length };
  }

  function evaluateCandidateProbe(matrix, answerIndices, probeIndex, priorWeights = null) {
    const groups = new Map();
    const weightedGroups = new Map();
    const { weights, total } = normalizedPrior(matrix, answerIndices, priorWeights);
    const correctSignature = matrix.signatures[probeIndex][probeIndex];

    for (const answerIndex of answerIndices) {
      const signature = matrix.signatures[probeIndex][answerIndex];
      groups.set(signature, (groups.get(signature) || 0) + 1);
      weightedGroups.set(signature, (weightedGroups.get(signature) || 0) + weights.get(answerIndex));
    }

    let squares = 0;
    let worstGroup = 0;
    let wrongSquares = 0;
    let worstWrongGroup = 0;
    groups.forEach((size, signature) => {
      squares += size * size;
      worstGroup = Math.max(worstGroup, size);
      if (signature !== correctSignature) {
        wrongSquares += size * size;
        worstWrongGroup = Math.max(worstWrongGroup, size);
      }
    });

    let weightedWrongMass = 0;
    weightedGroups.forEach((mass, signature) => {
      if (signature !== correctSignature) weightedWrongMass += mass;
    });

    const probeWeight = weights.get(probeIndex) || 0;
    return Object.freeze({
      player: matrix.roster[probeIndex],
      probeIndex,
      partitions: groups.size,
      worstGroup,
      worstWrongGroup,
      expectedRemaining: squares / answerIndices.length,
      expectedWrongRemaining: wrongSquares / answerIndices.length,
      entropy: entropyOf(Array.from(groups.values()), answerIndices.length),
      immediateHitRate: probeWeight / total,
      weightedWrongMass: weightedWrongMass / total,
      isCandidate: true,
    });
  }

  function compareRace(left, right) {
    if (!right) return -1;
    if (left.immediateHitRate !== right.immediateHitRate) return right.immediateHitRate - left.immediateHitRate;
    if (left.expectedWrongRemaining !== right.expectedWrongRemaining) {
      return left.expectedWrongRemaining - right.expectedWrongRemaining;
    }
    if (left.worstWrongGroup !== right.worstWrongGroup) return left.worstWrongGroup - right.worstWrongGroup;
    if (left.partitions !== right.partitions) return right.partitions - left.partitions;
    if (left.entropy !== right.entropy) return right.entropy - left.entropy;
    return Solver.normalize(left.player.nick).localeCompare(Solver.normalize(right.player.nick));
  }

  function recommendRace({
    matrix,
    candidates,
    guessedKeys = new Set(),
    remainingGuesses = 8,
    priorWeights = null,
    priorVersion = '',
  }) {
    if (!matrix?.roster?.length) throw new Error('race strategy requires a feedback matrix');
    const legal = (candidates || []).filter(player => matrix.indexByKey.has(Solver.playerKey(player)));
    if (!legal.length) throw new Error('race strategy received no legal candidates');

    if (legal.length === 1) {
      return Object.freeze({
        player: legal[0],
        purpose: 'answer',
        strategy: 'race',
        immediateHitRate: 1,
        cacheHit: false,
        reason: '只剩唯一合法候选，立即提交答案。',
      });
    }

    const key = stateKey(matrix, legal, guessedKeys, remainingGuesses, priorVersion);
    const cached = cache.get(key);
    if (cached) return Object.freeze({ ...cached, cacheHit: true });

    const answerIndices = indicesFor(matrix, legal);
    const probeIndices = answerIndices.filter(index => !guessedKeys.has(matrix.keys[index]));
    const usable = probeIndices.length ? probeIndices : answerIndices;
    let best = null;
    for (const probeIndex of usable) {
      const evaluation = evaluateCandidateProbe(matrix, answerIndices, probeIndex, priorWeights);
      if (compareRace(evaluation, best) < 0) best = evaluation;
    }

    const result = Object.freeze({
      ...best,
      purpose: 'answer',
      strategy: 'race',
      cacheHit: false,
      reason: `竞速策略：直接猜合法答案；当前命中率约 ${(best.immediateHitRate * 100).toFixed(1)}%，若未命中则优先缩小后续候选。`,
    });
    remember(key, result);
    return result;
  }

  function evaluateOpening(matrix, probe) {
    const probeIndex = typeof probe === 'number'
      ? probe
      : matrix.indexByKey.get(Solver.playerKey(probe));
    if (probeIndex === undefined) return null;
    const answerIndices = matrix.roster.map((_, index) => index);
    const groups = new Map();
    for (const answerIndex of answerIndices) {
      const signature = matrix.signatures[probeIndex][answerIndex];
      groups.set(signature, (groups.get(signature) || 0) + 1);
    }
    let squares = 0;
    let worstGroup = 0;
    let singletonBuckets = 0;
    groups.forEach(size => {
      squares += size * size;
      worstGroup = Math.max(worstGroup, size);
      if (size === 1) singletonBuckets += 1;
    });
    return Object.freeze({
      player: matrix.roster[probeIndex],
      probeIndex,
      partitions: groups.size,
      worstGroup,
      expectedRemaining: squares / answerIndices.length,
      entropy: entropyOf(Array.from(groups.values()), answerIndices.length),
      singletonBuckets,
      twoGuessHitRateUniform: groups.size / answerIndices.length,
      guaranteedBySecondRate: singletonBuckets / answerIndices.length,
    });
  }

  function rankOpenings(matrix) {
    return matrix.roster
      .map((_, index) => evaluateOpening(matrix, index))
      .sort((left, right) => (
        right.twoGuessHitRateUniform - left.twoGuessHitRateUniform
        || left.worstGroup - right.worstGroup
        || left.expectedRemaining - right.expectedRemaining
        || right.entropy - left.entropy
        || Solver.normalize(left.player.nick).localeCompare(Solver.normalize(right.player.nick))
      ));
  }

  function installRaceMode({ priorWeights = null, priorVersion = '' } = {}) {
    if (Automation.AssistantSession.prototype.__fribergRaceInstalled) return;
    const original = Automation.AssistantSession.prototype.recommend;
    Automation.AssistantSession.prototype.recommend = function raceRecommend(maxGuesses = 8) {
      const base = original.call(this, maxGuesses);
      if (!this.history?.length || !base?.candidates?.length) return base;
      const recommendation = recommendRace({
        matrix: this.matrix,
        candidates: base.candidates,
        guessedKeys: this.guessedKeys,
        remainingGuesses: base.remainingGuesses,
        priorWeights,
        priorVersion,
      });
      this.lastRecommendation = recommendation;
      return Object.freeze({ ...base, recommendation });
    };
    Object.defineProperty(Automation.AssistantSession.prototype, '__fribergRaceInstalled', { value: true });
  }

  globalThis.FribergSpeedStrategy = Object.freeze({
    recommendRace,
    evaluateOpening,
    rankOpenings,
    installRaceMode,
    cacheSize: () => cache.size,
    clearCache: () => cache.clear(),
  });
})();
