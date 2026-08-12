import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame,
  addPlayer,
  evaluateMove,
  applyMove,
  approveWords,
  openTrade,
  acceptTrade,
  passTurn
} from '../src/game.js';
import { STARTING_SCORE } from '../src/constants.js';

function tableFor(racks) {
  const game = createGame('TEST');
  const ids = [];
  racks.forEach((rack, i) => {
    const id = `p${i + 1}`;
    addPlayer(game, id, `Player ${i + 1}`);
    game.players[id].rack = [...rack];
    ids.push(id);
  });
  return { game, ids };
}

const at = (row, col, letter, blank = false) => ({ row, col, letter, blank });

test('opening move must cover the centre star', () => {
  const { game, ids } = tableFor([['C', 'A', 'T'], ['D', 'O', 'G']]);
  const bad = evaluateMove(game, game.players[ids[0]], [at(0, 0, 'C'), at(0, 1, 'A'), at(0, 2, 'T')]);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /middle star/);
});

test('opening move needs at least two tiles', () => {
  const { game, ids } = tableFor([['C', 'A', 'T'], ['D', 'O', 'G']]);
  const bad = evaluateMove(game, game.players[ids[0]], [at(7, 7, 'C')]);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /two tiles/);
});

test('centre square doubles the opening word', () => {
  const { game, ids } = tableFor([['C', 'A', 'T'], ['D', 'O', 'G']]);
  const move = applyMove(game, game.players[ids[0]], [at(7, 7, 'C'), at(7, 8, 'A'), at(7, 9, 'T')]);
  assert.equal(move.ok, true);
  // (C3 + A1 + T1) x2 for the centre double-word square.
  assert.equal(move.total, 10);
  assert.equal(game.players[ids[0]].score, STARTING_SCORE + 10);
  assert.equal(game.board[7][7].letter, 'C');
});

test('a play must connect to tiles already on the board', () => {
  const { game, ids } = tableFor([['C', 'A', 'T'], ['D', 'O', 'G']]);
  applyMove(game, game.players[ids[0]], [at(7, 7, 'C'), at(7, 8, 'A'), at(7, 9, 'T')]);
  const bad = evaluateMove(game, game.players[ids[1]], [at(0, 0, 'D'), at(0, 1, 'O'), at(0, 2, 'G')]);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /touch something/);
});

test('gaps in a play are rejected', () => {
  const { game, ids } = tableFor([['C', 'A', 'T'], ['D', 'O', 'G']]);
  const bad = evaluateMove(game, game.players[ids[0]], [at(7, 6, 'C'), at(7, 7, 'A'), at(7, 9, 'T')]);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /No gaps/);
});

test('you cannot play tiles you do not hold', () => {
  const { game, ids } = tableFor([['C', 'A', 'T'], ['D', 'O', 'G']]);
  const bad = evaluateMove(game, game.players[ids[0]], [at(7, 7, 'Z'), at(7, 8, 'A')]);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /do not have/);
});

test('cross words are scored too', () => {
  const { game, ids } = tableFor([['C', 'A', 'T'], ['A', 'T']]);
  applyMove(game, game.players[ids[0]], [at(7, 7, 'C'), at(7, 8, 'A'), at(7, 9, 'T')]);
  // AT played downward off the existing A at (7,8) also forms nothing else.
  const move = applyMove(game, game.players[ids[1]], [at(8, 8, 'T')]);
  assert.equal(move.ok, true);
  const words = move.breakdown.map((b) => b.word).sort();
  assert.deepEqual(words, ['AT']);
});

