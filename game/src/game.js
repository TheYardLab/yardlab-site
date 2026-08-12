// =============================================================
// Y2K WORD SLAM · GAME RULES ENGINE
// =============================================================
// Pure-ish game logic: no sockets in here, so it can be unit tested.
// A "game" is a plain object; every function below takes it explicitly.

import {
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
  STARTING_SCORE,
  MAX_SCORELESS_TURNS,
  MAX_PLAYERS
} from './constants.js';
import { checkStandardDictionary } from './dictionary.js';

// -------------------------------------------------------------
// Setup
// -------------------------------------------------------------

function buildBag() {
  const bag = [];
  for (const [letter, count] of Object.entries(TILE_DISTRIBUTION)) {
    for (let i = 0; i < count; i += 1) bag.push(letter);
  }
  return shuffle(bag);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function createGame(roomId) {
  return {
    id: roomId,
    board: Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null)),
    bag: buildBag(),
    players: {},          // playerId -> player
    order: [],            // seating order of playerIds
    turnIndex: 0,
    customDictionary: {}, // { YEET: { uses: 0, addedBy, approvedBy } }
    pendingWord: null,    // move parked while the table votes on it
    pendingTrade: null,   // open trade offer
    moveCount: 0,
    scorelessTurns: 0,
    over: false,
    log: [],
    createdAt: Date.now()
  };
}

function addPlayer(game, playerId, name) {
  const existing = game.players[playerId];
  if (existing) {
    existing.connected = true;
    if (name) existing.name = name;
    return { ok: true, player: existing, rejoined: true };
  }
  if (game.order.length >= MAX_PLAYERS) {
    return { ok: false, error: 'This room is full. Bogus!' };
  }
  const player = {
    id: playerId,
    name: name || `Player ${game.order.length + 1}`,
    score: STARTING_SCORE,
    rack: drawTiles(game, RACK_SIZE),
    connected: true,
    seat: game.order.length
  };
  game.players[playerId] = player;
  game.order.push(playerId);
  return { ok: true, player, rejoined: false };
}

/** Pull `count` tiles out of the shared bag (fewer if the bag runs dry). */
function drawTiles(game, count) {
  const drawn = [];
  for (let i = 0; i < count && game.bag.length > 0; i += 1) {
    drawn.push(game.bag.pop());
  }
  return drawn;
}

function refillRack(game, player) {
  const needed = Math.max(0, RACK_SIZE - player.rack.length);
  if (needed > 0) player.rack.push(...drawTiles(game, needed));
}

// -------------------------------------------------------------
// Turn helpers
// -------------------------------------------------------------

function currentPlayerId(game) {
  return game.order[game.turnIndex] ?? null;
}

function isCurrentPlayer(game, playerId) {
  return currentPlayerId(game) === playerId;
}

function advanceTurn(game) {
  if (game.order.length === 0) return;
  game.turnIndex = (game.turnIndex + 1) % game.order.length;
}

function isBlocked(game) {
  if (game.pendingWord) return 'A word is up for a vote — hang tight!';
  if (game.pendingTrade) return 'A trade offer is on the table — resolve it first!';
  return null;
}

// -------------------------------------------------------------
// Placement validation
// -------------------------------------------------------------

function inBounds(row, col) {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

function cellAt(game, row, col) {
  return inBounds(row, col) ? game.board[row][col] : null;
}

/**
 * Normalise and sanity check raw placements from a client.
 * Returns { ok, placements } or { ok:false, error }.
 */
function normalisePlacements(game, player, raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'Place some tiles first, dude.' };
  }
  if (raw.length > MAX_RACK) {
    return { ok: false, error: 'That is way too many tiles.' };
  }

  const seen = new Set();
  const placements = [];
  const rackLeft = [...player.rack];

  for (const item of raw) {
    const row = Number(item?.row);
    const col = Number(item?.col);
    const letter = String(item?.letter ?? '').toUpperCase();
    const blank = Boolean(item?.blank);

    if (!Number.isInteger(row) || !Number.isInteger(col) || !inBounds(row, col)) {
      return { ok: false, error: 'A tile landed off the board.' };
    }
    if (!/^[A-Z]$/.test(letter)) {
      return { ok: false, error: 'Blank tiles need a letter picked for them.' };
    }
    const key = `${row},${col}`;
    if (seen.has(key)) return { ok: false, error: 'Two tiles cannot share a square.' };
    seen.add(key);
    if (game.board[row][col]) return { ok: false, error: 'That square is already taken.' };

    // Consume a matching tile from the rack (a blank consumes a '?').
    const wanted = blank ? BLANK : letter;
    const idx = rackLeft.indexOf(wanted);
    if (idx === -1) {
      return { ok: false, error: `You do not have a ${blank ? 'blank' : letter} on your rack.` };
    }
    rackLeft.splice(idx, 1);

    placements.push({ row, col, letter, blank, value: blank ? 0 : TILE_VALUES[letter] });
  }

  return { ok: true, placements, rackLeft };
}

