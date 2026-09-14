(function bootstrapFribergFeedbackParserPatch(root, factory) {
  const patch = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = patch;
  if (root?.FribergLiveDomAdapter) {
    root.FribergLiveDomAdapter = patch.install(root.FribergLiveDomAdapter);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createFribergFeedbackParserPatch() {
  'use strict';

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function extractNickname(rawNickname, trailingCellTexts = []) {
    const raw = normalizeText(rawNickname);
    if (!raw) return '';

    const suffix = trailingCellTexts.map(normalizeText).filter(Boolean).join(' ');
    if (suffix && raw.endsWith(suffix)) {
      const candidate = normalizeText(raw.slice(0, raw.length - suffix.length));
      if (candidate) return candidate;
    }

    const firstLine = String(rawNickname || '')
      .split(/\r?\n/)
      .map(normalizeText)
      .find(Boolean);
    if (firstLine && firstLine.length < raw.length) return firstLine;

    return raw;
  }

  function install(baseAdapter) {
    if (!baseAdapter || typeof baseAdapter.readFeedbackRow !== 'function') return baseAdapter;
    if (baseAdapter.FEEDBACK_PARSER_PATCH_VERSION) return baseAdapter;

    const originalReadFeedbackRow = baseAdapter.readFeedbackRow.bind(baseAdapter);
    const patchedReadFeedbackRow = row => {
      const parsed = originalReadFeedbackRow(row);
      if (!parsed) return parsed;

      const trailingCellTexts = Array.from(parsed.cells || [])
        .slice(1)
        .map(cell => cell?.innerText || cell?.textContent || '');
      const nickname = extractNickname(parsed.nickname, trailingCellTexts);
      const errors = Array.from(parsed.errors || []);
      if (!nickname) errors.push('nickname 缺少可识别昵称。');

      return {
        ...parsed,
        nickname,
        errors,
        valid: Boolean(parsed.valid && nickname),
      };
    };

    return Object.freeze({
      ...baseAdapter,
      FEEDBACK_PARSER_PATCH_VERSION: '1.0.0',
      readFeedbackRow: patchedReadFeedbackRow,
    });
  }

  return Object.freeze({ extractNickname, install });
}));