test('unknown words come back for a vote instead of scoring', () => {
  const { game, ids } = tableFor([['Y', 'E', 'E', 'T'], ['D', 'O', 'G']]);
  const result = evaluateMove(game, game.players[ids[0]], [
    at(7, 7, 'Y'), at(7, 8, 'E'), at(7, 9, 'E'), at(7, 10, 'T')
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.valid, false);
  assert.deepEqual(result.unknownWords, ['YEET']);
});

test('an approved word scores one point per letter on its first outing', () => {
  const { game, ids } = tableFor([['Y', 'E', 'E', 'T'], ['D', 'O', 'G']]);
  const placements = [at(7, 7, 'Y'), at(7, 8, 'E'), at(7, 9, 'E'), at(7, 10, 'T')];
  approveWords(game, ['YEET'], ids[0], ids[1]);
  const move = applyMove(game, game.players[ids[0]], placements);
  assert.equal(move.ok, true);
  // Flat 4 — face values (Y4 E1 E1 T1 = 7, doubled by the centre = 14) are ignored.
  assert.equal(move.total, 4);
  assert.equal(game.customDictionary.YEET.uses, 1);
});

test('an approved word scores face value the second time', () => {
  const { game, ids } = tableFor([['Y', 'E', 'E', 'T'], ['Y', 'E', 'E', 'T']]);
  approveWords(game, ['YEET'], ids[0], ids[1]);
  applyMove(game, game.players[ids[0]], [at(7, 7, 'Y'), at(7, 8, 'E'), at(7, 9, 'E'), at(7, 10, 'T')]);

  // Same word again, hanging off the board vertically from the Y at (7,7).
  game.players[ids[1]].rack = ['E', 'E', 'T'];
  const move = applyMove(game, game.players[ids[1]], [at(8, 7, 'E'), at(9, 7, 'E'), at(10, 7, 'T')]);
  assert.equal(move.ok, true);
  assert.equal(game.customDictionary.YEET.uses, 2);
  // Y4 + E1 + E1 + T1 = 7, no premium squares hit at (8,7), (9,7) or (10,7).
  assert.equal(move.total, 7);
});

test('blanks are worth nothing but still spell', () => {
  const { game, ids } = tableFor([['C', '?', 'T'], ['D', 'O', 'G']]);
  const move = applyMove(game, game.players[ids[0]], [
    at(7, 7, 'C'), at(7, 8, 'A', true), at(7, 9, 'T')
  ]);
  assert.equal(move.ok, true);
  // (C3 + blank0 + T1) x2 = 8
  assert.equal(move.total, 8);
  assert.equal(game.board[7][8].blank, true);
  assert.equal(game.board[7][8].value, 0);
});

test('using all seven tiles pays the bingo bonus', () => {
  const { game, ids } = tableFor([['R', 'E', 'T', 'A', 'I', 'N', 'S'], ['D', 'O', 'G']]);
  const move = applyMove(game, game.players[ids[0]], [
    at(7, 7, 'R'), at(7, 8, 'E'), at(7, 9, 'T'), at(7, 10, 'A'),
    at(7, 11, 'I'), at(7, 12, 'N'), at(7, 13, 'S')
  ]);
  assert.equal(move.ok, true);
  assert.equal(move.bingo, true);
  assert.ok(move.total > 50);
});

test('the turn passes to the next player after a move', () => {
  const { game, ids } = tableFor([['C', 'A', 'T'], ['D', 'O', 'G']]);
  assert.equal(game.order[game.turnIndex], ids[0]);
  applyMove(game, game.players[ids[0]], [at(7, 7, 'C'), at(7, 8, 'A'), at(7, 9, 'T')]);
  assert.equal(game.order[game.turnIndex], ids[1]);
});

test('a trade moves the tile one way and the points the other', () => {
  const { game, ids } = tableFor([['A', 'A', 'A'], ['Q', 'B', 'C']]);
  const opened = openTrade(game, ids[0], 'Q', 5);
  assert.equal(opened.ok, true);

  const done = acceptTrade(game, ids[1]);
  assert.equal(done.ok, true);
  assert.equal(game.players[ids[0]].score, STARTING_SCORE - 5);
  assert.equal(game.players[ids[1]].score, STARTING_SCORE + 5);
  assert.ok(game.players[ids[0]].rack.includes('Q'));
  assert.ok(!game.players[ids[1]].rack.includes('Q'));
  assert.equal(game.pendingTrade, null);
});

test('a trade fails when the opponent does not hold the letter', () => {
  const { game, ids } = tableFor([['A', 'A', 'A'], ['B', 'C', 'D']]);
  openTrade(game, ids[0], 'Q', 5);
  const done = acceptTrade(game, ids[1]);
  assert.equal(done.ok, false);
  assert.equal(game.players[ids[0]].score, STARTING_SCORE);
  assert.equal(game.players[ids[1]].score, STARTING_SCORE);
});

test('you cannot offer a bounty you cannot cover', () => {
  const { game, ids } = tableFor([['A'], ['Q']]);
  game.players[ids[0]].score = 3;
  const opened = openTrade(game, ids[0], 'Q', 5);
  assert.equal(opened.ok, false);
  assert.match(opened.error, /afford/);
});

test('six scoreless turns end the game', () => {
  const { game, ids } = tableFor([['A'], ['B']]);
  let ended = false;
  for (let i = 0; i < 6; i += 1) ended = passTurn(game).ended;
  assert.equal(ended, true);
  assert.equal(game.over, true);
  // Unplayed racks are deducted at the buzzer.
  assert.equal(game.players[ids[0]].score, STARTING_SCORE - 1);
  assert.equal(game.players[ids[1]].score, STARTING_SCORE - 3);
});
