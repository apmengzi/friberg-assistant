(function bootstrapFribergRacePolicy(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FribergRacePolicy = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createRacePolicy() {
  'use strict';

  const signatureCache = new Map();
  const normalize = (Solver, value) => Solver.normalize
    ? Solver.normalize(value)
    : String(value || '').trim().toLocaleLowerCase();

  function signature(Solver, answer, probe) {
    const key = `${Solver.playerKey(probe)}>${Solver.playerKey(answer)}`;
    let value = signatureCache.get(key);
    if (value === undefined) {
      value = Solver.feedbackSignature(answer, probe);
      signatureCache.set(key, value);
    }
    return value;
  }

  function choose({ Solver, candidates = [], guessedKeys = new Set() } = {}) {
    if (!Solver) throw new Error('race policy requires GameSolver');
    const legal = candidates.filter(player => (
      player?.enabled !== false
      && !guessedKeys.has(Solver.playerKey(player))
    ));
    if (!legal.length) return null;
    if (legal.length === 1) return legal[0];

    let best = null;
    for (const probe of legal) {
      const groups = new Map();
      for (const answer of legal) {
        if (Solver.playerKey(answer) === Solver.playerKey(probe)) continue;
        const value = signature(Solver, answer, probe);
        groups.set(value, (groups.get(value) || 0) + 1);
      }
      let squares = 0;
      let worst = 0;
      for (const size of groups.values()) {
        squares += size * size;
        worst = Math.max(worst, size);
      }
      const evaluation = {
        player: probe,
        expectedWrongRemaining: squares / legal.length,
        worstWrongGroup: worst,
        partitions: groups.size,
      };
      if (!best
        || evaluation.expectedWrongRemaining < best.expectedWrongRemaining
        || evaluation.expectedWrongRemaining === best.expectedWrongRemaining
          && evaluation.worstWrongGroup < best.worstWrongGroup
        || evaluation.expectedWrongRemaining === best.expectedWrongRemaining
          && evaluation.worstWrongGroup === best.worstWrongGroup
          && evaluation.partitions > best.partitions
        || evaluation.expectedWrongRemaining === best.expectedWrongRemaining
          && evaluation.worstWrongGroup === best.worstWrongGroup
          && evaluation.partitions === best.partitions
          && normalize(Solver, evaluation.player.nick)
            .localeCompare(normalize(Solver, best.player.nick)) < 0) {
        best = evaluation;
      }
    }
    return best?.player || legal[0];
  }

  return Object.freeze({
    version: 1,
    poolSize: 646,
    poolSha256: '2d8dbe6d2b876d76ba5b0d928c89296343f00005b8ddfb585d85b16d8f6855e5',
    opening: 'refrezh',
    exactAtMostTwo: 268,
    exactAtMostTwoRate: 268 / 646,
    simulatedDepths: Object.freeze({ 1: 1, 2: 267, 3: 287, 4: 79, 5: 11, 6: 1 }),
    choose,
    cacheSize: () => signatureCache.size,
  });
}));
