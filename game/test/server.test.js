// End-to-end tests over real sockets: two clients, one room.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { io as ioClient } from 'socket.io-client';

process.env.PORT = '0';
process.env.ABANDON_SKIP_MS = '150';
const { server, games } = await import('../server.js');

if (!server.listening) await once(server, 'listening');
const url = `http://localhost:${server.address().port}`;

function connect() {
  return ioClient(url, { transports: ['websocket'], forceNew: true });
}

/** Resolve with the next payload for `event`, or reject after `ms`. */
function next(socket, event, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, ms);
    const handler = (payload) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

async function seatTwo(roomId) {
  const a = connect();
  const b = connect();
  await Promise.all([once(a, 'connect'), once(b, 'connect')]);

  const aJoined = next(a, 'joined');
  a.emit('join_game', roomId, 'Ace', 'player-aaaaaaaa');
  await aJoined;

  const bJoined = next(b, 'joined');
  const aSeesB = next(a, 'game_state_update');
  b.emit('join_game', roomId, 'Buddy', 'player-bbbbbbbb');
  await Promise.all([bJoined, aSeesB]);

  return { a, b, game: games[roomId] };
}

const place = (row, col, letter) => ({ row, col, letter, blank: false });

test('two players can join and see each other', async (t) => {
  const { a, b, game } = await seatTwo('ROOM1');
  t.after(() => { a.close(); b.close(); });

  const view = await new Promise((resolve) => {
    a.once('game_state_update', resolve);
    a.emit('chat', 'ROOM1', 'yo');
    // Any state broadcast will do; force one with a fresh join ping.
    b.emit('join_game', 'ROOM1', 'Buddy', 'player-bbbbbbbb');
  });

  assert.equal(view.players.length, 2);
  assert.deepEqual(view.players.map((p) => p.name), ['Ace', 'Buddy']);
  assert.equal(view.you, 'player-aaaaaaaa');
  assert.equal(view.yourRack.length, 7);
  // Other players' racks stay secret.
  assert.ok(!('rack' in view.players[1]));
  assert.equal(game.order.length, 2);
});

test('a real word scores without a vote', async (t) => {
  const { a, b, game } = await seatTwo('ROOM2');
  t.after(() => { a.close(); b.close(); });

  const turnId = game.order[game.turnIndex];
  const mover = turnId === 'player-aaaaaaaa' ? a : b;
  game.players[turnId].rack = ['C', 'A', 'T', 'E', 'R', 'S', 'N'];

  const played = next(mover, 'move_played');
  mover.emit('play_word', 'ROOM2', {
    placements: [place(7, 7, 'C'), place(7, 8, 'A'), place(7, 9, 'T')]
  });

  const result = await played;
  assert.equal(result.total, 10);
  assert.equal(game.board[7][7].letter, 'C');
  assert.equal(game.order[game.turnIndex], game.order[1]);
});

test('a made-up word goes to a vote and scores 1 point per letter when approved', async (t) => {
  const { a, b, game } = await seatTwo('ROOM3');
  t.after(() => { a.close(); b.close(); });

  const turnId = game.order[game.turnIndex];
  const mover = turnId === 'player-aaaaaaaa' ? a : b;
  const voter = mover === a ? b : a;
  const startingScore = game.players[turnId].score;
  game.players[turnId].rack = ['Y', 'E', 'E', 'T', 'A', 'B', 'C'];

  const votePrompt = next(voter, 'vote_new_word');
  mover.emit('play_word', 'ROOM3', {
    placements: [place(7, 7, 'Y'), place(7, 8, 'E'), place(7, 9, 'E'), place(7, 10, 'T')]
  });

  const prompt = await votePrompt;
  assert.equal(prompt.word, 'YEET');
  assert.match(prompt.message, /Allow it\?/);
  assert.equal(game.pendingWord.unknownWords[0], 'YEET');

  const played = next(mover, 'move_played');
  voter.emit('vote_result', 'ROOM3', { approved: true });
  const result = await played;

  // First outing: flat 1 point per letter, centre double-word ignored.
  assert.equal(result.total, 4);
  assert.equal(game.players[turnId].score, startingScore + 4);
  assert.equal(game.customDictionary.YEET.uses, 1);
});