/** Geometry rules: one line, contiguous, connected (or covering the star). */
function checkGeometry(game, placements) {
  const rows = new Set(placements.map((p) => p.row));
  const cols = new Set(placements.map((p) => p.col));
  const sameRow = rows.size === 1;
  const sameCol = cols.size === 1;

  if (!sameRow && !sameCol) {
    return { ok: false, error: 'Tiles must line up in one row or one column.' };
  }

  const isFirstMove = game.moveCount === 0;

  if (isFirstMove) {
    if (placements.length < 2) {
      return { ok: false, error: 'The opening word needs at least two tiles.' };
    }
    const coversCenter = placements.some((p) => p.row === CENTER.row && p.col === CENTER.col);
    if (!coversCenter) {
      return { ok: false, error: 'The first word has to cross the middle star.' };
    }
  }

  // Contiguity: no gaps between the outermost new tiles along the play line.
  const occupied = (row, col) =>
    Boolean(game.board[row][col]) || placements.some((p) => p.row === row && p.col === col);

  if (sameRow) {
    const row = placements[0].row;
    const colList = placements.map((p) => p.col);
    for (let c = Math.min(...colList); c <= Math.max(...colList); c += 1) {
      if (!occupied(row, c)) return { ok: false, error: 'No gaps allowed in your word.' };
    }
  } else {
    const col = placements[0].col;
    const rowList = placements.map((p) => p.row);
    for (let r = Math.min(...rowList); r <= Math.max(...rowList); r += 1) {
      if (!occupied(r, col)) return { ok: false, error: 'No gaps allowed in your word.' };
    }
  }

  if (!isFirstMove) {
    const touches = placements.some(({ row, col }) =>
      [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dr, dc]) => cellAt(game, row + dr, col + dc))
    );
    if (!touches) {
      return { ok: false, error: 'Your word has to touch something already on the board.' };
    }
  }

  return { ok: true };
}

/**
 * Every word formed by this play (main word + cross words), each as
 * { word, dir, cells:[{row,col,letter,value,isNew}] }.
 */
function collectWords(game, placements) {
  const newAt = new Map(placements.map((p) => [`${p.row},${p.col}`, p]));

  const read = (row, col) => {
    const fresh = newAt.get(`${row},${col}`);
    if (fresh) return { ...fresh, isNew: true };
    const placed = cellAt(game, row, col);
    if (!placed) return null;
    return { row, col, letter: placed.letter, value: placed.value, blank: placed.blank, isNew: false };
  };

  const words = new Map();

  for (const p of placements) {
    for (const [dr, dc, dir] of [[0, 1, 'H'], [1, 0, 'V']]) {
      // Walk back to the start of this run.
      let r = p.row;
      let c = p.col;
      while (read(r - dr, c - dc)) {
        r -= dr;
        c -= dc;
      }
      const key = `${dir}:${r},${c}`;
      if (words.has(key)) continue;

      const cells = [];
      while (read(r, c)) {
        cells.push(read(r, c));
        r += dr;
        c += dc;
      }
      if (cells.length >= 2) {
        words.set(key, { word: cells.map((cell) => cell.letter).join(''), dir, cells });
      }
    }
  }

  return [...words.values()];
}

function isCustomWord(game, word) {
  return Object.prototype.hasOwnProperty.call(game.customDictionary, word.toUpperCase());
}

function isKnownWord(game, word) {
  return checkStandardDictionary(word) || isCustomWord(game, word);
}

/**
 * Score one word.
 *
 * House rule: a word living only in the room's custom dictionary scores a flat
 * 1 point per letter the first time it is played — face values and premium
 * squares are ignored.  Every later outing scores normally.
 */
function scoreWord(game, wordEntry) {
  const upper = wordEntry.word.toUpperCase();
  const custom = game.customDictionary[upper];
  const firstUse = Boolean(custom) && custom.uses === 0;

  if (firstUse) {
    return { score: upper.length, firstUse: true, custom: true };
  }

  let sum = 0;
  let wordMultiplier = 1;

  for (const cell of wordEntry.cells) {
    const value = cell.blank ? 0 : (TILE_VALUES[cell.letter] ?? 0);
    if (cell.isNew) {
      const premium = PREMIUM_MULTIPLIER[PREMIUM[cell.row][cell.col]];
      sum += value * premium.letter;
      wordMultiplier *= premium.word;
    } else {
      sum += value;
    }
  }

  return { score: sum * wordMultiplier, firstUse: false, custom: Boolean(custom) };
}

