const FIELD_DEFS = [
  { key: 'region', label: '地区', placeholder: '中国 / 亚洲 / 欧洲', type: 'text' },
  { key: 'age', label: '年龄', placeholder: '24 或 19-24', type: 'text' },
  { key: 'role', label: '角色', placeholder: '步枪 / 狙击 / IGL', type: 'text' },
  { key: 'majorWins', label: 'Major 冠军', placeholder: '0', type: 'number' },
  { key: 'majorApps', label: 'Major 次数', placeholder: '8', type: 'number' },
  { key: 'status', label: '状态', placeholder: '现役 / 退役', type: 'text' },
  { key: 'team', label: '当前战队', placeholder: 'FaZe / 未签约', type: 'text' },
];

// Historical fixture retained only for development reference. It is never used
// as a runtime fallback: the solver must not silently shrink to this list.
const SEED_PLAYERS = [
  ['frozen','David Čerňanský','Slovakia','Europe',24,'rifler','FaZe','active',0,8,1.16],
  ['karrigan','Finn Andersen','Denmark','Europe',36,'rifler','Falcons','active',2,22,1.01],
  ['degster','Abdul Gasanov','Russia','Europe',24,'awper','Unsigned','inactive',0,5,1.10],
  ['device','Nicolai Reedtz','Denmark','Europe',30,'awper','100 Thieves','active',4,17,1.16],
  ['torzsi','Ádám Torzsás','Hungary','Europe',24,'awper','MOUZ','active',0,7,1.10],
  ['Farlig','Asger Jensen','Denmark','Europe',25,'awper','Unsigned','inactive',1,7,1.03],
  ['Perfecto','Ilya Zalutskiy','Russia','Europe',26,'rifler','Cloud9','inactive',1,9,1.05],
  ['FL1T','Evgeny Lebedev','Russia','Europe',23,'rifler','Virtus.pro','active',0,7,1.10],
  ['ICY','Almaz Asadullin','Russia','Europe',20,'awper','Virtus.pro','active',0,4,1.06],
  ['s1mple','Oleksandr Kostyljev','Ukraine','Europe',28,'awper','BC.Game','inactive',1,20,1.24],
  ['ZywOo','Mathieu Herbaut','France','Europe',25,'awper','Vitality','active',1,12,1.25],
  ['m0NESY','Ilya Osipov','Russia','Europe',21,'awper','Falcons','active',1,8,1.22],
  ['sh1ro','Dmitry Sokolov','Russia','Europe',25,'awper','Spirit','active',1,11,1.20],
  ['donk','Danil Kryshkovets','Russia','Europe',19,'rifler','Spirit','active',1,5,1.22],
  ['Ax1Le','Sergey Rykhtorov','Russia','Europe',23,'rifler','Cloud9','active',0,10,1.14],
  ['Jame','Dzhami Ali','Russia','Europe',27,'awper','Virtus.pro','active',1,12,1.09],
  ['electroNic','Denis Sharipov','Russia','Europe',31,'rifler','Virtus.pro','active',1,18,1.10],
  ['Boombl4','Kirill Mikhailov','Russia','Europe',27,'rifler','BetBoom','active',1,14,1.06],
  ['b1t','Valeriy Vakhovskiy','Ukraine','Europe',23,'rifler','Natus Vincere','active',2,10,1.15],
  ['w0nderful','Ihor Zhdanov','Ukraine','Europe',22,'awper','Natus Vincere','active',1,7,1.13],
  ['YEKINDAR','Mareks Gaļinskis','Latvia','Europe',26,'rifler','Liquid','active',0,9,1.08],
  ['broky','Helvijs Saukants','Latvia','Europe',25,'awper','FaZe','active',1,8,1.11],
  ['rain','Håvard Nygaard','Norway','Europe',32,'rifler','FaZe','active',1,19,1.06],
  ['ropz','Robin Kool','Estonia','Europe',26,'rifler','FaZe','active',1,13,1.12],
  ['NiKo','Nikola Kovač','Bosnia and Herzegovina','Europe',29,'rifler','Falcons','active',1,17,1.16],
  ['huNter-','Nemanja Kovač','Bosnia and Herzegovina','Europe',30,'rifler','G2','active',0,10,1.10],
  ['maden','Pavle Bošković','Montenegro','Europe',28,'rifler','Falcons','active',0,7,1.04],
  ['dupreeh','Peter Rasmussen','Denmark','Europe',33,'rifler','Retired','retired',5,23,1.07],
  ['gla1ve','Lukas Rossander','Denmark','Europe',31,'rifler','Retired','retired',4,18,1.05],
  ['Xyp9x','Andreas Højsleth','Denmark','Europe',30,'rifler','Retired','retired',4,18,1.03],
  ['olofmeister','Olof Kajbjer','Sweden','Europe',34,'rifler','Retired','retired',2,20,1.05],
  ['KRIMZ','Freddy Johansson','Sweden','Europe',32,'rifler','fnatic','inactive',2,18,1.08],
  ['JW','Jesper Wecksell','Sweden','Europe',31,'awper','Retired','retired',3,17,1.08],
  ['flusha','Robin Rönnquist','Sweden','Europe',32,'rifler','Retired','retired',3,17,1.08],
  ['FalleN','Gabriel Toledo','Brazil','South America',35,'awper','FURIA','active',2,17,1.08],
  ['coldzera','Marcelo David','Brazil','South America',31,'rifler','Legacy','inactive',2,13,1.10],
  ['fer','Fernando Alvarenga','Brazil','South America',34,'rifler','Retired','retired',2,13,1.06],
  ['fnx','Lincoln Lau','Brazil','South America',35,'rifler','Retired','retired',2,14,1.03],
  ['arT','Andrei Piovezan','Brazil','South America',30,'rifler','FURIA','active',0,7,1.04],
  ['yuurih','Yuri Boian','Brazil','South America',26,'rifler','FURIA','active',0,12,1.10],
  ['KSCERATO','Kaike Cerato','Brazil','South America',27,'rifler','FURIA','active',0,10,1.12],
  ['saffee','Rafael Costa','Brazil','South America',31,'awper','Legacy','active',0,8,1.04],
  ['Twistzz','Russel Van Dulken','Canada','North America',26,'rifler','Liquid','active',1,15,1.12],
  ['EliGE','Jonathan Jablonowski','United States','North America',29,'rifler','FaZe','active',0,16,1.10],
  ['NAF','Keith Markovic','Canada','North America',29,'rifler','Liquid','active',1,14,1.08],
  ['nitr0','Nick Cannella','United States','North America',30,'rifler','Retired','retired',1,12,1.04],
  ['Stewie2K','Jacky Yip','United States','North America',28,'rifler','Liquid','active',1,13,1.06],
  ['mezii','William Merriman','United Kingdom','Europe',27,'rifler','Vitality','active',1,7,1.08],
  ['smooya','Owen Butterfield','United Kingdom','Europe',26,'awper','Unsigned','inactive',0,3,1.02],
  ['tabseN','Johannes Wodarz','Germany','Europe',30,'rifler','BIG','active',0,14,1.07],
  ['syrsoN','Nils Schoenhusen','Germany','Europe',29,'awper','BIG','active',0,5,1.05],
  ['Snax','Janusz Pogorzelski','Poland','Europe',32,'rifler','G2','active',1,15,1.04],
  ['TaZ','Wiktor Wojtas','Poland','Europe',40,'rifler','G2','active',1,16,1.01],
  ['STYKO','Martin Styk','Slovakia','Europe',29,'rifler','Apeks','active',0,10,1.03],
  ['GuardiaN','Ladislav Kovács','Slovakia','Europe',34,'awper','Retired','retired',0,16,1.10],
  ['allu','Aleksi Jalli','Finland','Europe',33,'awper','Retired','retired',0,12,1.05],
  ['sergej','Sergey Izotov','Finland','Europe',25,'rifler','Inactive','inactive',0,3,1.06],
  ['bLitz','Garidmagnai Byambasuren','Mongolia','Asia',25,'rifler','The MongolZ','active',0,5,1.10],
  ['Techno','Sodbayar Munkhbold','Mongolia','Asia',24,'rifler','The MongolZ','active',0,5,1.08],
  ['d4v41','Anis Jabal','Malaysia','Asia',25,'rifler','M80','active',0,5,1.06],
  ['BnTeT','Hansel Ferdinand','Indonesia','Asia',30,'rifler','Retired','inactive',0,6,1.05],
  ['xccurate','Kevin Susanto','Indonesia','Asia',26,'awper','Retired','inactive',0,5,1.04],
  ['somebody','Zhuo Zhi-Hao','China','Asia',30,'rifler','Retired','retired',0,5,1.04],
  ['kaze','Andrew Khong','Malaysia','Asia',31,'awper','Retired','inactive',0,7,1.02],
  ['Sico','Sean Gul','Australia','Oceania',29,'rifler','Rooster','active',0,2,1.02],
];

