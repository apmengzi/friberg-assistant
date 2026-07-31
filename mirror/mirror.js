(function startFribergMirror() {
  'use strict';

  const { GameSolver, FribergAutomation } = window;
  if (!GameSolver || !FribergAutomation) throw new Error('镜像缺少求解器或自动化核心。');

  const $ = selector => document.querySelector(selector);
  const root = $('#fribergMirror');
  const answerSelect = $('#answerSelect');
  const input = $('#guessInput');
  const dropdown = $('#playerDropdown');
  const form = $('#guessForm');
  const submit = $('#submitGuess');
  const board = $('#selfBoard');
  const error = $('#guessError');
  const readout = $('#roundReadout');
  const result = $('#roundResult');
  const status = $('#automationStatus');
  const consent = $('#automationConsent');
  const autoRun = $('#autoRun');
  const autoPause = $('#autoPause');

  let players = [];
  let matrix = null;
  let selectedPlayer = null;
  let round = null;
  let auto = null;

  const playerId = player => GameSolver.playerKey(player);
  const displayRole = role => ({ rifler: '步枪手', awper: '狙击手', coach: '教练', igl: '指挥', support: '辅助' })[role] || role;
  const displayStatus = player => player.gameActive ? '现役' : '退役';
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

  function setNativeInputValue(element, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setStatus(message) { status.textContent = message; }
  function resetSelection() { selectedPlayer = null; input.dataset.playerId = ''; submit.disabled = true; }
  function currentTarget() { return players.find(player => playerId(player) === answerSelect.value) || null; }

  function renderOptions(query = '') {
    const wanted = GameSolver.normalize(query);
    const matching = players.filter(player => {
      const haystack = GameSolver.normalize(`${player.nick} ${player.country} ${player.team}`);
      return wanted && haystack.includes(wanted);
    }).slice(0, 20);
    dropdown.innerHTML = matching.map(player => (
      `<button class="player-option" data-friberg-option data-player-id="${escapeHtml(playerId(player))}" type="button" role="option"><span>${escapeHtml(player.nick)}</span><small>${escapeHtml(player.country)} · ${escapeHtml(player.team)}</small></button>`
    )).join('');
  }

  function choosePlayerById(id) {
    const player = players.find(item => playerId(item) === id);
    if (!player) throw new Error(`未知 playerId：${id}`);
    setNativeInputValue(input, player.nick);
    selectedPlayer = player;
    input.dataset.playerId = id;
    dropdown.innerHTML = '';
    submit.disabled = !round || ['won', 'lost'].includes(round.status);
    error.textContent = '';
    return player;
  }

  function buildCell(field, guess, answer) {
    const feedback = GameSolver.classifyFeedback(answer, guess, field);
    const color = feedback.color === 'correct' ? 'green' : feedback.color === 'close' ? 'yellow' : 'gray';
    const values = {
      team: guess.team,
      country: guess.country,
      age: guess.age,
      role: displayRole(guess.role),
      majorWins: guess.majorWins,
      majorApps: guess.majorApps,
      status: displayStatus(guess),
    };
    const arrow = feedback.direction && feedback.direction !== 'none' ? `<span class="arrow" data-friberg-direction="${feedback.direction}">${feedback.direction === 'up' ? '↑' : '↓'}</span>` : '<span class="arrow" data-friberg-direction="none"></span>';
    const numeric = GameSolver.NUMERIC_FIELDS.has(field);
    return `<span class="feedback-cell" data-friberg-field="${field}" data-friberg-color="${color}" data-friberg-direction="${numeric ? feedback.direction : 'none'}">${escapeHtml(values[field])}${numeric ? arrow : ''}</span>`;
  }

  function addFeedbackRow(guess, answer, index) {
    const fields = GameSolver.FIELD_ORDER.map(field => buildCell(field, guess, answer)).join('');
    const row = document.createElement('article');
    row.dataset.fribergFeedbackRow = '';
    row.dataset.fribergRowId = `${round.id}:${index}:${playerId(guess)}`;
    row.dataset.fribergPlayerId = playerId(guess);
    row.dataset.fribergGuessKey = playerId(guess);
    row.setAttribute('role', 'row');
    row.innerHTML = `<span data-friberg-field="nickname">${escapeHtml(guess.nick)}</span>${fields}`;
    board.append(row);
    return row;
  }

  function readVisibleFeedback(row) {
    const cell = field => row.querySelector(`[data-friberg-field="${field}"]`);
    const color = field => cell(field)?.dataset.fribergColor;
    const direction = field => cell(field)?.dataset.fribergDirection || 'none';
    return {
      team: color('team'),
      country: color('country'),
      age: { color: color('age'), direction: direction('age') },
      role: color('role'),
      majorWins: { color: color('majorWins'), direction: direction('majorWins') },
      majorAppearances: { color: color('majorApps'), direction: direction('majorApps') },
      status: color('status'),
    };
  }

  function renderRoundState() {
    const count = round?.guesses.length || 0;
    readout.textContent = `${count} / 8`;
    root.dataset.roundStatus = round?.status || 'idle';
    submit.disabled = !round || ['won', 'lost'].includes(round.status) || !selectedPlayer;
  }

  function newRound() {
    if (auto?.session && ![FribergAutomation.STATES.WON, FribergAutomation.STATES.LOST, FribergAutomation.STATES.IDLE].includes(auto.session.state)) {
      auto.session.pause('NEW_ROUND');
    }
    auto = null;
    board.innerHTML = '';
    resetSelection();
    round = { id: `local-${Date.now()}`, answer: currentTarget(), guesses: [], status: 'playing' };
    root.dataset.fribergRoundId = round.id;
    result.textContent = '本地回合已开始。输入昵称并从唯一 playerId 选项中选择。';
    error.textContent = '';
    setStatus('本地回合进行中');
    autoPause.disabled = true;
    renderRoundState();
    input.focus();
  }

  function submitSelectedGuess() {
    if (!round || round.status !== 'playing') return;
    if (!selectedPlayer || input.dataset.playerId !== playerId(selectedPlayer)) {
      error.textContent = '必须从下拉结果中按 playerId 选择选手。';
      return;
    }
    const guess = selectedPlayer;
    const row = addFeedbackRow(guess, round.answer, round.guesses.length + 1);
    round.guesses.push(guess);
    const won = playerId(guess) === playerId(round.answer);
    const lost = !won && round.guesses.length >= 8;
    round.status = won ? 'won' : lost ? 'lost' : 'playing';
    result.textContent = won ? `胜利：${guess.nick} 就是答案。` : lost ? `本地测试结束，答案是 ${round.answer.nick}。` : '反馈已写入自己的棋盘。';
    resetSelection();
    renderRoundState();
    document.dispatchEvent(new CustomEvent('friberg:mirror-feedback', {
      detail: { row, guess, won, lost, roundId: round.id, reading: readVisibleFeedback(row) },
    }));
  }

  function takeAutoStep(recommendation) {
    if (!auto || auto.stopped || !round || round.status !== 'playing') return;
    try {
      auto.session.beginPageAction(root.dataset.fribergAutomation === 'authorized');
      setStatus(`自动提交：${recommendation.player.nick} · ${recommendation.purpose}`);
      setNativeInputValue(input, recommendation.player.nick);
      renderOptions(recommendation.player.nick);
      const exact = dropdown.querySelector(`[data-friberg-option][data-player-id="${CSS.escape(playerId(recommendation.player))}"]`);
      if (!exact) throw new Error('下拉菜单未出现目标 playerId。');
      exact.click();
      submitSelectedGuess();
    } catch (cause) {
      auto.stopped = true;
      auto.session.pause(cause.message);
      setStatus(`已暂停：${cause.message}`);
      autoPause.disabled = true;
    }
  }

  function startAuto() {
    if (!round || round.status !== 'playing') newRound();
    if (!consent.checked) return;
    const session = new FribergAutomation.AssistantSession({
      players,
      matrix,
      origin: location.origin,
      mode: FribergAutomation.MODES.AUTO,
    });
    auto = { session, stopped: false };
    const initial = session.startRound(round.id);
    autoPause.disabled = false;
    takeAutoStep(initial.recommendation);
  }

  function pauseAuto(reason = 'USER_PAUSED') {
    if (!auto) return;
    auto.stopped = true;
    auto.session.pause(reason);
    setStatus(`已暂停：${reason}`);
    autoPause.disabled = true;
  }

  async function init() {
    const response = await fetch('../data/players.game-646.json');
    const rows = await response.json();
    players = GameSolver.normalizeGamePlayers(rows).filter(player => player.enabled !== false);
    matrix = FribergAutomation.buildFeedbackMatrix(players);
    answerSelect.innerHTML = players.map(player => `<option value="${escapeHtml(playerId(player))}">${escapeHtml(player.nick)} · ${escapeHtml(player.country)}</option>`).join('');
    answerSelect.value = playerId(players.find(player => player.nick === 'z4kr') || players[0]);
    setStatus(`题库已载入：${players.length} 人；矩阵已就绪。`);
    newRound();
  }

  input.addEventListener('input', () => { resetSelection(); renderOptions(input.value); });
  dropdown.addEventListener('click', event => {
    const option = event.target.closest('[data-friberg-option]');
    if (option) choosePlayerById(option.dataset.playerId);
  });
  form.addEventListener('submit', event => { event.preventDefault(); submitSelectedGuess(); });
  $('#newRound').addEventListener('click', newRound);
  consent.addEventListener('change', () => { autoRun.disabled = !consent.checked; });
  autoRun.addEventListener('click', startAuto);
  autoPause.addEventListener('click', () => pauseAuto());
  document.addEventListener('friberg:mirror-feedback', event => {
    if (!auto || auto.stopped) return;
    const { guess, won, lost, reading } = event.detail;
    try {
      const next = auto.session.recordVisibleFeedback(guess, reading, { won, lost, maxGuesses: 8 });
      if (won || lost) {
        auto.stopped = true;
        autoPause.disabled = true;
        setStatus(won ? `本地自动化胜利：${round.guesses.length} 次。` : '本地自动化已结束。');
        return;
      }
      queueMicrotask(() => takeAutoStep(next.recommendation));
    } catch (cause) {
      pauseAuto(cause.message);
    }
  });

  window.FribergMirror = Object.freeze({
    startAuto,
    pauseAuto,
    newRound,
    getRound: () => round,
    getPlayers: () => players.slice(),
    readVisibleFeedback,
  });

  init().catch(cause => {
    setStatus(`初始化失败：${cause.message}`);
    root.dataset.roundStatus = 'error';
  });
}());
