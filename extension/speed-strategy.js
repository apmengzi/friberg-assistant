(() => {
  'use strict';

  const Automation = globalThis.FribergAutomation;
  const Solver = globalThis.GameSolver;
  if (!Automation?.AssistantSession || !Solver) return;

  const CACHE_LIMIT = 4096;
  const recommendationCache = new Map();
  const originalRecommend = Automation.AssistantSession.prototype.recommend;
  const runtimePath = globalThis.location?.pathname || '';
  const runtimeHost = globalThis.location?.hostname || '';
  const runtimePatchAllowed = !globalThis.location
    || runtimePath.startsWith('/single')
    || ['127.0.0.1', 'localhost', '[::1]'].includes(runtimeHost);

  const entropyOf = (groups, total) => {
    let entropy = 0;
    groups.forEach(size => {
      const probability = size / total;
      entropy -= probability * Math.log2(probability);
    });
    return entropy;
  };

  function remember(key, value) {
    if (recommendationCache.has(key)) recommendationCache.delete(key);
    recommendationCache.set(key, value);
    while (recommendationCache.size > CACHE_LIMIT) {
      recommendationCache.delete(recommendationCache.keys().next().value);
    }
  }

  function candidateIndices(matrix, candidates) {
    return (candidates || [])
      .map(player => matrix.indexByKey.get(Solver.playerKey(player)))
      .filter(index => index !== undefined);
  }

  function stateKey(matrix, candidates, guessedKeys, remainingGuesses) {
    const ids = candidateIndices(matrix, candidates).sort((a, b) => a - b);
    const guessed = Array.from(guessedKeys || [])
      .map(key => matrix.indexByKey.get(key))
      .filter(index => index !== undefined)
      .sort((a, b) => a - b);
    return `${remainingGuesses}|${ids.join(',')}|g:${guessed.join(',')}`;
  }

  function evaluateCandidateProbe(matrix, answerIndices, candidateKeys, probeIndex) {
    const groups = new Map();
    for (const answerIndex of answerIndices) {
      const signature = matrix.signatures[probeIndex][answerIndex];
      groups.set(signature, (groups.get(signature) || 0) + 1);
    }
    let squares = 0;
    let worstGroup = 0;
    let singletonAnswers = 0;
    groups.forEach(size => {
      squares += size * size;
      worstGroup = Math.max(worstGroup, size);
      if (size === 1) singletonAnswers += 1;
    });
    const player = matrix.roster[probeIndex];
    return {
      player,
      worstGroup,
      expectedRemaining: squares / answerIndices.length,
      entropy: entropyOf(groups, answerIndices.length),
      partitions: groups.size,
      singletonAnswers,
      guaranteedNextRate: singletonAnswers / answerIndices.length,
      immediateHitRate: candidateKeys.has(Solver.playerKey(player)) ? 1 / answerIndices.length : 0,
      isCandidate: candidateKeys.has(Solver.playerKey(player)),
    };
  }

  function compareSpeed(left, right) {
    if (!right) return -1;
    if (left.immediateHitRate !== right.immediateHitRate) return right.immediateHitRate - left.immediateHitRate;
    if (left.worstGroup !== right.worstGroup) return left.worstGroup - right.worstGroup;
    if (left.expectedRemaining !== right.expectedRemaining) return left.expectedRemaining - right.expectedRemaining;
    if (left.partitions !== right.partitions) return right.partitions - left.partitions;
    if (left.entropy !== right.entropy) return right.entropy - left.entropy;
    return Solver.normalize(left.player.nick).localeCompare(Solver.normalize(right.player.nick));
  }

  function recommendSpeed({ matrix, candidates, guessedKeys = new Set(), remainingGuesses = 8 }) {
    if (!matrix?.roster?.length) throw new Error('speed strategy requires a feedback matrix');
    const legalCandidates = (candidates || []).filter(player => matrix.indexByKey.has(Solver.playerKey(player)));
    if (!legalCandidates.length) throw new Error('speed strategy received no legal candidates');

    const cacheKey = stateKey(matrix, legalCandidates, guessedKeys, remainingGuesses);
    const cached = recommendationCache.get(cacheKey);
    if (cached) {
      const player = matrix.roster[cached.probeIndex];
      return Object.freeze({ ...cached.evaluation, player, cacheHit: true });
    }

    const answerIndices = candidateIndices(matrix, legalCandidates);
    const candidateKeys = new Set(legalCandidates.map(Solver.playerKey));
    const available = answerIndices.filter(index => !guessedKeys.has(matrix.keys[index]));
    const probeIndices = available.length ? available : answerIndices;
    let best = null;
    let bestIndex = null;

    for (const probeIndex of probeIndices) {
      const evaluation = evaluateCandidateProbe(matrix, answerIndices, candidateKeys, probeIndex);
      if (compareSpeed(evaluation, best) < 0) {
        best = evaluation;
        bestIndex = probeIndex;
      }
    }

    const result = Object.freeze({
      ...best,
      purpose: 'answer',
      strategy: 'single-speed-first',
      cacheHit: false,
      reason: legalCandidates.length === 1
        ? '只剩唯一合法候选，立即提交答案。'
        : `单人速度实验：从 ${legalCandidates.length} 名合法候选中直接猜答案；本猜命中率约 ${(100 / legalCandidates.length).toFixed(1)}%。`,
    });
    remember(cacheKey, { probeIndex: bestIndex, evaluation: result });
    return result;
  }

  function evaluateOpening(matrix, probe) {
    const probeIndex = typeof probe === 'number'
      ? probe
      : matrix.indexByKey.get(Solver.playerKey(probe));
    if (probeIndex === undefined) return null;
    const answerIndices = matrix.roster.map((_, index) => index);
    const candidateKeys = new Set(matrix.keys);
    const evaluation = evaluateCandidateProbe(matrix, answerIndices, candidateKeys, probeIndex);
    return Object.freeze({
      ...evaluation,
      secondGuessCeilingUniform: evaluation.partitions / answerIndices.length,
      guaranteedBySecondRate: evaluation.singletonAnswers / answerIndices.length,
    });
  }

  function rankOpenings(matrix) {
    return matrix.roster
      .map((player, index) => evaluateOpening(matrix, index))
      .sort((left, right) => (
        right.secondGuessCeilingUniform - left.secondGuessCeilingUniform
        || left.worstGroup - right.worstGroup
        || left.expectedRemaining - right.expectedRemaining
        || Solver.normalize(left.player.nick).localeCompare(Solver.normalize(right.player.nick))
      ));
  }

  if (runtimePatchAllowed) {
    Automation.AssistantSession.prototype.recommend = function singleSpeedFirstRecommend(maxGuesses = 8) {
      const original = originalRecommend.call(this, maxGuesses);
      if (!this.history?.length || !original?.candidates?.length) return original;

      const recommendation = recommendSpeed({
        matrix: this.matrix,
        candidates: original.candidates,
        guessedKeys: this.guessedKeys,
        remainingGuesses: original.remainingGuesses,
      });
      this.lastRecommendation = recommendation;
      this.lastStrategy = 'single-speed-first';
      return Object.freeze({ ...original, recommendation });
    };
  }

  globalThis.FribergSpeedStrategy = Object.freeze({
    recommendSpeed,
    evaluateOpening,
    rankOpenings,
    runtimePatchAllowed,
    cacheSize: () => recommendationCache.size,
    clearCache: () => recommendationCache.clear(),
  });
})();