const normalize = value => String(value ?? '').trim().toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ');
const cleanKey = key => normalize(key).replace(/[_ -]/g, '');
const num = value => { const n = Number(String(value ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : null; };

const GAME_SOLVER = window.GameSolver;
if (!GAME_SOLVER) throw new Error('严格求解器未载入：请确认 solver.js 与 app.js 位于同一目录。');
const playersFromRows = rows => GAME_SOLVER.normalizeGamePlayers(rows);

const inferRegion = country => {
  const c = normalize(country);
  if (/亚太|亚洲|asia/.test(c)) return 'Asia';
  if (/独联体|cis/.test(c)) return 'CIS';
  if (/欧洲|europe/.test(c)) return 'Europe';
  if (/北美洲|北美|north america/.test(c)) return 'North America';
  if (/南美洲|南美|south america/.test(c)) return 'South America';
  if (/大洋洲|oceania/.test(c)) return 'Oceania';
  if (/非洲与以色列|非洲|africa/.test(c)) return 'Africa';
  if (/china|mongolia|malaysia|indonesia|japan|korea|vietnam|singapore|india|australia|new zealand/.test(c)) return /australia|new zealand/.test(c) ? 'Oceania' : 'Asia';
  if (/brazil|argentina|chile|peru|colombia|uruguay/.test(c)) return 'South America';
  if (/united states|canada|mexico/.test(c)) return 'North America';
  if (/south africa|egypt|morocco|tunisia/.test(c)) return 'Africa';
  return 'Europe';
};
const normalizeRole = role => { const r = normalize(role); if (/coach|教练/.test(r)) return 'coach'; if (/awp|sniper|狙/.test(r)) return 'awper'; if (/igl|leader|指挥/.test(r)) return 'igl'; if (/support|辅助/.test(r)) return 'support'; return 'rifler'; };
const normalizeStatus = status => {
  if (status === true || status === 1) return 'active';
  if (status === false || status === 0) return 'inactive';
  const s = normalize(status);
  if (s === 'true' || s === '1') return 'active';
  if (s === 'false' || s === '0') return 'inactive';
  if (/非现役|未签约|下放|inactive|bench|替补/.test(s)) return 'inactive';
  if (/retired|退役/.test(s)) return 'retired';
  if (/active|现役|在役/.test(s)) return 'active';
  return 'inactive';
};
const normalizePlayerStatus = row => {
  if (row.status !== undefined && row.status !== null && String(row.status).trim() !== '') return normalizeStatus(row.status);
  if (row.is_active !== undefined && row.is_active !== null) {
    if (row.is_active === false && /退役|retired/i.test(String(row.team || ''))) return 'retired';
    return normalizeStatus(row.is_active);
  }
  if (/退役|retired/i.test(String(row.team || ''))) return 'retired';
  return normalizeStatus(row.active || '');
};
const displayRole = role => ({rifler:'步枪',awper:'狙击',igl:'指挥',support:'辅助',coach:'教练'})[role] || role || '—';
const displayStatus = status => ({active:'现役',inactive:'非现役',retired:'退役'})[status] || '未知';
const countryRegion = player => `${player.country || '未知地区'} · ${player.region || '未知大区'}`;

const GAME_POOL_URL = 'data/players.game-646.json';
const MIN_GAME_POOL_SIZE = 600;
let players = [];
let clues = Object.fromEntries(FIELD_DEFS.map(field => [field.key, { state: 'off', value: '' }]));
let searchTerm = '';
let toastTimer;
let databaseSource = 'GAME POOL / LOADING';
let gamePoolReady = false;
let gamePoolError = '正在读取本地 646 人游戏题库…';
const excludedPlayerKeys = new Set();
let guessHistory = [];

function playerIdentity(player) {
  return GAME_SOLVER.playerKey(player);
}

function emptyClues() {
  return Object.fromEntries(FIELD_DEFS.map(field => [field.key, { state: 'off', value: '' }]));
}

function cloneClues(source) {
  return Object.fromEntries(Object.entries(source).map(([key, clue]) => [key, { ...clue }]));
}

const VISION_FIELDS = [
  { key: 'team', label: '战队' },
  { key: 'region', label: '国家' },
  { key: 'age', label: '年龄' },
  { key: 'role', label: '位置' },
  { key: 'majorWins', label: '冠军' },
  { key: 'majorApps', label: '参赛' },
  { key: 'status', label: '状态' },
];
const VISION_STATES = {
  correct: { label: '精确', color: '#199a60', rgb: [25, 154, 96] },
  close: { label: '接近', color: '#cd7d0e', rgb: [205, 125, 14] },
  wrong: { label: '排除', color: '#a89ba3', rgb: [168, 155, 163] },
  unknown: { label: '未读', color: '#3d4944', rgb: [61, 73, 68] },
};
const vision = { cells: [], player: null, rowBand: null, imageUrl: '', directions: { age: 'none', majorWins: 'none', majorApps: 'none' } };

const $ = selector => document.querySelector(selector);
const clueList = $('#clueList');
const resultGrid = $('#resultGrid');
const emptyState = $('#emptyState');

function renderClueControls() {
  clueList.innerHTML = FIELD_DEFS.map(field => {
    const clue = clues[field.key];
    return `<div class="clue-row" data-key="${field.key}" data-state="${clue.state}">
      <label class="clue-label" for="clue-${field.key}"><span class="clue-dot"></span>${field.label}</label>
      <div class="clue-control">
        <select class="clue-state" aria-label="${field.label}匹配方式">
          <option value="off" ${clue.state === 'off' ? 'selected' : ''}>忽略</option>
          <option value="exact" ${clue.state === 'exact' ? 'selected' : ''}>精确 =</option>
          <option value="near" ${clue.state === 'near' ? 'selected' : ''}>接近 ≈</option>
          <option value="exclude" ${clue.state === 'exclude' ? 'selected' : ''}>排除 ≠</option>
        </select>
        <input id="clue-${field.key}" class="clue-value" type="${field.type}" placeholder="${field.placeholder}" value="${clue.value}" inputmode="${field.type === 'number' ? 'numeric' : 'text'}" />
      </div>
    </div>`;
  }).join('');
  clueList.querySelectorAll('.clue-state').forEach(select => select.addEventListener('change', event => {
    const key = event.target.closest('.clue-row').dataset.key;
    clues[key].state = event.target.value;
    event.target.closest('.clue-row').dataset.state = event.target.value;
    renderResults();
  }));
  clueList.querySelectorAll('.clue-value').forEach(input => input.addEventListener('input', event => {
    const key = event.target.closest('.clue-row').dataset.key;
    clues[key].value = event.target.value;
    if (event.target.value && clues[key].state === 'off') { clues[key].state = 'exact'; const select = event.target.parentElement.querySelector('select'); select.value = 'exact'; event.target.closest('.clue-row').dataset.state = 'exact'; }
    renderResults();
  }));
}

function fieldActive(key) { return clues[key].state !== 'off' && String(clues[key].value).trim() !== ''; }
function hasClues() { return guessHistory.length > 0 || FIELD_DEFS.some(field => fieldActive(field.key)); }
function parseAge(value) {
  const text = normalize(value); const range = text.match(/(\d{1,2})\s*(?:-|到|至)\s*(\d{1,2})/); if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const plus = text.match(/(\d{1,2})\s*\+|大于\s*(\d{1,2})/); if (plus) return { min: Number(plus[1] || plus[2]), max: 99 };
  const one = text.match(/\d{1,2}/); return one ? { min: Number(one[0]), max: Number(one[0]) } : null;
}
function parseText(raw) {
  const text = normalize(raw); const next = {};
  const set = (key, value, state = 'exact') => { if (value !== null && value !== undefined && String(value).trim() !== '') next[key] = { state, value: String(value) }; };
  const countries = ['china','中国','russia','俄罗斯','denmark','丹麦','slovakia','斯洛伐克','france','法国','ukraine','乌克兰','brazil','巴西','sweden','瑞典','canada','加拿大','united states','美国','poland','波兰','germany','德国','mongolia','蒙古','malaysia','马来西亚','indonesia','印度尼西亚','finland','芬兰','norway','挪威','latvia','拉脱维亚','estonia','爱沙尼亚','bosnia','波黑','montenegro','黑山','hungary','匈牙利','united kingdom','英国','australia','澳大利亚'];
  const country = countries.find(c => text.includes(c));
  const regions = [{v:'Asia', terms:['亚洲','asia']},{v:'Europe',terms:['欧洲','europe']},{v:'South America',terms:['南美','south america']},{v:'North America',terms:['北美','north america']},{v:'Africa',terms:['非洲','南非','africa','south africa']},{v:'Oceania',terms:['大洋洲','oceania']}];
  const region = regions.find(r => r.terms.some(t => text.includes(t)));
  if (country) set('region', country); else if (region) set('region', region.v);
  const age = parseAge(text); if (age) set('age', age.min === age.max ? age.min : `${age.min}-${age.max}`);
  if (/步枪|rifler|rifle/.test(text)) set('role','rifler'); else if (/狙击|狙击手|awp|awper|sniper/.test(text)) set('role','awper'); else if (/指挥|igl|leader/.test(text)) set('role','igl'); else if (/辅助|support/.test(text)) set('role','support');
  const wins = text.match(/(\d+)\s*(?:个|次)?\s*(?:冠|冠军|major\s*win)/); if (wins) set('majorWins', wins[1]);
  const apps = text.match(/(\d+)\s*(?:次|届|站)?\s*(?:参赛|major|major\s*次|次)/); if (apps && (!wins || apps.index !== wins.index)) set('majorApps', apps[1]);
  if (/非现役|未签约|下放|inactive|替补|bench/.test(text)) set('status','inactive'); else if (/退役|retired/.test(text)) set('status','retired'); else if (/现役|active|在役/.test(text)) set('status','active');
  const knownNumeric = [...text.matchAll(/\d+/g)].map(m => Number(m[0])).filter(n => n >= 0 && n <= 50);
  if (!next.majorWins && knownNumeric.length >= 2 && age && knownNumeric.length >= 2) { set('majorWins', knownNumeric[knownNumeric.length - 2]); set('majorApps', knownNumeric[knownNumeric.length - 1]); }
  if (country && !next.region) set('region', country); return next;
}
function applyParsed(parsed) {
  Object.entries(parsed).forEach(([key, value]) => { if (clues[key]) clues[key] = value; });
  renderClueControls(); renderResults(); showToast(`已解析 ${Object.keys(parsed).length} 条线索`);
}

function tokenize(value) { return normalize(value).split(/[\s,，/·|]+/).filter(Boolean); }
const REGION_ALIASES = {
  asia: ['asia', '亚洲', '亚太', 'apac'],
  cis: ['cis', '独联体'],
  europe: ['europe', '欧洲'],
  'north america': ['north america', '北美', '北美洲'],
  'south america': ['south america', '南美', '南美洲'],
  oceania: ['oceania', '大洋洲'],
  africa: ['africa', '非洲', '非洲与以色列', '非洲和以色列', 'israel', '以色列'],
};
function canonicalRegion(value) {
  const normalized = normalize(value);
  if (!normalized) return '';
  return Object.entries(REGION_ALIASES).find(([, aliases]) => aliases.some(alias => normalize(alias) === normalized))?.[0] || normalized;
}
function sameRegion(left, right) {
  const a = canonicalRegion(left); const b = canonicalRegion(right);
  return Boolean(a && b && a === b);
}
function valueMatches(player, key, query, state, direction = 'none') {
  const q = normalize(query); if (!q) return { match: true, distance: 0 };
  if (key === 'age') {
    const range = parseAge(q); if (!range || player.age == null) return { match: false, distance: 99 };
    const distance = player.age < range.min ? range.min - player.age : player.age > range.max ? player.age - range.max : 0;
    const directionOk = direction === 'up' ? player.age > range.max : direction === 'down' ? player.age < range.min : true;
    const match = state === 'exclude' ? distance > 3 && directionOk : state === 'near' ? distance > 0 && distance <= 3 && directionOk : distance === 0;
    return { match, distance };
  }
  if (key === 'majorWins' || key === 'majorApps') {
    const wanted = num(q); if (wanted == null) return { match: false, distance: 99 };
    const got = player[key] ?? 0; const distance = Math.abs(got - wanted); const tolerance = 1;
    const directionOk = direction === 'up' ? got > wanted : direction === 'down' ? got < wanted : true;
    const match = state === 'exclude' ? distance > tolerance && directionOk : state === 'near' ? distance > 0 && distance <= tolerance && directionOk : distance === 0;
    return { match, distance };
  }
  if (key === 'role') { const role = normalizeRole(q); const match = player.role === role; return { match: state === 'exclude' ? !match : match, distance: match ? 0 : 1 }; }
  if (key === 'status') { const status = normalizeStatus(q); const match = player.status === status; return { match: state === 'exclude' ? !match : match, distance: match ? 0 : 1 }; }
  if (key === 'region') {
    // Free-form filtering is separate from screenshot feedback.  A typed
    // country means that country exactly; a typed game region means that
    // region exactly.  Screenshot country gray/yellow is handled only by
    // GameSolver, where gray correctly means “outside this game region”.
    const isKnownCountry = players.some(candidate => normalize(candidate.country) === q);
    const wantedRegion = GAME_SOLVER.gameRegionFromValue(query, players);
    const match = isKnownCountry
      ? normalize(player.country) === q
      : Boolean(wantedRegion && GAME_SOLVER.gameRegionOf(player) === wantedRegion);
    return { match: state === 'exclude' ? !match : match, distance: match ? 0 : 1 };
  }
  if (key === 'team') { const match = normalize(player.team).includes(q); return { match: state === 'exclude' ? !match : match, distance: match ? 0 : 1 }; }
  return { match: true, distance: 0 };
}

function scoreOneClue(player, field, clue, strict) {
  const result = valueMatches(player, field.key, clue.value, clue.state, clue.direction || 'none');
  const weight = field.key === 'region' || field.key === 'role' || field.key === 'status' ? 2.2 : 1.7;
  if (clue.state === 'exact') return result.match ? { score: weight * 1.9, hardFail: false, ok: true } : { score: strict ? -weight * 6 : -weight * 1.4, hardFail: strict, ok: false };
  if (clue.state === 'near') return result.match ? { score: weight * 1.1, hardFail: false, ok: true } : { score: strict ? -weight * 6 : -Math.min(result.distance * .5, weight), hardFail: strict, ok: false };
  if (clue.state === 'exclude') return result.match ? { score: weight * 1.5, hardFail: false, ok: true } : { score: -weight * 5, hardFail: strict, ok: false };
  return { score: 0, hardFail: false, ok: true };
}
function scorePlayer(player) {
  // Screenshot history must never fall back into this manual scoring helper.
  // `sortResults` routes it through GameSolver.filterCandidates instead.
  if (guessHistory.length) return { player, score: 0, hardFail: true, distances: [] };
  let score = 0; let hardFail = false; let distances = []; const strict = $('#strictMode').checked || guessHistory.length > 0;
  const applyClue = (field, clue) => {
    if (!clue || clue.state === 'off' || String(clue.value ?? '').trim() === '') return;
    const scored = scoreOneClue(player, field, clue, strict); score += scored.score; hardFail = hardFail || scored.hardFail;
    distances.push({ key: field.key, ok: scored.ok, state: clue.state });
  };
  FIELD_DEFS.forEach(field => { if (fieldActive(field.key)) applyClue(field, clues[field.key]); });
  const query = normalize(searchTerm); if (query) { const haystack = normalize(`${player.nick} ${player.realName} ${player.country} ${player.team}`); if (!haystack.includes(query)) hardFail = true; else score += 5; }
  return { player, score, hardFail, distances };
}
function matchesSearch(player) {
  const query = normalize(searchTerm);
  if (!query) return true;
  return normalize(`${player.nick} ${player.realName} ${player.country} ${player.team}`).includes(query);
}
function sortResults() {
  // A screenshot history is always a strict AND intersection.  There is no
  // score path here: a candidate satisfying 6/7 cells is not a candidate.
  if (guessHistory.length) {
    return GAME_SOLVER
      .filterCandidates(players, guessHistory.map(record => record.feedback), excludedPlayerKeys)
      .filter(matchesSearch)
      .sort((a, b) => normalize(a.nick).localeCompare(normalize(b.nick)))
      .map(player => ({ player, score: 0, distances: [] }));
  }
  return players
    .map(scorePlayer)
    .filter(item => !item.hardFail && !excludedPlayerKeys.has(playerIdentity(item.player)))
    .filter(item => matchesSearch(item.player))
    .sort((a, b) => b.score - a.score || (b.player.rating || 0) - (a.player.rating || 0));
}

function feedbackSignature(answer, probe) {
  return GAME_SOLVER.feedbackSignature(answer, probe);
}

function probePool(candidateResults) {
  // 下一猜只能从仍可能是答案的人里挑。此前把整个数据库补进探针池，会出现
  // “已知是狙击手却推荐教练”这类信息增益高、但实战完全错误的建议。
  const limit = Math.min(220, candidateResults.length);
  return candidateResults.slice(0, limit).map(item => item.player);
}

function bestNextProbe(candidateResults) {
  const candidatePlayers = candidateResults.map(item => item.player);
  if (candidatePlayers.length <= 1) return null;
  const pool = probePool(candidateResults);
  if (!pool.length) return null;
  const total = candidatePlayers.length;
  let best = null;
  pool.forEach(probe => {
    const groups = new Map();
    candidatePlayers.forEach(answer => {
      const signature = feedbackSignature(answer, probe);
      groups.set(signature, (groups.get(signature) || 0) + 1);
    });
    let expectedRemaining = 0;
    let worstGroup = 0;
    groups.forEach(size => { expectedRemaining += size * size; worstGroup = Math.max(worstGroup, size); });
    const score = expectedRemaining / total + worstGroup * 0.001;
    if (!best || score < best.score) best = { player: probe, score };
  });
  return best ? best.player : null;
}

function renderRecommendations(results) {
  const active = hasClues();
  const answer = results.length === 1 ? results[0]?.player : null;
  $('#bestAnswer').textContent = active && answer ? answer.nick : '—';
  $('#remainingCount').textContent = active ? String(results.length) : '—';
  const probe = active && results.length > 1 ? bestNextProbe(results) : null;
  $('#bestProbe').textContent = probe ? probe.nick : (active && answer ? '已锁定' : '—');
}

function renderResults() {
  const started = performance.now();
  if (!gamePoolReady) {
    renderRecommendations([]);
    $('#playerCount').textContent = '0'; $('#dataCount').textContent = '0'; $('#latency').textContent = `${Math.max(0, Math.round(performance.now() - started))} ms`;
    $('#resultsTitle').textContent = '题库未就绪';
    $('#resultsMeta').textContent = gamePoolError || '无法安全载入游戏题库，因此不会给出候选或推荐。';
    $('#activeFilters').innerHTML = '';
    emptyState.classList.remove('visible');
    resultGrid.innerHTML = '<div class="no-results">请通过项目目录中的 <code>start.bat</code> 或 <code>start.ps1</code> 启动，然后刷新页面。题库加载失败时不会再退回 65 人的种子库。</div>';
    return;
  }
  const indexedPlayers = players.filter(player => !excludedPlayerKeys.has(playerIdentity(player)));
  const results = hasClues() || searchTerm ? sortResults() : indexedPlayers.slice(0, 12).map(player => ({player,score:0,distances:[]}));
  const visible = results.slice(0, 24);
  const activeCount = guessHistory.length
    ? guessHistory.reduce((total, record) => total + Object.keys(record.feedback?.fields || {}).length, 0)
    : FIELD_DEFS.filter(field => fieldActive(field.key)).length;
  renderRecommendations(results);
  $('#playerCount').textContent = players.length.toLocaleString('en-US'); $('#dataCount').textContent = players.length.toLocaleString('en-US'); $('#latency').textContent = `${Math.max(0, Math.round(performance.now() - started))} ms`;
  $('#resultsTitle').textContent = hasClues() ? `${results.length} 名候选` : searchTerm ? `${results.length} 条检索结果` : '热门候选';
  $('#resultsMeta').textContent = hasClues()
    ? (guessHistory.length
      ? `已合并 ${guessHistory.length} 次猜测 · ${activeCount} 条严格颜色约束 · 所有卡片均同时满足每一格反馈`
      : `${activeCount} 条手动线索 · 已按匹配强度排序 · 昵称可点击复制`)
    : '先输入线索；也可以直接用右上角搜索昵称、国家或战队。';
  renderFilters();
  emptyState.classList.toggle('visible', !hasClues() && !searchTerm && players.length === 0);
  if (!visible.length) { resultGrid.innerHTML = '<div class="no-results">没有同时满足这些条件的记录。截图模式不会用“相似度”保留违反颜色反馈的候选；请先校正本行颜色或数字箭头。</div>'; return; }
  resultGrid.innerHTML = visible.map((item, index) => cardTemplate(item, index)).join('');
  resultGrid.querySelectorAll('.copy-name').forEach(button => button.addEventListener('click', () => copyName(button.dataset.nick)));
}
function renderFilters() {
  if (guessHistory.length) {
    const regionName = region => ({ asia: '亚太', cis: '独联体', europe: '欧洲', northAmerica: '北美洲', southAmerica: '南美洲', oceania: '大洋洲', africaIsrael: '非洲与以色列' }[region] || region || '未知赛区');
    const fieldName = { team: '战队', country: '国家', age: '年龄', role: '位置', majorWins: '冠军', majorApps: '参赛', status: '状态' };
    const stateClass = color => color === 'close' ? 'near' : color === 'wrong' ? 'exclude' : '';
    const formatField = (key, field) => {
      const arrow = GAME_SOLVER.NUMERIC_FIELDS.has(key) ? field.direction === 'up' ? ' ↑' : field.direction === 'down' ? ' ↓' : '' : '';
      if (key === 'country') {
        if (field.color === 'correct') return `国家 = ${field.guess.country}`;
        if (field.color === 'close') return `国家 ≈ ${regionName(field.guess.region)}（非${field.guess.country}）`;
        return `国家 ≠ ${regionName(field.guess.region)}赛区`;
      }
      const value = key === 'role'
        ? displayRole(GAME_SOLVER.normalizeRole(field.guess))
        : key === 'status'
          ? displayStatus(field.guess === true ? 'active' : field.guess === false ? 'retired' : GAME_SOLVER.normalizeStatus(field.guess))
          : field.guess;
      const operator = field.color === 'correct' ? '=' : field.color === 'close' ? '≈' : '≠';
      return `${fieldName[key]} ${operator} ${value}${arrow}`;
    };
    $('#activeFilters').innerHTML = guessHistory.flatMap((record, index) => Object.entries(record.feedback?.fields || {}).map(([key, field]) => (
      `<span class="filter-chip ${stateClass(field.color)}">#${index + 1} ${escapeHtml(record.guessedNick)} · ${escapeHtml(formatField(key, field))}</span>`
    ))).join('');
    return;
  }
  const chips = FIELD_DEFS.filter(field => fieldActive(field.key)).map(field => {
    const clue = clues[field.key]; const stateClass = clue.state === 'near' ? 'near' : clue.state === 'exclude' ? 'exclude' : '';
    const value = field.key === 'role' ? displayRole(normalizeRole(clue.value)) : field.key === 'status' ? displayStatus(normalizeStatus(clue.value)) : clue.value;
    const arrow = ['age', 'majorWins', 'majorApps'].includes(field.key) ? clue.direction === 'up' ? ' ↑' : clue.direction === 'down' ? ' ↓' : '' : '';
    return `<span class="filter-chip ${stateClass}">${field.label} ${clue.state === 'exact' ? '=' : clue.state === 'near' ? '≈' : '≠'} ${value}${arrow}</span>`;
  }).join('');
  $('#activeFilters').innerHTML = chips;
}
function cardTemplate(item, index) {
  const p = item.player; const score = Math.max(0, Math.round(item.score * 10) / 10); const statusClass = p.status; const top = index === 0 && hasClues() ? 'top-match' : ''; const reason = reasonText(item);
  const matchLabel = guessHistory.length ? '合法候选' : hasClues() ? `${score} MATCH` : 'INDEXED';
  return `<article class="player-card ${top}" style="animation-delay:${Math.min(index * 20, 300)}ms"><div class="card-top"><span class="card-rank">${String(index + 1).padStart(2,'0')}</span><span class="match-score">${matchLabel}</span></div><h3>${escapeHtml(p.nick)}</h3><div class="player-real">${escapeHtml(p.realName || 'HLTV player record')}</div><div class="card-team">${escapeHtml(p.team || '未签约')}</div><div class="metric-row"><div class="metric"><span>地区</span><strong>${escapeHtml(shortCountry(p.country))}</strong></div><div class="metric"><span>年龄</span><strong>${p.age ?? '—'}</strong></div><div class="metric"><span>角色</span><strong>${displayRole(p.role)}</strong></div><div class="metric"><span>冠 / 次</span><strong>${p.majorWins} / ${p.majorApps}</strong></div></div><div class="card-bottom"><span class="country-label">${escapeHtml(p.region || '—')}</span><span class="status-pill ${statusClass}">${displayStatus(p.status)}</span></div>${reason ? `<p class="reason-line">${reason}</p>` : ''}<button class="copy-name" type="button" data-nick="${escapeAttr(p.nick)}">复制昵称</button></article>`;
}
function reasonText(item) {
  if (guessHistory.length) return `通过 <b>${guessHistory.length} 次猜测</b>的全部颜色约束`;
  const hits = item.distances.filter(d => d.ok && d.state !== 'exclude').map(d => ({region:'地区',age:'年龄',role:'角色',majorWins:'冠军',majorApps:'次数',status:'状态',team:'战队'}[d.key])).filter(Boolean); return hits.length ? `命中 <b>${hits.slice(0,3).join(' · ')}</b>${hits.length > 3 ? ' · …' : ''}` : '';
}
function shortCountry(country) { const map = {'United States':'US','United Kingdom':'UK','Bosnia and Herzegovina':'BiH','South Africa':'ZA'}; return map[country] || country || '—'; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
const escapeAttr = escapeHtml;
async function copyName(nick) { try { await navigator.clipboard.writeText(nick); showToast(`已复制：${nick}`); } catch { showToast(`答案：${nick}`); } }
function showToast(message, error = false) { const toast = $('#toast'); toast.textContent = message; toast.classList.toggle('error', error); toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2200); }
function rebuildExcludedPlayers() { excludedPlayerKeys.clear(); guessHistory.forEach(record => excludedPlayerKeys.add(record.playerKey)); }
function undoLastGuess() {
  if (!guessHistory.length) { showToast('本局还没有可撤销的截图猜测', true); return; }
  const removed = guessHistory.pop(); rebuildExcludedPlayers(); clues = emptyClues();
  renderClueControls(); renderResults(); showToast(`已撤销第 ${guessHistory.length + 1} 次猜测：${removed.guessedNick}`);
}
function resetClues() { clues = emptyClues(); guessHistory = []; excludedPlayerKeys.clear(); $('#clueText').value = ''; $('#searchInput').value = ''; searchTerm = ''; resetVision(); renderClueControls(); renderResults(); }

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim()); if (!lines.length) return [];
  const parseLine = line => { const cells = []; let cell = '', quote = false; for (let i=0;i<line.length;i++) { const c=line[i]; if (c === '"') quote = !quote; else if (c === ',' && !quote) { cells.push(cell.trim()); cell=''; } else cell += c; } cells.push(cell.trim()); return cells; };
  const headers = parseLine(lines[0]).map(cleanKey); return lines.slice(1).map(line => { const cells=parseLine(line); return Object.fromEntries(headers.map((h,i)=>[h,cells[i] ?? ''])); });
}
function setDataStatus(text, isError = false) {
  $('#dataStatus').textContent = text;
  $('#dataStatus').closest('.index-status')?.classList.toggle('is-error', isError);
}
function installGamePool(rows, source, updatedText) {
  const imported = playersFromRows(rows).filter(player => player.enabled !== false);
  if (imported.length < MIN_GAME_POOL_SIZE) {
    throw new Error(`游戏题库只有 ${imported.length} 人；为避免退回不完整索引，至少需要 ${MIN_GAME_POOL_SIZE} 人。`);
  }
  players = imported;
  databaseSource = source;
  gamePoolReady = true;
  gamePoolError = '';
  excludedPlayerKeys.clear();
  guessHistory = [];
  clues = emptyClues();
  setDataStatus(`GAME POOL / ${players.length}`);
  $('#dataUpdated').textContent = updatedText;
  populateVisionPlayers();
  updateCompleteness();
  renderClueControls();
  renderResults();
}
function failGamePool(error) {
  players = [];
  databaseSource = 'GAME POOL / ERROR';
  gamePoolReady = false;
  gamePoolError = `本地游戏题库未载入：${error.message || error}`;
  excludedPlayerKeys.clear();
  guessHistory = [];
  clues = emptyClues();
  setDataStatus('GAME POOL / ERROR', true);
  $('#dataUpdated').textContent = '未载入';
  populateVisionPlayers();
  updateCompleteness();
  renderClueControls();
  renderResults();
}
function importData(text, filename='游戏题库') {
  try {
    const parsed = filename.toLowerCase().endsWith('.csv') ? parseCsv(text) : JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : parsed.players || parsed.data || [];
    if (!Array.isArray(rows)) throw new Error('文件中没有可读取的选手数组。');
    installGamePool(rows, `GAME POOL / ${filename.replace(/\.[^.]+$/,'')}`, '刚刚导入');
    showToast(`游戏题库已载入：${players.length} 名选手`);
  } catch (error) {
    showToast(`导入失败：${error.message}`, true);
  }
}
function updateCompleteness() { const keys = ['country','region','age','role','majorWins','majorApps','status']; const total = players.length * keys.length; const done = players.reduce((sum,p)=>sum+keys.filter(key => p[key] !== null && p[key] !== undefined && p[key] !== '').length,0); $('#dataCompleteness').textContent = total ? `${Math.round(done / total * 100)}%` : '—'; }