test('a rejected word is handed back to the player', async (t) => {
  const { a, b, game } = await seatTwo('ROOM4');
  t.after(() => { a.close(); b.close(); });

  const turnId = game.order[game.turnIndex];
  const mover = turnId === 'player-aaaaaaaa' ? a : b;
  const voter = mover === a ? b : a;
  const startingScore = game.players[turnId].score;
  game.players[turnId].rack = ['Z', 'Q', 'X', 'J', 'V', 'W', 'K'];

  const votePrompt = next(voter, 'vote_new_word');
  mover.emit('play_word', 'ROOM4', {
    placements: [place(7, 7, 'Z'), place(7, 8, 'Q'), place(7, 9, 'X')]
  });
  await votePrompt;

  const rejected = next(mover, 'word_rejected');
  voter.emit('vote_result', 'ROOM4', { approved: false });
  const notice = await rejected;

  assert.match(notice.message, /Talk to the hand/);
  assert.equal(game.players[turnId].score, startingScore);
  assert.equal(game.board[7][7], null);
  assert.equal(game.customDictionary.ZQX, undefined);
  assert.equal(game.pendingWord, null);
});

test('a player cannot vote their own word in', async (t) => {
  const { a, b, game } = await seatTwo('ROOM5');
  t.after(() => { a.close(); b.close(); });

  const turnId = game.order[game.turnIndex];
  const mover = turnId === 'player-aaaaaaaa' ? a : b;
  const voter = mover === a ? b : a;
  game.players[turnId].rack = ['Y', 'E', 'E', 'T', 'A', 'B', 'C'];

  const votePrompt = next(voter, 'vote_new_word');
  mover.emit('play_word', 'ROOM5', {
    placements: [place(7, 7, 'Y'), place(7, 8, 'E'), place(7, 9, 'E'), place(7, 10, 'T')]
  });
  await votePrompt;

  const denied = next(mover, 'error_message');
  mover.emit('vote_result', 'ROOM5', { approved: true });
  const error = await denied;

  assert.match(error.message, /cannot vote on your own word/);
  assert.equal(game.customDictionary.YEET, undefined);
  assert.ok(game.pendingWord);
});

test('trading moves a tile one way and points the other', async (t) => {
  const { a, b, game } = await seatTwo('ROOM6');
  t.after(() => { a.close(); b.close(); });

  game.players['player-aaaaaaaa'].rack = ['A', 'A', 'A', 'A', 'A', 'A', 'A'];
  game.players['player-bbbbbbbb'].rack = ['Q', 'B', 'C', 'D', 'E', 'F', 'G'];
  const aScore = game.players['player-aaaaaaaa'].score;
  const bScore = game.players['player-bbbbbbbb'].score;

  const offer = next(b, 'trade_offer_received');
  a.emit('request_trade', 'ROOM6', 'Q', 5);
  const received = await offer;
  assert.equal(received.letter, 'Q');
  assert.match(received.message, /Deal or No Deal/);

  const closed = next(b, 'trade_closed');
  b.emit('accept_trade', 'ROOM6');
  await closed;

  assert.equal(game.players['player-aaaaaaaa'].score, aScore - 5);
  assert.equal(game.players['player-bbbbbbbb'].score, bScore + 5);
  assert.ok(game.players['player-aaaaaaaa'].rack.includes('Q'));
  assert.ok(!game.players['player-bbbbbbbb'].rack.includes('Q'));
  assert.equal(game.pendingTrade, null);
});

test('playing out of turn is refused', async (t) => {
  const { a, b, game } = await seatTwo('ROOM7');
  t.after(() => { a.close(); b.close(); });

  const waiterId = game.order[1];
  const waiter = waiterId === 'player-aaaaaaaa' ? a : b;
  game.players[waiterId].rack = ['C', 'A', 'T', 'E', 'R', 'S', 'N'];

  const refusal = next(waiter, 'error_message');
  waiter.emit('play_word', 'ROOM7', {
    placements: [place(7, 7, 'C'), place(7, 8, 'A'), place(7, 9, 'T')]
  });
  const error = await refusal;
  assert.match(error.message, /not your turn/i);
  assert.equal(game.board[7][7], null);
});

