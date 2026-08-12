// =============================================================
// Y2K WORD SLAM · SHARED GAME CONSTANTS
// =============================================================

const BOARD_SIZE = 15;
const RACK_SIZE = 7;
// Trading can push a rack above RACK_SIZE; this is the hard ceiling.
const MAX_RACK = 10;
const BINGO_BONUS = 50;
const CENTER = { row: 7, col: 7 };

const BLANK = '?';

const TILE_VALUES = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8, K: 5, L: 1, M: 3,
  N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1, U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
  [BLANK]: 0
};

// Standard English Scrabble distribution — 100 tiles.
const TILE_DISTRIBUTION = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4, M: 2,
  N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1, Y: 2, Z: 1,
  [BLANK]: 2
};

// Premium squares.  T = triple word, D = double word, t = triple letter,
// d = double letter, . = plain.  Rows 8-14 mirror rows 6-0.
const PREMIUM_ROWS = [
  'T..d...T...d..T',
  '.D...t...t...D.',
  '..D...d.d...D..',
  'd..D...d...D..d',
  '....D.....D....',
  '.t...t...t...t.',
  '..d...d.d...d..',
  'T..d...D...d..T',
  '..d...d.d...d..',
  '.t...t...t...t.',
  '....D.....D....',
  'd..D...d...D..d',
  '..D...d.d...D..',
  '.D...t...t...D.',
  'T..d...T...d..T'
];

const PREMIUM = PREMIUM_ROWS.map((row) => row.split(''));

const PREMIUM_MULTIPLIER = {
  T: { letter: 1, word: 3 },
  D: { letter: 1, word: 2 },
  t: { letter: 3, word: 1 },
  d: { letter: 2, word: 1 },
  '.': { letter: 1, word: 1 }
};

// Economy
const MIN_TRADE_POINTS = 1;
const MAX_TRADE_POINTS = 25;
const DEFAULT_TRADE_POINTS = 5;
const STARTING_SCORE = 50;

// Six consecutive scoreless turns (passes / swaps) ends the game.
const MAX_SCORELESS_TURNS = 6;

const MAX_PLAYERS = 4;

export {
  BOARD_SIZE,
  RACK_SIZE,
  MAX_RACK,
  BINGO_BONUS,
  CENTER,
  BLANK,
  TILE_VALUES,
  TILE_DISTRIBUTION,
  PREMIUM,
  PREMIUM_MULTIPLIER,
  MIN_TRADE_POINTS,
  MAX_TRADE_POINTS,
  DEFAULT_TRADE_POINTS,
  STARTING_SCORE,
  MAX_SCORELESS_TURNS,
  MAX_PLAYERS
};