function populateVisionPlayers() {
  const list = $('#visionPlayerList');
  if (!list) return;
  list.innerHTML = players.slice().sort((a, b) => normalize(a.nick).localeCompare(normalize(b.nick))).map(player => `<option value="${escapeAttr(player.nick)}">${escapeHtml(player.country)} · ${escapeHtml(player.team)}</option>`).join('');
  syncVisionPlayer();
}
function findVisionPlayer(value) {
  const q = normalize(value);
  if (!q) return null;
  return players.find(player => normalize(player.nick) === q) || players.find(player => normalize(player.nick).startsWith(q)) || null;
}
function syncVisionPlayer() {
  const input = $('#visionPlayer');
  if (!input) return;
  vision.player = findVisionPlayer(input.value);
  input.classList.toggle('is-valid', Boolean(vision.player));
  const hasCompleteCells = vision.cells.length === VISION_FIELDS.length && vision.cells.some(state => state !== 'unknown');
  const feedback = vision.player && hasCompleteCells ? GAME_SOLVER.buildFeedback(vision.player, vision.cells, vision.directions) : null;
  const validation = feedback ? GAME_SOLVER.validateFeedback(feedback) : { valid: false, errors: [], warnings: [] };
  const warning = $('#visionWarning');
  if (warning) {
    const message = validation.errors[0] || validation.warnings[0] || '';
    warning.textContent = message;
    warning.hidden = !message;
    warning.classList.toggle('is-error', Boolean(validation.errors.length));
  }
  const canApply = gamePoolReady && Boolean(vision.player) && hasCompleteCells && validation.valid;
  $('#visionApply').disabled = !canApply;
}
function visionStateFromRgb(r, g, b) {
  let best = 'unknown'; let bestDistance = Number.POSITIVE_INFINITY;
  Object.entries(VISION_STATES).forEach(([state, definition]) => {
    if (state === 'unknown') return;
    const distance = Math.hypot(r - definition.rgb[0], g - definition.rgb[1], b - definition.rgb[2]);
    if (distance < bestDistance) { bestDistance = distance; best = state; }
  });
  return bestDistance <= 92 ? best : 'unknown';
}
function findDenseRuns(flags, minLength) {
  const runs = []; let start = -1;
  for (let index = 0; index <= flags.length; index += 1) {
    const on = index < flags.length && flags[index];
    if (on && start < 0) { start = index; continue; }
    if (!on && start >= 0) {
      const end = index - 1;
      if (end - start + 1 >= minLength) runs.push({ start, end });
      start = -1;
    }
  }
  return runs;
}
function summarizeVisionCell(data, width, run, y0, y1) {
  const paddingX = Math.max(2, Math.floor((run.end - run.start + 1) * 0.08));
  const paddingY = Math.max(2, Math.floor((y1 - y0) * 0.08));
  const left = run.start + paddingX; const right = run.end - paddingX + 1;
  const top = Math.max(0, y0 + paddingY); const bottom = Math.min(data.height, y1 - paddingY);
  const counts = { correct: 0, close: 0, wrong: 0 };
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * width + x) * 4;
      const state = visionStateFromRgb(data.data[offset], data.data[offset + 1], data.data[offset + 2]);
      if (counts[state] !== undefined) counts[state] += 1;
    }
  }
  const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const area = Math.max(1, (right - left) * (bottom - top));
  return counts[best] >= Math.max(16, Math.floor(area * 0.12)) ? best : 'unknown';
}
function feedbackRunsInBand(data, width, height, band) {
  const y0 = Math.max(0, band.top - 1); const y1 = Math.min(height, band.bottom + 2);
  const minColumnHits = Math.max(6, Math.floor((y1 - y0) * 0.35));
  const denseColumns = Array.from({ length: width }, (_, x) => {
    let hits = 0;
    for (let y = y0; y < y1; y += 1) {
      const offset = (y * width + x) * 4;
      if (visionStateFromRgb(data.data[offset], data.data[offset + 1], data.data[offset + 2]) !== 'unknown') hits += 1;
    }
    return hits >= minColumnHits;
  });
  const minCellWidth = Math.max(12, Math.floor(width * 0.018));
  return { y0, y1, runs: findDenseRuns(denseColumns, minCellWidth) };
}
function readNumericArrow(data, width, run, y0, y1) {
  const cellWidth = run.end - run.start + 1;
  const left = run.start + Math.floor(cellWidth * 0.62);
  const right = run.end - Math.max(2, Math.floor(cellWidth * 0.06));
  const top = y0 + Math.max(2, Math.floor((y1 - y0) * 0.15));
  const bottom = y1 - Math.max(2, Math.floor((y1 - y0) * 0.15));
  let total = 0; let weightedY = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * width + x) * 4;
      const r = data.data[offset]; const g = data.data[offset + 1]; const b = data.data[offset + 2];
      const isBrightInk = r > 180 && g > 180 && b > 180 && Math.max(r, g, b) - Math.min(r, g, b) < 80;
      if (isBrightInk) { total += 1; weightedY += y; }
    }
  }
  if (total < 4) return 'none';
  const center = (top + bottom - 1) / 2; const bias = weightedY / total - center;
  const threshold = Math.max(1, (bottom - top) * 0.045);
  return bias > threshold ? 'down' : bias < -threshold ? 'up' : 'none';
}
function scanVisionCanvas(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rowScores = new Uint32Array(canvas.height);
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const offset = (y * canvas.width + x) * 4;
      if (visionStateFromRgb(data.data[offset], data.data[offset + 1], data.data[offset + 2]) !== 'unknown') rowScores[y] += 1;
    }
  }
  const rowThreshold = Math.max(18, Math.floor(canvas.width * 0.004));
  const bands = [];
  let band = null;
  for (let y = 0; y < rowScores.length; y += 1) {
    if (rowScores[y] >= rowThreshold) {
      if (!band) band = { top: y, bottom: y };
      else band.bottom = y;
    } else if (band) {
      if (band.bottom - band.top >= 4) bands.push(band);
      band = null;
    }
  }
  if (band && band.bottom - band.top >= 4) bands.push(band);
  if (!bands.length) throw new Error('没有找到弗一把的彩色反馈行');

  // 先找横向的七个“实心色块”。昵称的抗锯齿文字也可能接近灰色，
  // 但它不会形成贯穿整行的宽色块，因此不会再挤占第一个反馈列。
  const candidates = bands.map(candidate => ({ band: candidate, ...feedbackRunsInBand(data, canvas.width, canvas.height, candidate) }));
  const viable = candidates.filter(candidate => candidate.runs.length >= VISION_FIELDS.length);
  const selected = viable[viable.length - 1];
  if (!selected) throw new Error('未能定位完整的 7 个反馈格，请截取包含最近一行猜测的区域');
  const runs = selected.runs.slice(-VISION_FIELDS.length);
  if (runs.length !== VISION_FIELDS.length) throw new Error('反馈格数量不完整');
  const cells = runs.map(run => summarizeVisionCell(data, canvas.width, run, selected.y0, selected.y1));
  const directions = { age: 'none', majorWins: 'none', majorApps: 'none' };
  [{ index: 2, key: 'age' }, { index: 4, key: 'majorWins' }, { index: 5, key: 'majorApps' }].forEach(({ index, key }) => {
    if (cells[index] !== 'correct') directions[key] = readNumericArrow(data, canvas.width, runs[index], selected.y0, selected.y1);
  });
  return {
    cells,
    directions,
    rowBand: { top: selected.band.top, bottom: selected.band.bottom, xMin: runs[0].start, xMax: runs[runs.length - 1].end, runs },
    bands: bands.length,
  };
}
function renderVisionReadout() {
  const cells = $('#visionCells'); const readout = $('#visionReadout');
  if (!cells || !readout) return;
  cells.innerHTML = vision.cells.map((state, index) => `<button class="vision-cell" type="button" data-index="${index}" data-state="${state}" title="${VISION_FIELDS[index].label}：${VISION_STATES[state].label}；点击可校正"><small>${VISION_FIELDS[index].label}</small><strong>${VISION_STATES[state].label}</strong></button>`).join('');
  const known = vision.cells.filter(state => state !== 'unknown').length;
  readout.textContent = known === VISION_FIELDS.length ? `${VISION_FIELDS.length} / ${VISION_FIELDS.length} 反馈格已识别` : `${known} / ${VISION_FIELDS.length} 反馈格已识别`;
  $('#visionDirection').hidden = !vision.cells.length;
  syncVisionDirectionControls();
  syncVisionPlayer();
}
function syncVisionDirectionControls() {
  const controls = { age: '#visionAgeDirection', majorWins: '#visionWinsDirection', majorApps: '#visionAppsDirection' };
  Object.entries(controls).forEach(([key, selector]) => {
    const control = $(selector); if (control) control.value = vision.directions[key] || 'none';
  });
}
function handleVisionFile(file) {
  if (!file || !file.type.startsWith('image/')) { showToast('请选择图片或直接粘贴截图', true); return; }
  const preview = $('#visionPreview'); const wrap = $('#visionPreviewWrap');
  const objectUrl = URL.createObjectURL(file);
  wrap.hidden = false; preview.src = objectUrl;
  preview.onload = () => {
    const canvas = document.createElement('canvas'); const scale = Math.min(1, 1600 / preview.naturalWidth);
    canvas.width = Math.max(1, Math.round(preview.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(preview.naturalHeight * scale));
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(preview, 0, 0, canvas.width, canvas.height);
    try {
      const result = scanVisionCanvas(canvas);
      vision.cells = result.cells; vision.rowBand = result.rowBand; vision.directions = { ...vision.directions, ...result.directions };
      renderVisionReadout(); showToast(`截图已读取：${result.cells.filter(state => state !== 'unknown').length}/${VISION_FIELDS.length} 个反馈色`);
    }
    catch (error) { vision.cells = []; vision.rowBand = null; renderVisionReadout(); showToast(error.message, true); }
    URL.revokeObjectURL(objectUrl);
  };
}
function applyVisionClues() {
  if (!gamePoolReady) { showToast('游戏题库未就绪，不能安全应用截图颜色。', true); return; }
  syncVisionPlayer();
  if (!vision.player) { showToast('先从本地题库选中这行猜测的昵称', true); return; }
  const player = vision.player;
  if (excludedPlayerKeys.has(playerIdentity(player))) { showToast(`${player.nick} 已在本局历史中，不能重复应用同一行。`, true); return; }
  const feedback = GAME_SOLVER.buildFeedback(player, vision.cells, vision.directions);
  const validation = GAME_SOLVER.validateFeedback(feedback);
  if (!validation.valid) { showToast(validation.errors[0] || '截图反馈不完整，请先校正颜色。', true); return; }
  // 昵称列不是反馈格；只要本行不是已经猜中的终局，刚才提交的昵称必然不是答案。
  // 它只会被排除，绝不会被当成“昵称精准”条件。
  excludedPlayerKeys.add(playerIdentity(player));
  guessHistory.push({ playerKey: playerIdentity(player), guessedNick: player.nick, feedback, cells: [...vision.cells], directions: { ...vision.directions }, createdAt: new Date().toISOString() });
  clues = emptyClues();
  renderClueControls(); renderResults();
  const allAttributesGreen = vision.cells.length === VISION_FIELDS.length && vision.cells.every(state => state === 'correct');
  showToast(allAttributesGreen
    ? `七项属性全绿但昵称未猜中：已排除 ${player.nick}，保留属性相同的其他候选。`
    : `已严格合并 ${player.nick} 的 ${Object.keys(feedback.fields).length} 条颜色约束${validation.warnings.length ? '；请校正数字箭头以进一步缩小候选' : ''}`);
}
function resetVision() {
  vision.cells = []; vision.player = null; vision.rowBand = null; vision.directions = { age: 'none', majorWins: 'none', majorApps: 'none' };
  const input = $('#visionPlayer'); if (input) { input.value = ''; input.classList.remove('is-valid'); }
  $('#visionPreviewWrap').hidden = true; $('#visionPreview').removeAttribute('src'); $('#visionDirection').hidden = true; renderVisionReadout();
}
async function loadLocalDatabase() {
  try {
    const response = await fetch(GAME_POOL_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('题库格式不是选手数组。');
    installGamePool(rows, `GAME POOL / ${rows.length}`, '本地完整版');
    showToast(`游戏题库已载入：${players.length} 名选手`);
  } catch (error) {
    failGamePool(error);
    showToast('游戏题库未载入；已停止候选推荐，不会使用 65 人回退库。', true);
  }
}
function exportData() { const blob = new Blob([JSON.stringify(players,null,2)], {type:'application/json'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='scout-console-players.json'; a.click(); URL.revokeObjectURL(url); showToast('已导出当前题库'); }

document.addEventListener('click', event => { const chip=event.target.closest('.hint-chip'); if (chip) { $('#clueText').value=chip.dataset.example; applyParsed(parseText(chip.dataset.example)); } });
$('#parseButton').addEventListener('click', () => applyParsed(parseText($('#clueText').value)));
$('#undoButton').addEventListener('click', undoLastGuess);
$('#resetButton').addEventListener('click', resetClues);
$('#newRoundButton').addEventListener('click', resetClues);
$('#strictMode').addEventListener('change', renderResults);
$('#searchInput').addEventListener('input', event => { searchTerm=event.target.value; renderResults(); });
$('#importButton').addEventListener('click', () => $('#importInput').click());
$('#importInput').addEventListener('change', async event => { const file=event.target.files[0]; if (!file) return; importData(await file.text(), file.name); event.target.value=''; });
$('#exportButton').addEventListener('click', exportData);
$('#visionButton').addEventListener('click', () => $('#visionInput').click());
$('#visionInput').addEventListener('change', event => { const file = event.target.files[0]; if (file) handleVisionFile(file); event.target.value = ''; });
$('#visionPlayer').addEventListener('input', syncVisionPlayer);
$('#visionApply').addEventListener('click', applyVisionClues);
$('#visionAgeDirection').addEventListener('change', event => { vision.directions.age = event.target.value; });
$('#visionWinsDirection').addEventListener('change', event => { vision.directions.majorWins = event.target.value; });
$('#visionAppsDirection').addEventListener('change', event => { vision.directions.majorApps = event.target.value; });
$('#visionCells').addEventListener('click', event => {
  const button = event.target.closest('.vision-cell[data-index]'); if (!button) return;
  const index = Number(button.dataset.index); if (!Number.isInteger(index) || !vision.cells[index]) return;
  const cycle = ['wrong', 'correct', 'close', 'unknown']; const current = cycle.indexOf(vision.cells[index]);
  vision.cells[index] = cycle[(current + 1) % cycle.length];
  renderVisionReadout(); showToast(`${VISION_FIELDS[index].label}已校正为${VISION_STATES[vision.cells[index]].label}`);
});
document.addEventListener('keydown', event => {
  if (event.ctrlKey && event.key.toLowerCase() === 'z') { event.preventDefault(); undoLastGuess(); }
});
$('#visionDropzone').addEventListener('dragover', event => { event.preventDefault(); event.currentTarget.classList.add('is-dragging'); });
$('#visionDropzone').addEventListener('dragleave', event => { event.currentTarget.classList.remove('is-dragging'); });
$('#visionDropzone').addEventListener('drop', event => { event.preventDefault(); event.currentTarget.classList.remove('is-dragging'); const file = [...event.dataTransfer.files].find(item => item.type.startsWith('image/')); if (file) handleVisionFile(file); });
document.addEventListener('paste', event => {
  const item = [...(event.clipboardData?.items || [])].find(candidate => candidate.type.startsWith('image/'));
  if (item) { event.preventDefault(); handleVisionFile(item.getAsFile()); }
});
document.addEventListener('keydown', event => { if (event.key === '/' && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') { event.preventDefault(); $('#searchInput').focus(); } if (event.key === 'F2') { event.preventDefault(); $('#clueText').focus(); } if (event.key === 'Escape') { $('#searchInput').blur(); $('#clueText').blur(); } });

renderClueControls(); populateVisionPlayers(); updateCompleteness(); renderResults(); void loadLocalDatabase();