/**
 * Full dry run of a move.  Returns either
 *   { ok:false, error }                    — illegal placement
 *   { ok:true, valid:false, unknownWords } — legal placement, unknown word(s)
 *   { ok:true, valid:true, total, breakdown, words }
 */
function evaluateMove(game, player, rawPlacements) {
  const normalised = normalisePlacements(game, player, rawPlacements);
  if (!normalised.ok) return normalised;

  const geometry = checkGeometry(game, normalised.placements);
  if (!geometry.ok) return geometry;

  const words = collectWords(game, normalised.placements);
  if (words.length === 0) {
    return { ok: false, error: 'That does not spell anything.' };
  }

  const unknownWords = [...new Set(
    words.map((w) => w.word.toUpperCase()).filter((w) => !isKnownWord(game, w))
  )];

  if (unknownWords.length > 0) {
    return { ok: true, valid: false, unknownWords, words, placements: normalised.placements };
  }

  const breakdown = words.map((w) => ({ word: w.word, ...scoreWord(game, w) }));
  let total = breakdown.reduce((acc, entry) => acc + entry.score, 0);
  const bingo = normalised.placements.length >= RACK_SIZE;
  if (bingo) total += BINGO_BONUS;

  return {
    ok: true,
    valid: true,
    total,
    bingo,
    breakdown,
    words,
    placements: normalised.placements
  };
}

/**
 * Commit a move that has already been evaluated as playable.
 * Returns { ok, total, breakdown, bingo, words } or { ok:false, error }.
 */
function applyMove(game, player, rawPlacements) {
  const result = evaluateMove(game, player, rawPlacements);
  if (!result.ok) return result;
  if (!result.valid) return { ok: false, error: 'Unknown word — that needs a vote.' };

  // Burn the tiles off the rack.
  for (const p of result.placements) {
    const wanted = p.blank ? BLANK : p.letter;
    const idx = player.rack.indexOf(wanted);
    if (idx !== -1) player.rack.splice(idx, 1);
  }

  // Lay them on the board.
  for (const p of result.placements) {
    game.board[p.row][p.col] = {
      letter: p.letter,
      value: p.blank ? 0 : TILE_VALUES[p.letter],
      blank: p.blank,
      playerId: player.id,
      fresh: true
    };
  }

  // Only the tiles from this move keep the "just played" highlight.
  const justPlayed = new Set(result.placements.map((p) => `${p.row},${p.col}`));
  for (let r = 0; r < BOARD_SIZE; r += 1) {
    for (let c = 0; c < BOARD_SIZE; c += 1) {
      const cell = game.board[r][c];
      if (cell && cell.fresh && !justPlayed.has(`${r},${c}`)) cell.fresh = false;
    }
  }

  // Custom words age one use each time they hit the board.
  for (const entry of result.words) {
    const upper = entry.word.toUpperCase();
    if (game.customDictionary[upper]) game.customDictionary[upper].uses += 1;
  }

  player.score += result.total;
  game.moveCount += 1;
  game.scorelessTurns = result.total > 0 ? 0 : game.scorelessTurns + 1;

  refillRack(game, player);

  const wentOut = player.rack.length === 0 && game.bag.length === 0;
  if (wentOut) {
    finishGame(game, player.id);
  } else {
    advanceTurn(game);
  }

  return { ...result, wentOut };
}

// -------------------------------------------------------------
// Non-scoring turns
// -------------------------------------------------------------

function passTurn(game) {
  game.scorelessTurns += 1;
  if (game.scorelessTurns >= MAX_SCORELESS_TURNS) {
    finishGame(game, null);
    return { ok: true, ended: true };
  }
  advanceTurn(game);
  return { ok: true, ended: false };
}

function swapTiles(game, player, letters) {
  if (!Array.isArray(letters) || letters.length === 0) {
    return { ok: false, error: 'Pick some tiles to dump.' };
  }
  if (game.bag.length < letters.length) {
    return { ok: false, error: 'Not enough tiles left in the bag to swap.' };
  }
  const rackLeft = [...player.rack];
  for (const letter of letters) {
    const idx = rackLeft.indexOf(String(letter).toUpperCase());
    if (idx === -1) return { ok: false, error: 'You do not have those tiles.' };
    rackLeft.splice(idx, 1);
  }
  const returned = letters.map((l) => String(l).toUpperCase());
  player.rack = rackLeft;
  refillRack(game, player);
  game.bag.push(...returned);
  shuffle(game.bag);

  const ended = passTurn(game).ended;
  return { ok: true, ended, count: returned.length };
}

