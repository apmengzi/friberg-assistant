(function bootstrapFribergUltimatePolicy(root, factory) {
  const api = factory(root.GameSolver, root.FribergAutomation);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FribergUltimatePolicy = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createUltimatePolicyApi(Solver, Automation) {
  'use strict';

  if (!Solver) throw new Error('FribergUltimatePolicy requires GameSolver.');
  if (!Automation) throw new Error('FribergUltimatePolicy requires FribergAutomation.');

  const OPENING = 'refrezh';
  const STRATEGIES = Object.freeze({ SAFE: 'safe', RACE: 'race' });
  const matrixCache = new WeakMap();
  const normalize = value => Solver.normalize(value);

  function matrixFor(players) {
    let matrix = matrixCache.get(players);
    if (!matrix) {
      matrix = Automation.buildFeedbackMatrix(players);
      matrixCache.set(players, matrix);
    }
    return matrix;
  }

  function raceEvaluation(players, candidates, guessedKeys) {
    const legal = candidates.filter(player => player?.enabled !== false && !guessedKeys.has(Solver.playerKey(player)));
    if (!legal.length) return null;
    if (legal.length === 1) {
      return Object.freeze({
        player: legal[0],
        worstGroup: 0,
        expectedRemaining: 0,
        entropy: 0,
        partitions: 1,
        purpose: 'answer',
        reason: '唯一合法候选，直接作答。',
      });
    }

    let best = null;
    for (const probe of legal) {
      const groups = new Map();
      for (const answer of legal) {
        if (Solver.playerKey(answer) === Solver.playerKey(probe)) continue;
        const signature = Solver.feedbackSignature(answer, probe);
        groups.set(signature, (groups.get(signature) || 0) + 1);
      }
      let squares = 0;
      let worstGroup = 0;
      let entropy = 0;
      for (const size of groups.values()) {
        squares += size * size;
        worstGroup = Math.max(worstGroup, size);
        const probability = size / legal.length;
        entropy -= probability * Math.log2(probability);
      }
      const evaluation = {
        player: probe,
        worstGroup,
        expectedRemaining: squares / legal.length,
        entropy,
        partitions: groups.size,
        purpose: 'answer',
      };
      if (!best
        || evaluation.expectedRemaining < best.expectedRemaining
        || evaluation.expectedRemaining === best.expectedRemaining && evaluation.worstGroup < best.worstGroup
        || evaluation.expectedRemaining === best.expectedRemaining && evaluation.worstGroup === best.worstGroup && evaluation.partitions > best.partitions
        || evaluation.expectedRemaining === best.expectedRemaining && evaluation.worstGroup === best.worstGroup && evaluation.partitions === best.partitions
          && normalize(evaluation.player.nick).localeCompare(normalize(best.player.nick)) < 0) {
        best = evaluation;
      }
    }
    return Object.freeze({ ...best, reason: '竞速策略：优先降低猜错后的期望剩余候选，同时仍直接命中候选。' });
  }

  function resolveCandidates(players, history, guessedKeys) {
    const strict = Solver.filterCandidates(players, history, guessedKeys);
    if (strict.length) {
      return Object.freeze({
        candidates: strict,
        mode: 'strict',
        conflicts: [],
        note: '',
      });
    }

    if (typeof Solver.rankDataDriftCandidates !== 'function') {
      return Object.freeze({ candidates: [], mode: 'none', conflicts: [], note: '严格候选归零。' });
    }

    const drift = Solver.rankDataDriftCandidates(players, history, guessedKeys, 1);
    if (!drift?.candidates?.length) {
      return Object.freeze({ candidates: [], mode: 'none', conflicts: [], note: '严格候选与单字段漂移容错均归零。' });
    }
    const fields = [...new Set((drift.conflicts || []).flatMap(item => item.fields || []))];
    return Object.freeze({
      candidates: drift.candidates,
      mode: 'data-drift',
      conflicts: drift.conflicts || [],
      note: `题库漂移容错：${fields.join('/') || '1 个字段'}`,
    });
  }

  function openingPlayer(players) {
    const matches = players.filter(player => normalize(player.nick) === OPENING);
    if (matches.length !== 1) throw new Error(`题库中 ${OPENING} 匹配 ${matches.length} 人。`);
    return matches[0];
  }

  function recommend({
    players = [],
    history = [],
    guessedKeys = new Set(),
    remainingGuesses = 8,
    strategy = STRATEGIES.SAFE,
  } = {}) {
    const roster = players.filter(player => player?.enabled !== false);
    if (!roster.length) throw new Error('没有可用选手题库。');

    if (!history.length && !guessedKeys.size) {
      return Object.freeze({
        player: openingPlayer(roster),
        candidates: roster,
        candidateCount: roster.length,
        resolution: 'strict',
        conflicts: [],
        note: '固定最优首猜 refrezh。',
        strategy,
        purpose: 'opening',
      });
    }

    const resolution = resolveCandidates(roster, history, guessedKeys);
    if (!resolution.candidates.length) {
      const error = new Error(resolution.note || '没有合法候选。');
      error.code = 'NO_CANDIDATES';
      error.resolution = resolution;
      throw error;
    }

    let evaluation;
    if (strategy === STRATEGIES.RACE) {
      evaluation = raceEvaluation(roster, resolution.candidates, guessedKeys);
    } else {
      evaluation = Automation.recommendNext({
        players: roster,
        matrix: matrixFor(roster),
        candidates: resolution.candidates,
        guessedKeys,
        remainingGuesses,
      });
    }
    if (!evaluation?.player) throw new Error('推荐策略没有返回选手。');

    return Object.freeze({
      ...evaluation,
      candidates: resolution.candidates,
      candidateCount: resolution.candidates.length,
      resolution: resolution.mode,
      conflicts: resolution.conflicts,
      note: resolution.note || evaluation.reason || '',
      strategy,
    });
  }

  return Object.freeze({
    version: 1,
    opening: OPENING,
    strategies: STRATEGIES,
    openingPlayer,
    resolveCandidates,
    recommend,
  });
}));
