(() => {
  'use strict';

  const Automation = globalThis.FribergAutomation;
  const Solver = globalThis.GameSolver;
  if (!Automation?.AssistantSession || !Solver) return;

  const HUMAN_ANSWER_THRESHOLD = 12;
  const normalize = value => Solver.normalize(String(value || ''));

  const FAME_TIERS = [
    [100, ['s1mple', 'zywoo', 'niko', 'device', 'donk', 'm0nesy']],
    [95, ['karrigan', 'fallen', 'coldzera', 'olofmeister', 'get_right', 'f0rest', 'dupreeh', 'gla1ve', 'apex', 'ropz', 'twistzz', 'rain', 'electronic', 'sh1ro', 'b1t', 'jame']],
    [90, ['broky', 'ax1le', 'cadian', 'snax', 'hooxi', 'stewie2k', 'tarik', 'kennys', 'guardian', 'jw', 'flusha', 'krimz', 'xyp9x', 'magisk', 'elige', 'naf', 'yekindar', 'hunter', 'malbsmd', 'w0nderful']],
    [85, ['fer', 'taco', 'fnx', 'boltz', 'neymar', 'adren', 'dosia', 'hobbit', 'zeus', 'edward', 'seized', 'boombl4', 'perfecto', 'flamie', 'simple', 'dev1ce', 'm0nesy', 'chopper', 'zont1x', 'magixx', 'wonderful']],
    [80, ['nertz', 'spinx', 'flamez', 'mezii', 'xertion', 'torzsi', 'siuhy', 'jimpphat', 'frozen', 'woxic', 'xantares', 'tabsen', 'syrson', 'stavn', 'jabbi', 'teses', 'sjuush', 'nicoodoz', 'blamef']],
    [75, ['art', 'kscerato', 'yuurih', 'chelo', 'saffee', 'skullz', 'insani', 'exit', 'dumau', 'latto', 'vini', 'hen1', 'lucas1', 'kngv', 'steel', 'boltz', 'felps', 'trk', 'coldzera']],
    [70, ['nbk', 'shox', 'rpk', 'happy', 'smithzz', 'scream', 'ex6tenz', 'bodyy', 'amanek', 'jackz', 'misutaaa', 'kyojin', 'alex', 'woro2k', 'sdy', 'aleksib', 'mantuu', 'valde', 'k0nfig', 'es3tag']],
    [65, ['pasha', 'neo', 'taz', 'byali', 'snax', 'michu', 'innocent', 'dycha', 'hades', 'sunny', 'allu', 'sergej', 'aerial', 'xseven', 'aleksib', 'ence', 'markeloff', 'starix', 'ceh9']],
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

  function popularityScore(player) {
    const nick = normalize(player?.nick || player?.nickname);
    const team = normalize(player?.gameTeam || player?.team);
    const fame = BASE_FAME.get(nick) || 0;
    const teamScore = TEAM_FAME.get(team) || 0;
    const majorWins = Math.max(0, Number(player?.majorWins ?? player?.major_championships) || 0);
    const majorApps = Math.max(0, Number(player?.majorApps ?? player?.major_appearances) || 0);
    const active = player?.gameActive === true || player?.is_active === true ? 6 : 0;
    const legacy = majorWins > 0 ? 8 : 0;
    return fame + teamScore + majorWins * 4 + Math.min(majorApps, 15) * 0.7 + active + legacy;
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

  function chooseHumanCandidate(session) {
    const candidates = (session.lastCandidates || [])
      .filter(player => !session.guessedKeys?.has(Solver.playerKey(player)));
    if (candidates.length < 2 || candidates.length > HUMAN_ANSWER_THRESHOLD) return null;

    const ranked = candidates
      .map(player => ({ player, popularity: popularityScore(player), evaluation: evaluateCandidate(session, player) }))
      .filter(item => item.evaluation)
      .sort((left, right) => {
        if (right.popularity !== left.popularity) return right.popularity - left.popularity;
        if (left.evaluation.worstGroup !== right.evaluation.worstGroup) return left.evaluation.worstGroup - right.evaluation.worstGroup;
        if (left.evaluation.expectedRemaining !== right.evaluation.expectedRemaining) return left.evaluation.expectedRemaining - right.evaluation.expectedRemaining;
        return normalize(left.player.nick).localeCompare(normalize(right.player.nick));
      });

    const best = ranked[0];
    if (!best) return null;
    return Object.freeze({
      ...best.evaluation,
      popularityScore: best.popularity,
      humanChoice: true,
      reason: `剩余 ${candidates.length} 名候选，优先选择普通玩家更可能先想到的知名选手；信息指标作为同热度时的次级排序。`,
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
    popularityScore,
    chooseHumanCandidate,
  });
})();