/** Final scoring: unplayed racks are deducted, and go-out gets the leftovers. */
function finishGame(game, wentOutPlayerId) {
  if (game.over) return;
  game.over = true;
  let pot = 0;
  for (const id of game.order) {
    const player = game.players[id];
    if (id === wentOutPlayerId) continue;
    const rackValue = player.rack.reduce((acc, letter) => acc + (TILE_VALUES[letter] ?? 0), 0);
    player.score -= rackValue;
    pot += rackValue;
  }
  if (wentOutPlayerId && game.players[wentOutPlayerId]) {
    game.players[wentOutPlayerId].score += pot;
  }
}

// -------------------------------------------------------------
// Trading economy
// -------------------------------------------------------------

function openTrade(game, fromId, letter, points) {
  const from = game.players[fromId];
  if (!from) return { ok: false, error: 'You are not seated in this game.' };
  if (game.over) return { ok: false, error: 'Game over, man.' };
  if (game.pendingTrade) return { ok: false, error: 'There is already an offer on the table.' };
  if (game.pendingWord) return { ok: false, error: 'Finish the word vote first.' };
  if (game.order.length < 2) return { ok: false, error: 'Nobody here to trade with yet.' };
  if (from.score < points) return { ok: false, error: 'You cannot afford that bounty.' };
  if (from.rack.length >= MAX_RACK) return { ok: false, error: 'Your rack is stuffed. Play something!' };

  game.pendingTrade = { from: fromId, letter, points, createdAt: Date.now() };
  return { ok: true, trade: game.pendingTrade };
}

function acceptTrade(game, accepterId) {
  const trade = game.pendingTrade;
  if (!trade) return { ok: false, error: 'That offer already expired.' };
  if (trade.from === accepterId) return { ok: false, error: 'You cannot accept your own offer.' };

  const requester = game.players[trade.from];
  const accepter = game.players[accepterId];
  if (!requester || !accepter) return { ok: false, error: 'That player left the building.' };

  const idx = accepter.rack.indexOf(trade.letter);
  if (idx === -1) {
    game.pendingTrade = null;
    return { ok: false, error: `You do not actually have a ${trade.letter}.`, missing: true };
  }
  if (requester.score < trade.points) {
    game.pendingTrade = null;
    return { ok: false, error: 'They can no longer afford it. Deal is off.' };
  }

  accepter.rack.splice(idx, 1);
  requester.rack.push(trade.letter);
  requester.score -= trade.points;
  accepter.score += trade.points;
  refillRack(game, accepter);

  game.pendingTrade = null;
  return { ok: true, requester, accepter, letter: trade.letter, points: trade.points };
}

function rejectTrade(game) {
  const trade = game.pendingTrade;
  game.pendingTrade = null;
  return trade;
}

// -------------------------------------------------------------
// Democratic dictionary
// -------------------------------------------------------------

function approveWords(game, words, addedBy, approvedBy) {
  for (const word of words) {
    const upper = String(word).toUpperCase();
    if (!game.customDictionary[upper]) {
      game.customDictionary[upper] = { uses: 0, addedBy, approvedBy };
    }
  }
}

// -------------------------------------------------------------
// Serialisation
// -------------------------------------------------------------

/** Public view of the game for one player — other racks stay hidden. */
function viewFor(game, playerId) {
  return {
    roomId: game.id,
    board: game.board,
    you: playerId,
    yourRack: game.players[playerId] ? [...game.players[playerId].rack] : [],
    players: game.order.map((id) => {
      const p = game.players[id];
      return {
        id: p.id,
        name: p.name,
        score: p.score,
        tiles: p.rack.length,
        connected: p.connected,
        seat: p.seat
      };
    }),
    turn: currentPlayerId(game),
    bagCount: game.bag.length,
    customDictionary: game.customDictionary,
    pendingWord: game.pendingWord
      ? { word: game.pendingWord.unknownWords.join(', '), from: game.pendingWord.playerId }
      : null,
    pendingTrade: game.pendingTrade,
    moveCount: game.moveCount,
    over: game.over,
    log: game.log.slice(-40)
  };
}

function pushLog(game, text, kind = 'info') {
  game.log.push({ text, kind, at: Date.now() });
  if (game.log.length > 200) game.log.shift();
}

export {
  createGame,
  addPlayer,
  drawTiles,
  refillRack,
  currentPlayerId,
  isCurrentPlayer,
  advanceTurn,
  isBlocked,
  evaluateMove,
  applyMove,
  passTurn,
  swapTiles,
  finishGame,
  openTrade,
  acceptTrade,
  rejectTrade,
  approveWords,
  isKnownWord,
  isCustomWord,
  scoreWord,
  collectWords,
  viewFor,
  pushLog,
  shuffle
};
