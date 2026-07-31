(function bootstrapFribergLiveDomAdapter(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FribergLiveDomAdapter = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createFribergLiveDomAdapter() {
  'use strict';

  const ROOT_IDS = new Set(['friberg-assistant-overlay', 'friberg-scriptcat-assistant']);
  const SELF_MARKERS = ['我的猜测', '我的竞猜', 'my guesses', 'my guess'];
  const OPPONENT_MARKERS = ['对方猜测', '对手猜测', 'opponent guesses', 'opponent guess'];
  const WAITING_MARKERS = ['正在获取房间状态', '等待对局', '等待对手', '匹配中', 'waiting for room', 'waiting for opponent'];
  const SENSITIVE_NAME = /(cookie|token|secret|password|passcode|credential|authorization|session|api[-_]?key)/i;
  const EXCLUDED_SELECTOR = '[data-friberg-assistant-overlay], #friberg-assistant-overlay, #friberg-scriptcat-assistant, [class*="chat" i], [class*="message" i], [data-chat], [name*="password" i], [type="password"]';
  const BOARD_SELECTOR = 'table.game-table, [data-friberg-board], [role="grid"], .guess-board, .single-game-board';
  const INPUT_SELECTOR = 'input:not([type="hidden"]):not([type="password"]), textarea';
  const OPTION_SELECTOR = '[role="option"], [data-player-id], [data-playerid], .option, .opt, [class*="dropdown" i] li, [class*="autocomplete" i] li';
  const marks = new Map();

  const FIELD_DEFINITIONS = Object.freeze([
    { key: 'nickname', labels: ['昵称', 'nickname', 'nick'] },
    { key: 'team', labels: ['队伍', '战队', 'team'] },
    { key: 'country', labels: ['国家或地区', '国家', '地区', 'nationality', 'country', 'region'] },
    { key: 'age', labels: ['年龄', 'age'] },
    { key: 'role', labels: ['位置', '角色', 'role', 'position'] },
    { key: 'majorWins', labels: ['major 冠军数', 'major冠军', 'major titles', 'major championships', 'major wins'] },
    { key: 'majorApps', labels: ['major 次数', 'major次数', 'major appearances', 'major appearance'] },
    { key: 'status', labels: ['状态', 'status'] },
  ]);

  const FIELD_NAMES = FIELD_DEFINITIONS.map(field => field.key);

  function isElement(value) {
    return typeof Element !== 'undefined' && value instanceof Element;
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeKey(value) {
    return normalizeText(value).toLocaleLowerCase();
  }

  function compact(value, limit = 440) {
    const text = normalizeText(value);
    return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
  }

  function redact(value) {
    return String(value || '')
      .replace(/(bearer\s+)[a-z0-9._~+/=-]+/ig, '$1[REDACTED]')
      .replace(/([?&](?:token|secret|password|passcode|session|authorization|api[_-]?key)=)[^&#\s"'<]+/ig, '$1[REDACTED]')
      .replace(/(eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})/ig, '[REDACTED_JWT]');
  }

  function isVisible(element) {
    if (!isElement(element)) return false;
    if (element.closest(EXCLUDED_SELECTOR)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
  }

  function isSensitiveElement(element) {
    if (!isElement(element)) return true;
    if (element.closest(EXCLUDED_SELECTOR)) return true;
    const attributes = Array.from(element.attributes || []);
    return attributes.some(attribute => SENSITIVE_NAME.test(attribute.name));
  }

  function classWords(element) {
    return isElement(element) && typeof element.className === 'string'
      ? element.className.split(/\s+/).filter(Boolean).map(normalizeKey)
      : [];
  }

  function pathFor(element, depth = 6) {
    if (!isElement(element)) return '';
    const parts = [];
    let node = element;
    while (isElement(node) && parts.length < depth) {
      const id = node.id && !SENSITIVE_NAME.test(node.id) ? `#${node.id.slice(0, 48)}` : '';
      const classes = classWords(node).filter(name => !SENSITIVE_NAME.test(name)).slice(0, 2).map(name => `.${name}`).join('');
      parts.unshift(`${node.tagName.toLowerCase()}${id || classes}`);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function safeAttributes(element) {
    if (!isElement(element)) return { data: {}, aria: {}, attributes: {} };
    const data = {};
    const aria = {};
    const attributes = {};
    for (const attribute of Array.from(element.attributes || [])) {
      const name = attribute.name.toLowerCase();
      if (SENSITIVE_NAME.test(name)) continue;
      if (!(name === 'id' || name === 'class' || name === 'role' || name.startsWith('data-') || name.startsWith('aria-'))) continue;
      const value = compact(redact(attribute.value), 180);
      if (name.startsWith('data-')) data[name] = value;
      else if (name.startsWith('aria-')) aria[name] = value;
      else attributes[name] = value;
    }
    return { data, aria, attributes };
  }

  function safeOuterHTML(element, limit = 2800) {
    if (!isElement(element)) return '';
    const clone = element.cloneNode(true);
    clone.querySelectorAll?.('script,style,iframe,video,audio,canvas,[type="password"],input,.chat,.message,[data-chat]').forEach(node => node.remove());
    const nodes = [clone, ...Array.from(clone.querySelectorAll?.('*') || [])];
    nodes.forEach((node, index) => {
      if (index > 180) {
        node.remove();
        return;
      }
      Array.from(node.attributes || []).forEach(attribute => {
        const name = attribute.name.toLowerCase();
        if (SENSITIVE_NAME.test(name) || name === 'value' || name === 'srcdoc') node.removeAttribute(attribute.name);
      });
      if (node.matches?.('input,textarea,select')) node.removeAttribute('value');
    });
    return compact(redact(clone.outerHTML), limit);
  }

  function elementDescriptor(element, extra = {}) {
    if (!isElement(element)) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      path: pathFor(element),
      tag: element.tagName.toLowerCase(),
      id: !SENSITIVE_NAME.test(element.id || '') ? element.id || '' : '',
      className: typeof element.className === 'string' ? compact(element.className, 280) : '',
      visibleText: compact(redact(element.innerText || element.textContent || ''), 520),
      attributes: safeAttributes(element),
      outerHTML: safeOuterHTML(element),
      computedStyle: {
        backgroundColor: style.backgroundColor,
        color: style.color,
        borderColor: style.borderColor,
        display: style.display,
      },
      rect: {
        x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
      },
      childElementCount: element.children.length,
      ...extra,
    };
  }

  function textFor(element, limit = 1200) {
    return compact(redact(element?.innerText || element?.textContent || ''), limit);
  }

  function fieldForHeader(value) {
    const normalized = normalizeKey(value);
    if (!normalized) return null;
    if (normalized.includes('major')) {
      if (/(冠军|championship|title|win)/.test(normalized)) return 'majorWins';
      if (/(次数|appearance|attend|参加)/.test(normalized)) return 'majorApps';
    }
    for (const field of FIELD_DEFINITIONS) {
      if (field.labels.some(label => normalized.includes(normalizeKey(label)))) return field.key;
    }
    return null;
  }

  function headersFor(element) {
    if (!isElement(element)) return [];
    const headerNodes = Array.from(element.querySelectorAll('thead th, th, [role="columnheader"]')).filter(isVisible);
    const keys = headerNodes.map(node => fieldForHeader(textFor(node, 120))).filter(Boolean);
    return [...new Set(keys)];
  }

  function cellElements(row) {
    if (!isElement(row)) return [];
    const direct = Array.from(row.children).filter(isVisible);
    const semantic = direct.filter(cell => cell.matches('td,th,[role="gridcell"],[role="cell"]'));
    if (semantic.length) return semantic;
    return direct.filter(cell => normalizeText(cell.innerText) || cell.querySelector('svg,img'));
  }

  function rowElements(board) {
    if (!isElement(board)) return [];
    const candidates = new Set();
    board.querySelectorAll('tbody > tr, tr, [role="row"]').forEach(row => candidates.add(row));
    Array.from(board.children).forEach(row => {
      if (cellElements(row).length >= 7) candidates.add(row);
    });
    return Array.from(candidates).filter(row => isVisible(row) && !isSensitiveElement(row));
  }

  function feedbackRows(board) {
    return rowElements(board).filter(row => {
      if (row.closest('thead')) return false;
      const cells = cellElements(row);
      // Header rows can also contain eight cells. A feedback row must not be
      // composed solely of column headers, whether it is a table or a grid.
      const headerOnly = cells.length > 0 && cells.every(cell => cell.matches('th,[role="columnheader"]'));
      return cells.length === FIELD_NAMES.length && !headerOnly;
    });
  }

  function boardStructuresWithin(element) {
    if (!isElement(element)) return [];
    const structures = Array.from(element.querySelectorAll(BOARD_SELECTOR));
    if (element.matches(BOARD_SELECTOR)) structures.unshift(element);
    return [...new Set(structures)];
  }

  function directBoardLabel(element) {
    if (!isElement(element)) return '';
    const label = Array.from(element.children).find(child => child.matches('h1,h2,h3,h4,[data-board-title],[class*="board-title" i]'));
    return normalizeKey(textFor(label, 240));
  }

  function ownershipForBoard(element) {
    if (!isElement(element)) return { ownership: 'unknown', label: '', container: null };
    const explicitSelf = element.closest('.player-board-self,[data-board-owner="self"],[data-player-board="self"]');
    if (explicitSelf) return { ownership: 'self', label: directBoardLabel(explicitSelf), container: explicitSelf };
    const explicitOpponent = element.closest('.player-board-opponent,[data-board-owner="opponent"],[data-player-board="opponent"]');
    if (explicitOpponent) return { ownership: 'opponent', label: directBoardLabel(explicitOpponent), container: explicitOpponent };
    if (element.querySelector('.masked-cell,[data-masked="true"]')) {
      return { ownership: 'opponent', label: '', container: element };
    }

    let node = element;
    for (let level = 0; isElement(node) && level < 5; level += 1, node = node.parentElement) {
      // Never let a page/boards wrapper containing both players lend its
      // “我的猜测” heading to every nested candidate.
      if (boardStructuresWithin(node).length > 1) break;
      const label = directBoardLabel(node);
      if (!label) continue;
      if (SELF_MARKERS.some(marker => label.includes(marker))) return { ownership: 'self', label, container: node };
      if (OPPONENT_MARKERS.some(marker => label.includes(marker)) || /(?:^|\s)(?:访客|游客|guest|visitor)[#：:\s]/i.test(label)) {
        return { ownership: 'opponent', label, container: node };
      }
    }
    return { ownership: 'unknown', label: '', container: null };
  }

  function evidenceForBoard(element) {
    if (!isElement(element) || !isVisible(element) || isSensitiveElement(element)) return null;
    if (!element.matches(BOARD_SELECTOR) && boardStructuresWithin(element).length > 1) return null;
    const words = classWords(element);
    const headerKeys = headersFor(element);
    const rows = feedbackRows(element);
    const ownershipEvidence = ownershipForBoard(element);
    const reasons = [];
    let score = 0;
    if (element.matches('table')) { score += 2; reasons.push('table'); }
    if (words.includes('game-table')) { score += 10; reasons.push('real-class:game-table'); }
    if (words.some(word => word.includes('guess-board') || word.includes('single-game-board'))) { score += 5; reasons.push('board-class'); }
    if (element.matches('[role="grid"]')) { score += 4; reasons.push('role:grid'); }
    if (headerKeys.length >= 5) { score += headerKeys.length * 2; reasons.push(`headers:${headerKeys.join(',')}`); }
    if (rows.length) { score += 6; reasons.push(`eight-cell-rows:${rows.length}`); }
    const selfEvidence = ownershipEvidence.ownership === 'self';
    if (selfEvidence) { score += 12; reasons.push('self-label'); }
    if (ownershipEvidence.ownership === 'opponent') { score -= 12; reasons.push('opponent-board'); }
    if (element.querySelector('.masked-cell,[data-masked="true"]')) { score -= 8; reasons.push('masked-feedback'); }
    if (element.querySelector(INPUT_SELECTOR)) { score += 1; reasons.push('near-input'); }
    const likelyBoard = words.includes('game-table') || headerKeys.length >= 5 || (rows.length > 0 && score >= 8);
    if (!likelyBoard) return null;
    return {
      element,
      score,
      reasons,
      headers: headerKeys,
      rowCount: rows.length,
      selfEvidence,
      ownership: ownershipEvidence.ownership,
      ownerLabel: ownershipEvidence.label,
    };
  }

  function boardCandidates(documentRef = document) {
    const seeds = new Set();
    documentRef.querySelectorAll(BOARD_SELECTOR).forEach(node => seeds.add(node));
    documentRef.querySelectorAll('table').forEach(node => {
      if (seeds.size > 900) return;
      if (!isVisible(node) || node.closest(EXCLUDED_SELECTOR)) return;
      if (headersFor(node).length >= 5) seeds.add(node);
    });
    const candidates = Array.from(seeds).map(evidenceForBoard).filter(Boolean);
    candidates.sort((left, right) => right.score - left.score || right.rowCount - left.rowCount);
    const deDuplicated = [];
    for (const candidate of candidates) {
      const duplicate = deDuplicated.some(existing => {
        if (existing.element === candidate.element) return true;
        // A table and its presentational wrapper both inherit the same headers
        // and rows. Treat them as one board, while preserving wrappers that
        // actually contain multiple independent tables.
        if (!candidate.element.contains(existing.element)) return false;
        const sameRows = candidate.rowCount === existing.rowCount;
        const sameHeaders = candidate.headers.length === existing.headers.length
          && candidate.headers.every(key => existing.headers.includes(key));
        const nestedTables = candidate.element.querySelectorAll('table').length;
        return sameRows && sameHeaders && nestedTables <= 1;
      });
      if (!duplicate) deDuplicated.push(candidate);
    }
    return deDuplicated.slice(0, 12);
  }

  function scoreInput(element) {
    const text = [element.getAttribute('placeholder'), element.getAttribute('aria-label'), element.name, element.id, element.className].map(normalizeKey).join(' ');
    let score = 0;
    if (/(昵称|选手|player|nick)/.test(text)) score += 8;
    if (element.closest('.input-bar,.player-search-content,[class*="search" i]')) score += 3;
    return score;
  }

  function inputCandidates(documentRef = document) {
    return Array.from(documentRef.querySelectorAll(INPUT_SELECTOR))
      .filter(element => isVisible(element) && !isSensitiveElement(element))
      .map(element => ({ element, score: scoreInput(element), descriptor: elementDescriptor(element) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 12);
  }

  function scoreButton(element) {
    const text = normalizeKey([textFor(element, 150), element.getAttribute('aria-label'), element.title, element.className].join(' '));
    let score = 0;
    if (/(提交猜测|submit guess|提交|guess)/.test(text)) score += 8;
    if (element.matches('[type="submit"]')) score += 3;
    if (element.closest('.input-bar')) score += 2;
    return score;
  }

  function buttonCandidates(documentRef = document) {
    return Array.from(documentRef.querySelectorAll('button,[role="button"],input[type="submit"]'))
      .filter(element => isVisible(element) && !isSensitiveElement(element))
      .map(element => ({ element, score: scoreButton(element), descriptor: elementDescriptor(element) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 16);
  }

  function dropdownCandidates(documentRef = document) {
    return Array.from(documentRef.querySelectorAll('[role="listbox"],[role="option"],.option,.opt,[class*="dropdown" i],[class*="autocomplete" i]'))
      .filter(element => isVisible(element) && !isSensitiveElement(element))
      .map(element => ({ element, descriptor: elementDescriptor(element) }))
      .slice(0, 16);
  }

  function scan(documentRef = document) {
    const boards = boardCandidates(documentRef);
    const ownBoards = boards.filter(candidate => candidate.selfEvidence);
    const autoBoard = ownBoards.length === 1 ? ownBoards[0] : null;
    const main = documentRef.querySelector('main') || documentRef.body;
    const mainText = normalizeKey(textFor(main, 2500));
    return {
      url: location.href,
      route: location.pathname,
      documentTitle: documentRef.title,
      boardCandidates: boards,
      autoBoard,
      ownBoardCount: ownBoards.length,
      inputCandidates: inputCandidates(documentRef),
      buttonCandidates: buttonCandidates(documentRef),
      dropdownCandidates: dropdownCandidates(documentRef),
      waiting: WAITING_MARKERS.some(marker => mainText.includes(marker)),
    };
  }

  function serializeScan(scanResult) {
    const serializeBoard = candidate => ({
      score: candidate.score,
      reasons: candidate.reasons,
      headers: candidate.headers,
      rowCount: candidate.rowCount,
      selfEvidence: candidate.selfEvidence,
      ownership: candidate.ownership,
      ownerLabel: candidate.ownerLabel,
      ...elementDescriptor(candidate.element),
    });
    return {
      url: scanResult.url,
      route: scanResult.route,
      documentTitle: scanResult.documentTitle,
      waiting: scanResult.waiting,
      ownBoardCount: scanResult.ownBoardCount,
      activeAutoBoard: scanResult.autoBoard ? elementDescriptor(scanResult.autoBoard.element) : null,
      candidateBoards: scanResult.boardCandidates.map(serializeBoard),
      candidateTables: Array.from(document.querySelectorAll('table')).filter(isVisible).filter(element => !isSensitiveElement(element)).slice(0, 16).map(elementDescriptor),
      candidateInputs: scanResult.inputCandidates.map(candidate => ({ score: candidate.score, ...candidate.descriptor })),
      candidateButtons: scanResult.buttonCandidates.map(candidate => ({ score: candidate.score, ...candidate.descriptor })),
      candidateDropdowns: scanResult.dropdownCandidates.map(candidate => candidate.descriptor),
    };
  }

  function clearMarks() {
    marks.forEach((previous, element) => {
      if (!isElement(element)) return;
      element.style.outline = previous.outline;
      element.style.outlineOffset = previous.outlineOffset;
      element.style.boxShadow = previous.boxShadow;
      element.removeAttribute('data-friberg-assistant-candidate');
    });
    marks.clear();
  }

  function markBoardCandidates(candidates, activeBoard = null) {
    clearMarks();
    candidates.forEach((candidate, index) => {
      const element = candidate.element || candidate;
      if (!isElement(element)) return;
      marks.set(element, { outline: element.style.outline, outlineOffset: element.style.outlineOffset, boxShadow: element.style.boxShadow });
      const active = element === activeBoard;
      element.style.outline = active ? '3px solid #46e0a0' : `3px solid ${index % 2 ? '#ffb64e' : '#71b8ff'}`;
      element.style.outlineOffset = '4px';
      element.style.boxShadow = active ? '0 0 0 6px rgb(70 224 160 / .18)' : '0 0 0 5px rgb(113 184 255 / .13)';
      element.setAttribute('data-friberg-assistant-candidate', active ? 'active' : 'candidate');
    });
  }

  function findBoardForTarget(target, scanResult) {
    if (!isElement(target)) return null;
    const candidates = scanResult?.boardCandidates || [];
    const found = candidates.filter(candidate => candidate.element === target || candidate.element.contains(target));
    if (found.length) return found.sort((left, right) => right.score - left.score)[0];
    let node = target;
    while (isElement(node)) {
      const candidate = evidenceForBoard(node);
      if (candidate) return candidate;
      node = node.parentElement;
    }
    return null;
  }

  function colorFromClass(cell) {
    if (!isElement(cell)) return null;
    const nodes = [cell, ...Array.from(cell.querySelectorAll(':scope > *')).slice(0, 5)];
    for (const node of nodes) {
      const tokens = [
        ...classWords(node),
        normalizeKey(node.getAttribute('data-feedback')),
        normalizeKey(node.getAttribute('data-state')),
        normalizeKey(node.getAttribute('aria-label')),
      ].filter(Boolean);
      if (tokens.some(token => token === 'correct' || token === 'green')) return 'correct';
      if (tokens.some(token => token === 'close' || token === 'yellow')) return 'close';
      if (tokens.some(token => token === 'wrong' || token === 'gray' || token === 'grey')) return 'wrong';
    }
    return null;
  }

  function directionFromCell(cell) {
    if (!isElement(cell)) return null;
    const nodes = [cell, ...Array.from(cell.querySelectorAll('.dir,svg,[class*="arrow" i],[data-direction],[data-lucide],[aria-label],[title]')).slice(0, 16)];
    for (const node of nodes) {
      const className = node.getAttribute?.('class') || (typeof node.className === 'string' ? node.className : '');
      const signal = normalizeKey([
        node.getAttribute?.('data-direction'),
        node.getAttribute?.('data-lucide'),
        node.getAttribute?.('aria-label'),
        node.getAttribute?.('title'),
        node.innerText,
        node.textContent,
        className,
      ].join(' '));
      if (signal.includes('↑') || /(?:^|[\s_-])(?:arrow[\s_-])?(?:up|increase|higher)(?:$|[\s_-])|向上/.test(signal)) return 'up';
      if (signal.includes('↓') || /(?:^|[\s_-])(?:arrow[\s_-])?(?:down|decrease|lower)(?:$|[\s_-])|向下/.test(signal)) return 'down';
    }
    return null;
  }

  function feedbackRowFingerprint(row) {
    if (!isElement(row)) return '';
    return cellElements(row).map(cell => [
      normalizeText(cell.innerText || cell.textContent),
      cell.getAttribute('class') || '',
      cell.getAttribute('data-feedback') || '',
      cell.getAttribute('data-state') || '',
      Array.from(cell.querySelectorAll('svg,[class*="arrow" i]'))
        .map(node => node.getAttribute('class') || node.getAttribute('data-lucide') || '')
        .join(','),
    ].join('~')).join('||');
  }

  function readFeedbackRow(row) {
    const cells = cellElements(row);
    if (cells.length !== FIELD_NAMES.length) return { valid: false, errors: [`反馈行应有 8 格，当前为 ${cells.length} 格。`] };
    const fields = {};
    const errors = [];
    const visibleValues = {};
    FIELD_NAMES.slice(1).forEach((field, index) => {
      const cell = cells[index + 1];
      const color = colorFromClass(cell);
      const visibleText = normalizeText(cell.innerText || cell.textContent);
      visibleValues[field] = ['age', 'majorWins', 'majorApps'].includes(field)
        ? (visibleText.match(/-?\d+(?:\.\d+)?/)?.[0] || '')
        : visibleText;
      if (!color) {
        errors.push(`${field} 缺少已知 correct/close/wrong 类。`);
        fields[field] = { color: null, direction: null };
        return;
      }
      const numeric = ['age', 'majorWins', 'majorApps'].includes(field);
      const direction = numeric ? directionFromCell(cell) : 'none';
      if (numeric && color !== 'correct' && !direction) errors.push(`${field} 缺少明确的 ↑/↓ 箭头。`);
      fields[field] = { color, direction: direction || 'none' };
    });
    return {
      valid: errors.length === 0,
      errors,
      row,
      nickname: normalizeText(cells[0].innerText),
      cells,
      visibleValues,
      reading: {
        team: fields.team?.color,
        country: fields.country?.color,
        age: fields.age,
        role: fields.role?.color,
        majorWins: fields.majorWins,
        majorAppearances: fields.majorApps,
        status: fields.status?.color,
        visibleValues,
      },
    };
  }

  function summarizeMutation(record) {
    const added = Array.from(record.addedNodes || []).filter(isElement).slice(0, 6).map(node => ({
      tag: node.tagName.toLowerCase(),
      className: typeof node.className === 'string' ? compact(node.className, 120) : '',
      text: compact(redact(node.innerText || node.textContent || ''), 180),
    }));
    return {
      at: new Date().toISOString(),
      type: record.type,
      target: pathFor(record.target),
      attributeName: record.attributeName && !SENSITIVE_NAME.test(record.attributeName) ? record.attributeName : undefined,
      added,
      removedCount: record.removedNodes?.length || 0,
    };
  }

  function appendMutations(buffer, records, limit = 40) {
    records.forEach(record => buffer.push(summarizeMutation(record)));
    if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
    return buffer;
  }

  function diagnostic({ scanResult, activeBoard, recentMutations = [], errors = [], extensionVersion = 'unknown', gamePoolSize = null, adapterState = {} } = {}) {
    const current = scanResult || scan(document);
    const serialized = serializeScan(current);
    return {
      url: location.href,
      timestamp: new Date().toISOString(),
      extensionVersion,
      gamePoolSize,
      documentTitle: document.title,
      route: location.pathname,
      ...serialized,
      activeBoard: activeBoard ? elementDescriptor(activeBoard) : null,
      recentMutations: recentMutations.slice(-40),
      adapterState,
      errors: errors.slice(-20).map(error => compact(redact(error), 560)),
      privacy: {
        cookies: 'not collected',
        storage: 'not collected',
        tokens: 'redacted from supported element text/attributes',
        chat: 'excluded',
      },
    };
  }

  function routeWatcher(onChange) {
    let current = location.href;
    const notify = () => {
      if (current === location.href) return;
      const previous = current;
      current = location.href;
      onChange?.({ previous, current, route: location.pathname });
    };
    const push = history.pushState;
    const replace = history.replaceState;
    history.pushState = function fribergPushState(...args) { const result = push.apply(this, args); queueMicrotask(notify); return result; };
    history.replaceState = function fribergReplaceState(...args) { const result = replace.apply(this, args); queueMicrotask(notify); return result; };
    addEventListener('popstate', notify);
    addEventListener('hashchange', notify);
    return () => {
      if (history.pushState.name === 'fribergPushState') history.pushState = push;
      if (history.replaceState.name === 'fribergReplaceState') history.replaceState = replace;
      removeEventListener('popstate', notify);
      removeEventListener('hashchange', notify);
    };
  }

  function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function exactNicknameIn(text, nickname) {
    const source = normalizeText(text);
    const wanted = normalizeText(nickname);
    if (!wanted) return false;
    if (normalizeKey(source) === normalizeKey(wanted)) return true;
    const boundary = new RegExp(`(^|[\\s·•,，;；:/()（）\\[\\]{}|])${escapeRegExp(wanted)}(?=$|[\\s·•,，;；:/()（）\\[\\]{}|])`, 'i');
    return boundary.test(source);
  }

  function playerIdentityScore(element, player) {
    const text = textFor(element, 800);
    const attributes = safeAttributes(element);
    const allAttributes = Object.values(attributes.data).concat(Object.values(attributes.aria), Object.values(attributes.attributes)).join(' ');
    const nickname = player?.nick || player?.nickname || '';
    const exactNickname = exactNicknameIn(text, nickname) || exactNicknameIn(allAttributes, nickname);
    const knownId = player?.id || player?.playerId || player?.player_id || '';
    const dataId = element.getAttribute('data-player-id') || element.getAttribute('data-playerid') || element.getAttribute('data-id') || '';
    const idMatches = Boolean(knownId && dataId && String(knownId) === String(dataId));
    const details = [player?.team, player?.country, player?.nationality, player?.region].filter(Boolean);
    const matches = details.filter(value => normalizeKey(text).includes(normalizeKey(value)) || normalizeKey(allAttributes).includes(normalizeKey(value)));
    return { exactNickname, idMatches, matchedDetails: matches.length, text, element };
  }

  function optionElements(documentRef = document) {
    return Array.from(documentRef.querySelectorAll(OPTION_SELECTOR))
      .filter(element => isVisible(element) && !isSensitiveElement(element))
      .filter(element => !element.closest('#friberg-assistant-overlay,#friberg-scriptcat-assistant'));
  }

  function uniqueOptionForPlayer({ player, players = [], documentRef = document } = {}) {
    const nickname = player?.nick || player?.nickname;
    if (!nickname) return { status: 'error', message: '缺少要填入的选手昵称。' };
    const sameNicknameCount = players.filter(candidate => normalizeKey(candidate.nick || candidate.nickname) === normalizeKey(nickname)).length;
    const entries = optionElements(documentRef).map(element => playerIdentityScore(element, player));
    const matching = entries.filter(entry => entry.exactNickname || entry.idMatches);
    const strict = sameNicknameCount > 1
      ? matching.filter(entry => entry.idMatches || entry.matchedDetails > 0)
      : matching;
    if (!strict.length) return { status: 'missing', message: `下拉列表未出现可唯一确认的 ${nickname}。` };
    const top = strict.filter(entry => entry.idMatches || entry.matchedDetails === Math.max(...strict.map(item => item.matchedDetails)));
    if (top.length !== 1) return { status: 'ambiguous', message: `${nickname} 有 ${top.length} 个相似下拉候选，未选择第一项。`, candidates: top.map(entry => elementDescriptor(entry.element)) };
    return { status: 'unique', element: top[0].element, descriptor: elementDescriptor(top[0].element), message: `已唯一确认 ${nickname}。` };
  }

  function setNativeInputValue(input, value) {
    if (!isElement(input)) throw new Error('没有可写入的搜索框。');
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) throw new Error('浏览器未提供原生 value setter。');
    setter.call(input, value);
    const inputEvent = typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })
      : new Event('input', { bubbles: true });
    input.dispatchEvent(inputEvent);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Unidentified' }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
  }

  function waitForUniqueOption({ player, players, documentRef, timeoutMs = 1600 } = {}) {
    return new Promise(resolve => {
      const immediate = uniqueOptionForPlayer({ player, players, documentRef });
      if (immediate.status === 'unique' || immediate.status === 'ambiguous') {
        resolve(immediate);
        return;
      }
      let observer = null;
      const finish = result => {
        observer?.disconnect();
        clearTimeout(timer);
        resolve(result);
      };
      observer = new MutationObserver(() => {
        const result = uniqueOptionForPlayer({ player, players, documentRef });
        if (result.status === 'unique' || result.status === 'ambiguous') finish(result);
      });
      observer.observe(documentRef.body, { childList: true, subtree: true });
      const timer = setTimeout(() => finish(uniqueOptionForPlayer({ player, players, documentRef })), timeoutMs);
    });
  }

  async function fillAndSelectUniqueOption({ input, player, players = [], documentRef = document, timeoutMs = 1600 } = {}) {
    const nickname = player?.nick || player?.nickname;
    if (!nickname) return { status: 'error', message: '没有可填入的推荐选手。' };
    setNativeInputValue(input, nickname);
    const option = await waitForUniqueOption({ player, players, documentRef, timeoutMs });
    if (option.status !== 'unique') {
      const exactLocalMatches = players.filter(candidate => normalizeKey(candidate.nick || candidate.nickname) === normalizeKey(nickname));
      const textOnlyAccepted = option.status === 'missing'
        && exactLocalMatches.length === 1
        && normalizeKey(input.value) === normalizeKey(nickname);
      if (textOnlyAccepted) {
        return {
          status: 'selected',
          selectionMode: 'validated-text',
          filled: nickname,
          selected: null,
          submitted: false,
          message: `原网页没有提供下拉列表；已按 646 人题库唯一昵称确认 ${nickname}。`,
        };
      }
      return { ...option, filled: nickname, submitted: false };
    }
    option.element.click();
    return {
      status: 'selected',
      selectionMode: 'dropdown',
      filled: nickname,
      selected: option.descriptor,
      submitted: false,
      message: `已填入并选择 ${nickname}；未点击最终提交。`,
    };
  }

  function uniqueSubmitButton({ scanResult = null, input = null, documentRef = document } = {}) {
    const candidates = (scanResult || scan(documentRef)).buttonCandidates
      .filter(candidate => candidate.score >= 8)
      .map(candidate => {
        const inputContainer = input?.closest('.input-bar,.player-search-content,[class*="search" i]') || null;
        const sameContainer = Boolean(input && (
          candidate.element.form && candidate.element.form === input.form
          || inputContainer && candidate.element.closest('.input-bar,.player-search-content,[class*="search" i]') === inputContainer
        ));
        return { ...candidate, submitScore: candidate.score + (sameContainer ? 4 : 0) };
      })
      .sort((left, right) => right.submitScore - left.submitScore);
    if (!candidates.length) return { status: 'missing', message: '未找到原网页的“提交猜测”按钮。' };
    const topScore = candidates[0].submitScore;
    const top = candidates.filter(candidate => candidate.submitScore === topScore);
    if (top.length !== 1) {
      return {
        status: 'ambiguous',
        message: `发现 ${top.length} 个同分提交按钮，未执行提交。`,
        candidates: top.map(candidate => candidate.descriptor),
      };
    }
    return { status: 'unique', element: top[0].element, descriptor: top[0].descriptor };
  }

  function submitSelectedGuess({ input, player, scanResult = null, documentRef = document } = {}) {
    const nickname = player?.nick || player?.nickname;
    if (!input || !nickname) return { status: 'error', submitted: false, message: '缺少已选择的选手或搜索框。' };
    if (normalizeKey(input.value) !== normalizeKey(nickname)) {
      return { status: 'mismatch', submitted: false, message: `搜索框内容已变化；当前不是已选择的 ${nickname}。` };
    }
    const submit = uniqueSubmitButton({ scanResult, input, documentRef });
    if (submit.status !== 'unique') return { ...submit, submitted: false };
    const button = submit.element;
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
      return { status: 'disabled', submitted: false, button: submit.descriptor, message: '原网页提交按钮尚未启用；请确认已选中下拉选手。' };
    }
    button.click();
    return {
      status: 'submitted',
      submitted: true,
      player: nickname,
      button: submit.descriptor,
      message: `已按你的点击提交 ${nickname}，正在等待反馈行。`,
    };
  }

  return Object.freeze({
    VERSION: '0.9.1',
    FIELD_NAMES,
    scan,
    serializeScan,
    elementDescriptor,
    boardCandidates,
    feedbackRows,
    feedbackRowFingerprint,
    readFeedbackRow,
    findBoardForTarget,
    markBoardCandidates,
    clearMarks,
    appendMutations,
    diagnostic,
    routeWatcher,
    uniqueOptionForPlayer,
    setNativeInputValue,
    fillAndSelectUniqueOption,
    uniqueSubmitButton,
    submitSelectedGuess,
    normalizeText,
  });
}));
