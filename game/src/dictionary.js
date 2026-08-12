// =============================================================
// STANDARD DICTIONARY
// =============================================================
// Baseline word list.  `word-list` ships a large English word list on disk;
// we filter it down to Scrabble-legal shapes (2-15 letters, a-z only).
// If the package is missing we fall back to a tiny built-in list so the
// server still boots — the Democratic Dictionary can cover the rest.

import fs from 'node:fs';

const FALLBACK_WORDS = `
a an and are as at be been but by can did do does for from get go had has have
he her him his how i if in is it its me my no not of on or our out say she so
that the their them then there these they this to too up us was we were what
when where which who why will with you your cat dog word game play tile board
score turn rack bag pass swap trade vote yes hi ok
`.trim().split(/\s+/);

const WORD_SHAPE = /^[a-z]{2,15}$/;

// `word-list` default-exports the absolute path to its words.txt.  Its
// `exports` map hides the file itself, so it has to come through the module.
let wordsPath = null;
try {
  ({ default: wordsPath } = await import('word-list'));
} catch {
  wordsPath = null;
}

function loadWords() {
  try {
    if (!wordsPath) throw new Error('word-list is not installed');
    const raw = fs.readFileSync(wordsPath, 'utf8');
    const words = new Set();
    for (const line of raw.split('\n')) {
      const word = line.trim();
      if (WORD_SHAPE.test(word)) words.add(word.toUpperCase());
    }
    if (words.size < 1000) throw new Error(`word list looks truncated (${words.size} words)`);
    return words;
  } catch (error) {
    console.warn(`[dictionary] falling back to the built-in stub list: ${error.message}`);
    return new Set(FALLBACK_WORDS.filter((w) => WORD_SHAPE.test(w)).map((w) => w.toUpperCase()));
  }
}

let cache = null;

function getDictionary() {
  if (!cache) cache = loadWords();
  return cache;
}

/** True when `word` is in the baseline (non-house-rule) dictionary. */
function checkStandardDictionary(word) {
  if (typeof word !== 'string') return false;
  return getDictionary().has(word.toUpperCase());
}

function dictionarySize() {
  return getDictionary().size;
}

export { checkStandardDictionary, dictionarySize };
