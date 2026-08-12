// Persistence: a saved game has to come back playable, not just parseable.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'y2k-store-'));
process.env.DATA_DIR = DATA_DIR;

const { loadGames, saveNow, flush, SAVE_FILE } = await import('../src/store.js');
const {
  createGame, addPlayer, applyMove, approveWords, markDisconnected, rekeySeat, claimableSeats
} = await import('../src/game.js');

const at = (row, col, letter) => ({ row, col, letter, blank: false });

function playedGame() {
  const game = createGame('SAVE1');
  addPlayer(game, 'p1', 'Ace');
  addPlayer(game, 'p2', 'Buddy');
  game.players.p1.rack = ['C', 'A', 'T', 'E', 'R', 'S', 'N'];
  approveWords(game, ['YEET'], 'p1', 'p2');
  applyMove(game, game.players.p1, [at(7, 7, 'C'), at(7, 8, 'A'), at(7, 9, 'T')]);
  return game;
}

test('a saved game reloads with its board, scores, racks and dictionary', () => {
  const game = playedGame();
  const expectedScore = game.players.p1.score;
  const expectedRack = [...game.players.p2.rack];

  saveNow({ SAVE1: game });
  assert.ok(fs.existsSync(SAVE_FILE));

  const loaded = loadGames();
  const back = loaded.SAVE1;

  assert.equal(back.board[7][7].letter, 'C');
  assert.equal(back.board[7][9].letter, 'T');
  assert.equal(back.players.p1.score, expectedScore);
  assert.deepEqual(back.players.p2.rack, expectedRack);
  assert.deepEqual(back.order, ['p1', 'p2']);
  assert.equal(back.turnIndex, 1);
  assert.equal(back.customDictionary.YEET.uses, 0);
  assert.equal(back.bag.length, game.bag.length);
});

test('a reloaded game treats everyone as offline without instantly forfeiting them', () => {
  const game = playedGame();
  // Someone who was already long gone before the restart.
  markDisconnected(game, 'p2');
  game.players.p2.offlineSince = Date.now() - 60 * 60 * 1000;

  saveNow({ SAVE2: game });
  const back = loadGames().SAVE2;

  for (const player of Object.values(back.players)) {
    assert.equal(player.connected, false);
    // The AWOL clock restarts with the server rather than carrying over.
    assert.ok(Date.now() - player.offlineSince < 5000);
  }
});

test('a pending vote does not survive a restart as a deadlock', () => {
  const game = playedGame();
  game.pendingWord = { playerId: 'p1', placements: [], unknownWords: ['ZZZ'], words: [] };
  game.pendingTrade = { from: 'p1', letter: 'Q', points: 5 };

  saveNow({ SAVE3: game });
  const back = loadGames().SAVE3;

  assert.equal(back.pendingWord, null);
  assert.equal(back.pendingTrade, null);
});

test('a corrupt save file does not stop the server booting', () => {
  fs.writeFileSync(SAVE_FILE, '{ this is not json');
  assert.deepEqual(loadGames(), {});

  fs.writeFileSync(SAVE_FILE, JSON.stringify({ version: 999, games: { X: {} } }));
  assert.deepEqual(loadGames(), {});
});

test('a missing save file just means no saved games', () => {
  fs.rmSync(SAVE_FILE, { force: true });
  assert.deepEqual(loadGames(), {});
});

test('an empty seat can be claimed by a browser that forgot who it was', () => {
  const game = playedGame();
  markDisconnected(game, 'p1');

  const seats = claimableSeats(game);
  assert.equal(seats.length, 1);
  assert.equal(seats[0].name, 'Ace');
  assert.equal(seats[0].id, 'p1');

  const scoreBefore = game.players.p1.score;
  const rackBefore = [...game.players.p1.rack];

  const result = rekeySeat(game, 'p1', 'new-phone-id', 'Ace');
  assert.equal(result.ok, true);

  assert.equal(game.players.p1, undefined);
  assert.equal(game.players['new-phone-id'].score, scoreBefore);
  assert.deepEqual(game.players['new-phone-id'].rack, rackBefore);
  assert.deepEqual(game.order, ['new-phone-id', 'p2']);
  assert.equal(game.players['new-phone-id'].connected, true);
  // Tiles they played on the board follow them to the new id.
  assert.equal(game.board[7][7].playerId, 'new-phone-id');
  assert.equal(game.customDictionary.YEET.addedBy, 'new-phone-id');
});

test('an occupied seat cannot be stolen', () => {
  const game = playedGame();
  const result = rekeySeat(game, 'p1', 'someone-else', 'Imposter');
  assert.equal(result.ok, false);
  assert.match(result.error, /already sitting there/);
  assert.ok(game.players.p1);
});

test('you cannot claim a second seat at the same table', () => {
  const game = playedGame();
  markDisconnected(game, 'p1');
  const result = rekeySeat(game, 'p1', 'p2', 'Greedy');
  assert.equal(result.ok, false);
  assert.match(result.error, /already have a seat/);
});

test.after(() => {
  flush();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