test('a reconnecting player keeps their seat, score and rack', async (t) => {
  const { a, b, game } = await seatTwo('ROOM8');
  t.after(() => { b.close(); });

  game.players['player-aaaaaaaa'].score = 123;
  const rackBefore = [...game.players['player-aaaaaaaa'].rack];

  a.close();
  await new Promise((resolve) => setTimeout(resolve, 100));

  const again = connect();
  t.after(() => { again.close(); });
  await once(again, 'connect');
  const joined = next(again, 'joined');
  const stateArrived = next(again, 'game_state_update');
  again.emit('join_game', 'ROOM8', 'Ace', 'player-aaaaaaaa');
  const ack = await joined;

  assert.equal(ack.rejoined, true);
  assert.equal(ack.seat, 0);
  const view = await stateArrived;
  assert.equal(view.players.length, 2);
  assert.equal(view.players[0].score, 123);
  assert.deepEqual(view.yourRack, rackBefore);
});

test('an abandoned turn can be skipped once the player is gone long enough', async (t) => {
  const { a, b, game } = await seatTwo('ROOM9');
  t.after(() => { a.close(); b.close(); });

  const turnId = game.order[game.turnIndex];
  const quitter = turnId === 'player-aaaaaaaa' ? a : b;
  const stayer = quitter === a ? b : a;

  quitter.close();
  await new Promise((resolve) => setTimeout(resolve, 60));

  // Too soon — the seat is still warm.
  const tooSoon = next(stayer, 'error_message');
  stayer.emit('skip_player', 'ROOM9');
  assert.match((await tooSoon).message, /not been gone long enough/);
  assert.equal(game.order[game.turnIndex], turnId);

  await new Promise((resolve) => setTimeout(resolve, 200));

  const updated = next(stayer, 'game_state_update');
  stayer.emit('skip_player', 'ROOM9');
  await updated;
  assert.notEqual(game.order[game.turnIndex], turnId);
});

test('you cannot skip your own turn', async (t) => {
  const { a, b, game } = await seatTwo('ROOM10');
  t.after(() => { a.close(); b.close(); });

  const turnId = game.order[game.turnIndex];
  const mover = turnId === 'player-aaaaaaaa' ? a : b;

  const refused = next(mover, 'error_message');
  mover.emit('skip_player', 'ROOM10');
  assert.match((await refused).message, /your own turn/);
  assert.equal(game.order[game.turnIndex], turnId);
});

test('a rematch deals a fresh board to the same seats', async (t) => {
  const { a, b, game } = await seatTwo('ROOM11');
  t.after(() => { a.close(); b.close(); });

  const turnId = game.order[game.turnIndex];
  const mover = turnId === 'player-aaaaaaaa' ? a : b;
  game.players[turnId].rack = ['C', 'A', 'T', 'E', 'R', 'S', 'N'];

  const played = next(mover, 'move_played');
  mover.emit('play_word', 'ROOM11', {
    placements: [place(7, 7, 'C'), place(7, 8, 'A'), place(7, 9, 'T')]
  });
  await played;

  // Rematching mid-game is refused.
  const refused = next(a, 'error_message');
  a.emit('rematch', 'ROOM11');
  assert.match((await refused).message, /Finish this game first/);
  assert.equal(game.board[7][7].letter, 'C');

  game.over = true;
  const started = next(b, 'rematch_started');
  const fresh = next(a, 'game_state_update');
  a.emit('rematch', 'ROOM11');

  assert.equal((await started).round, 2);
  const view = await fresh;
  assert.equal(view.over, false);
  assert.equal(view.board[7][7], null);
  assert.equal(view.players.length, 2);
  assert.equal(view.players[0].score, 50);
  assert.equal(view.yourRack.length, 7);
});

test.after(() => {
  server.close();
});
