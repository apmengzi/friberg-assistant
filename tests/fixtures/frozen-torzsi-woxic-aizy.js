'use strict';

// Transcribed from the supplied four-row game screenshot.  The answer was
// intentionally not assumed; the expected set is the legal set produced by
// the public 646-player game pool after all four rows are intersected.
module.exports = {
  name: 'user-supplied frozen → torzsi → woxic → aizy sequence',
  guesses: [
    { nickname: 'frozen', cells: ['wrong', 'wrong', 'close', 'wrong', 'correct', 'wrong', 'correct'], directions: { age: 'down', majorWins: 'none', majorApps: 'down' } },
    { nickname: 'torzsi', cells: ['wrong', 'wrong', 'close', 'correct', 'correct', 'wrong', 'correct'], directions: { age: 'down', majorWins: 'none', majorApps: 'down' } },
    { nickname: 'woxic', cells: ['wrong', 'close', 'wrong', 'correct', 'correct', 'wrong', 'correct'], directions: { age: 'down', majorWins: 'none', majorApps: 'down' } },
    { nickname: 'aizy', cells: ['wrong', 'wrong', 'wrong', 'wrong', 'correct', 'wrong', 'correct'], directions: { age: 'down', majorWins: 'none', majorApps: 'down' } },
  ],
  expectedCandidates: ['jee', 'tiger', 'z4kr'],
};
