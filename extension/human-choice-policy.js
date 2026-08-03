(() => {
  'use strict';

  const Automation = globalThis.FribergAutomation;
  const Solver = globalThis.GameSolver;
  if (!Automation?.AssistantSession || !Solver) return;

  // Human-priority is deliberately a tie-break / near-tie policy. It should
  // make recommendations feel like a strong human player without throwing
  // away a materially better information split.
  const HUMAN_ANSWER_THRESHOLD = 24;
  const SMALL_DIRECT_ANSWER_THRESHOLD = 3;
  const EXPECTED_REMAINING_RATIO = 1.12;
  const EXPECTED_REMAINING_ABSOLUTE_SLACK = 0.25;
  const normalize = value => Solver.normalize(String(value || ''));

  const FAME_TIERS = [
    [100, ['s1mple', 'zywoo', 'niko', 'device', 'donk', 'm0nesy']],
    [95, ['karrigan', 'fallen', 'coldzera', 'olofmeister', 'get_right', 'f0rest', 'dupreeh', 'gla1ve', 'apex', 'ropz', 'twistzz', 'rain', 'electronic', 'sh1ro', 'b1t', 'jame']],
    [90, ['broky', 'ax1le', 'cadian', 'snax', 'hooxi', 'stewie2k', 'tarik', 'kennys', 'guardian', 'jw', 'flusha', 'krimz', 'xyp9x', 'magisk', 'elige', 'naf', 'yekindar', 'hunter', 'malbsmd', 'w0nderful']],
    [85, ['fer', 'taco', 'fnx', 'boltz', 'adren', 'dosia', 'hobbit', 'zeus', 'edward', 'seized', 'boombl4', 'perfecto', 'flamie', 'chopper', 'zont1x', 'magixx']],
    [80, ['nertz', 'spinx', 'flamez', 'mezii', 'xertion', 'torzsi', 'siuhy', 'jimpphat', 'frozen', 'woxic', 'xantares', 'tabsen', 'syrson', 'stavn', 'jabbi', 'teses', 'sjuush', 'nicoodoz', 'blamef']],
    [75, ['art', 'kscerato', 'yuurih', 'chelo', 'saffee', 'skullz', 'insani', 'exit', 'dumau', 'latto', 'vini', 'hen1', 'lucas1', 'kngv', 'steel', 'felps', 'trk']],
    [70, ['nbk', 'shox', 'rpk', 'happy', 'smithzz', 'scream', 'ex6tenz', 'bodyy', 'amanek', 'jackz', 'misutaaa', 'kyojin', 'alex', 'woro2k', 'sdy', 'aleksib', 'mantuu', 'valde', 'k0nfig', 'es3tag']],
    [65, ['pasha', 'neo', 'taz', 'byali', 'michu', 'innocent', 'dycha', 'hades', 'sunny', 'allu', 'sergej', 'aerial', 'xseven', 'markeloff', 'starix', 'ceh9']],
  ];

  const BASE_FAME = new Map();
  for (const [score, names] of FAME_TIERS) {
    for (const name of names) {
      const key = normalize(name);
      BASE_FAME.set(key, Math.max(score, BASE_FAME.get(key) || 0));
    }
  }

  const TEAM_FAME = new Map([
    ['natus vincere', 16], ['navi', 16], ['vitality', 16], ['g2', 16], ['faze', 16],
    ['astralis', 15], ['spirit', 15], ['liquid', 14], ['mouz', 14], ['virtus.pro', 14],
    ['furia', 13], ['falcons', 13], ['fnatic', 13], ['nip', 13], ['cloud9', 13],
    ['gambit', 12], ['sk', 12], ['luminosity', 12], ['ence', 11], ['complexity', 11],
    ['heroic', 11], ['big', 10], ['the mongolz', 10], ['mibr', 10], ['imperial', 9],
  ]);

  function productionPopularitySignal(player) {
    const key = normalize(player?.nick || player?.nickname);
    const signals = globalThis.FribergProductionData?.getPopularitySignals?.();
    const signal = signals?.[key];
    if (!signal) return 0;
    const seen = Math.max(0, Number(signal.seen) || 0);
    const revealed = Math.max(0, Number(signal.revealed) || 0);
    const chosen = Math.max(0, Number(signal.chosen) || 0);
    return Math.min(18, Math.log2(1 + seen) * 1.5 + Math.log2(1 + revealed) * 3 + Math.log2(1 + chosen) * 2);
  }

  function popularityScore(player) {
    const nick = normalize(player?.nick || player?.nickname);
    const team = normalize(player?.gameTeam || player?.team);
    const difficulty = normalize(player?.difficulty || player?.difficulties);
    const fame = BASE_FAME.get(nick) || 0;
    const teamScore = TEAM_FAME.get(team) || 0;
    const majorWins = Math.max(0, Number(player?.majorWins ?? player?.major_championships) || 0);
    const majorApps = Math.max(0, Number(player?.majorApps ?? player?.major_appearances) || 0);
    const active = player?.gameActive === true || player?.is_active === true ? 6 : 0;
    const legacy = majorWins > 0 ? 8 : 0;
    const famousPool = /easy|famous|入门|简单|知名/.test(difficulty) ? 34 : 0;
    return fame
      + teamScore
      + majorWins * 4
      + Math.min(majorApps, 15) * 0.7
      + active
      + legacy
      + famousPool
      + productionPopularitySignal(player);
  }

  function evaluateCandidate(session, player) {
    const matrix = session.matrix;
    const candidates = session.lastCandidates || [];
    const probeIndex = matrix?.indexByKey?.get(Solver.playerKey(player));
    if (probeIndex === undefined || !candidates.length) return null;
    const groups = new Map();
    for (const answer of candidates) {
      const answerIndex = matrix.indexByKey.get(Solver.playerKey(answer));
      if (answerIndex === undefined) continue;
      const signature = matrix.signatures[probeIndex][answerIndex];
      groups.set(signature, (groups.get(signature) || 0) + 1);
    }
    let squares = 0;
    let worstGroup = 0;
    let entropy = 0;
    for (const size of groups.values()) {
      squares += size * size;
      worstGroup = Math.max(worstGroup, size);
      const probability = size / candidates.length;
      entropy -= probability * Math.log2(probability);
    }
    return {
      player,
      worstGroup,
      expectedRemaining: squares / candidates.length,
      entropy,
      partitions: groups.size,
      isCandidate: true,
      purpose: 'answer',
    };
  }

  function compareQuality(left, right) {
    if (!right) return -1;
    if (left.worstGroup !== right.worstGroup) return left.worstGroup - right.worstGroup;
    if (left.expectedRemaining !== right.expectedRemaining) return left.expectedRemaining - right.expectedRemaining;
    if (left.entropy !== right.entropy) return right.entropy - left.entropy;
    return normalize(left.player.nick).localeCompare(normalize(right.player.nick));
  }

  function isNearOptimal(evaluation, best, candidateCount) {
    if (candidateCount <= SMALL_DIRECT_ANSWER_THRESHOLD) return true;
    const worstSlack = Math.max(1, Math.floor(candidateCount * 0.06));
    const expectedLimit = best.expectedRemaining * EXPECTED_REMAINING_RATIO + EXPECTED_REMAINING_ABSOLUTE_SLACK;
    return evaluation.worstGroup <= best.worstGroup + worstSlack
      && evaluation.expectedRemaining <= expectedLimit;
  }

  function chooseHumanCandidate(session) {
    const candidates = (session.lastCandidates || [])
      .filter(player => !session.guessedKeys?.has(Solver.playerKey(player)));
    if (candidates.length < 2 || candidates.length > HUMAN_ANSWER_THRESHOLD) return null;

    const evaluated = candidates
      .map(player => ({ player, popularity: popularityScore(player), evaluation: evaluateCandidate(session, player) }))
      .filter(item => item.evaluation);
    if (!evaluated.length) return null;

    const qualityBest = evaluated
      .map(item => item.evaluation)
      .sort(compareQuality)[0];
    const nearOptimal = evaluated.filter(item => isNearOptimal(item.evaluation, qualityBest, candidates.length));
    const ranked = nearOptimal.sort((left, right) => {
      if (right.popularity !== left.popularity) return right.popularity - left.popularity;
      return compareQuality(left.evaluation, right.evaluation);
    });

    const best = ranked[0];
    if (!best) return null;
    const direct = candidates.length <= SMALL_DIRECT_ANSWER_THRESHOLD;
    return Object.freeze({
      ...best.evaluation,
      popularityScore: best.popularity,
      humanChoice: true,
      qualityGuarded: !direct,
      reason: direct
        ? `只剩 ${candidates.length} 名合法候选，命中概率相同，优先选择普通玩家更可能先想到的知名选手。`
        : `剩余 ${candidates.length} 名候选，只在接近最优的信息分割内优先知名选手，避免小众探针显得反常。`,
    });
  }

  const prototype = Automation.AssistantSession.prototype;
  const originalRecommend = prototype.recommend;
  if (typeof originalRecommend !== 'function' || prototype.__fribergHumanChoicePatched) return;

  Object.defineProperty(prototype, '__fribergHumanChoicePatched', { value: true });
  prototype.recommend = function recommendWithHumanPriority(maxGuesses = 8) {
    const result = originalRecommend.call(this, maxGuesses);
    const humanChoice = chooseHumanCandidate(this);
    if (!humanChoice) return result;
    this.lastRecommendation = humanChoice;
    return Object.freeze({ ...result, recommendation: humanChoice });
  };

  globalThis.FribergHumanChoice = Object.freeze({
    threshold: HUMAN_ANSWER_THRESHOLD,
    smallDirectAnswerThreshold: SMALL_DIRECT_ANSWER_THRESHOLD,
    popularityScore,
    evaluateCandidate,
    chooseHumanCandidate,
  });
})();