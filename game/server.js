// =============================================================
// Y2K WORD SLAM · SERVER
// =============================================================
// Express serves the static frontend; Socket.io runs the rooms.
// Game rules live in ./src/game.js so they can be tested on their own.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { Server } from 'socket.io';

import {
  MIN_TRADE_POINTS,
  MAX_TRADE_POINTS,
  MAX_PLAYERS
} from './src/constants.js';
import { dictionarySize } from './src/dictionary.js';
import { loadGames, scheduleSave, flush, SAVE_FILE } from './src/store.js';
import {
  createGame,
  addPlayer,
  isCurrentPlayer,
  markDisconnected,
  canSkipTurn,
  resetForRematch,
  rekeySeat,
  claimableSeats,
  isBlocked,
  evaluateMove,
  applyMove,
  passTurn,
  swapTiles,
  openTrade,
  acceptTrade,
  rejectTrade,
  approveWords,
  viewFor,
  pushLog
} from './src/game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    rooms: Object.keys(games).length,
    dictionaryWords: dictionarySize()
  });
});

// -------------------------------------------------------------
// In-memory game state
// -------------------------------------------------------------

const games = loadGames();
// roomId -> { word?: Timeout, trade?: Timeout }  (never persisted)
const timers = {};

const PENDING_TIMEOUT_MS = 90_000;
// Long enough to finish a game over a few evenings.
const ROOM_TTL_MS = (Number(process.env.ROOM_TTL_DAYS) || 30) * 24 * 60 * 60 * 1000;

const CHEERS = [
  'Booyah!',
  'As if!',
  'Schwing!',
  'All that and a bag of chips.',
  'Totally rad.',
  'Wicked awesome!',
  'Talk to the hand!',
  'That is so fetch.',
  'Word to your mother.',
  'Da bomb.'
];

const cheer = () => CHEERS[Math.floor(Math.random() * CHEERS.length)];

function getGame(roomId) {
  return games[roomId] ?? null;
}

function clearTimer(roomId, kind) {
  const bucket = timers[roomId];
  if (bucket?.[kind]) {
    clearTimeout(bucket[kind]);
    delete bucket[kind];
  }
}

function setTimer(roomId, kind, fn) {
  timers[roomId] = timers[roomId] ?? {};
  clearTimer(roomId, kind);
  timers[roomId][kind] = setTimeout(fn, PENDING_TIMEOUT_MS);
}

// -------------------------------------------------------------
// Broadcast helpers
// -------------------------------------------------------------

async function broadcastState(roomId) {
  const game = getGame(roomId);
  if (!game) return;

  // Every mutating handler ends here, so this is the one place that needs to
  // mark the room alive and queue a save.
  game.lastActivity = Date.now();
  scheduleSave(games);

  const sockets = await io.in(roomId).fetchSockets();
  for (const s of sockets) {
    const playerId = s.data.playerId;
    if (!playerId) continue;
    s.emit('game_state_update', viewFor(game, playerId));
  }
}

function announce(roomId, text, kind = 'info') {
  const game = getGame(roomId);
  if (game) pushLog(game, text, kind);
  io.to(roomId).emit('chat_message', { text, kind, at: Date.now() });
}

function socketOf(playerId, roomId) {
  for (const s of io.sockets.sockets.values()) {
    if (s.data.playerId === playerId && s.data.roomId === roomId) return s;
  }
  return null;
}

function emitToPlayer(roomId, playerId, event, payload) {
  const s = socketOf(playerId, roomId);
  if (s) s.emit(event, payload);
}

function fail(socket, message) {
  socket.emit('error_message', { message });
}

// -------------------------------------------------------------
// Input sanitising
// -------------------------------------------------------------

const cleanRoomId = (value) =>
  String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

const cleanName = (value) =>
  String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Anonymous';

const cleanPlayerId = (value) => {
  const id = String(value ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
  return id.length >= 8 ? id : null;
};

// -------------------------------------------------------------
// Sockets
// -------------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('join_game', async (rawRoomId, rawName, rawPlayerId) => {
    const roomId = cleanRoomId(rawRoomId);
    const playerName = cleanName(rawName);
    const playerId = cleanPlayerId(rawPlayerId) ?? socket.id;

    if (!roomId) return fail(socket, 'That room code is bogus.');

    if (!games[roomId]) games[roomId] = createGame(roomId);
    const game = games[roomId];

    // An id we do not recognise arriving at a room that already has empty
    // seats is usually someone coming back on a phone that forgot them —
    // offer the seats rather than dealing them a meaningless new rack.
    if (!game.players[playerId] && game.order.length > 0) {
      const seats = claimableSeats(game);
      const canJoinNew = game.order.length < MAX_PLAYERS;
      if (seats.length > 0) {
        socket.emit('seat_choice', { roomId, seats, canJoinNew, round: game.round });
        return;
      }
      if (!canJoinNew) return fail(socket, 'This room is full. Bogus!');
    }

    const result = addPlayer(game, playerId, playerName);
    if (!result.ok) return fail(socket, result.error);
    await seatPlayer(socket, roomId, playerId, result.player, result.rejoined);
  });

  // Take over an empty seat in a saved game.
  socket.on('claim_seat', async (rawRoomId, seatId, rawName, rawPlayerId) => {
    const roomId = cleanRoomId(rawRoomId);
    const game = getGame(roomId);
    if (!game) return fail(socket, 'That game is gone.');

    const playerId = cleanPlayerId(rawPlayerId) ?? socket.id;
    const playerName = cleanName(rawName);

    // `seatId` of null means "deal me in as someone new".
    if (!seatId) {
      const result = addPlayer(game, playerId, playerName);
      if (!result.ok) return fail(socket, result.error);
      await seatPlayer(socket, roomId, playerId, result.player, result.rejoined);
      return;
    }

    const result = rekeySeat(game, String(seatId), playerId, playerName);
    if (!result.ok) return fail(socket, result.error);

    announce(roomId, `${result.player.name} picked their game back up. *dial-up noises*`, 'join');
    await seatPlayer(socket, roomId, playerId, result.player, true, true);
  });

  // --- PLAYING A WORD ------------------------------------------------------
  socket.on('play_word', async (rawRoomId, wordData) => {
    const roomId = cleanRoomId(rawRoomId);
    const game = getGame(roomId);
    const playerId = socket.data.playerId;
    if (!game || !playerId || !game.players[playerId]) return fail(socket, 'You are not in this game.');
    if (game.over) return fail(socket, 'This game is already over.');

    const blocked = isBlocked(game);
    if (blocked) return fail(socket, blocked);
    if (!isCurrentPlayer(game, playerId)) return fail(socket, 'Chill — it is not your turn.');

    const player = game.players[playerId];
    const placements = wordData?.placements ?? wordData?.tiles ?? [];
    const evaluation = evaluateMove(game, player, placements);

    if (!evaluation.ok) return fail(socket, evaluation.error);

    // Every word is known — score it right away.
    if (evaluation.valid) {
      const move = applyMove(game, player, placements);
      if (!move.ok) return fail(socket, move.error);
      announceMove(roomId, player, move);
      await broadcastState(roomId);
      return;
    }

    // Unknown word: put it to the table.
    const others = game.order.filter((id) => id !== playerId);
    if (others.length === 0) {
      return fail(socket, `"${evaluation.unknownWords.join(', ')}" is not in the dictionary and there is nobody here to vote. Page a buddy!`);
    }

    game.pendingWord = {
      playerId,
      placements: evaluation.placements,
      unknownWords: evaluation.unknownWords,
      words: evaluation.words.map((w) => w.word),
      createdAt: Date.now()
    };

    const label = evaluation.unknownWords.join('" and "');
    for (const id of others) {
      emitToPlayer(roomId, id, 'vote_new_word', {
        word: evaluation.unknownWords.join(', '),
        words: evaluation.unknownWords,
        from: playerId,
        fromName: player.name,
        message: `${player.name} played "${label}". Not in the dictionary. Allow it?`
      });
    }
    announce(roomId, `${player.name} is trying to sneak "${label}" past everyone. VOTE TIME!`, 'vote');

    setTimer(roomId, 'word', async () => {
      const stale = game.pendingWord;
      if (!stale) return;
      game.pendingWord = null;
      emitToPlayer(roomId, stale.playerId, 'word_rejected', {
        message: 'Nobody voted in time. Your word timed out — try again.',
        words: stale.unknownWords
      });
      announce(roomId, 'Vote timed out. The word slinks away in shame.', 'vote');
      await broadcastState(roomId);
    });

    await broadcastState(roomId);
  });

  // --- DEMOCRATIC DICTIONARY VOTE -----------------------------------------
  socket.on('vote_result', async (rawRoomId, data) => {
    const roomId = cleanRoomId(rawRoomId);
    const game = getGame(roomId);
    const voterId = socket.data.playerId;
    if (!game || !voterId) return;

    const pending = game.pendingWord;
    if (!pending) return fail(socket, 'There is no word up for a vote.');
    if (pending.playerId === voterId) return fail(socket, 'You cannot vote on your own word. Nice try.');

    clearTimer(roomId, 'word');
    game.pendingWord = null;

    const author = game.players[pending.playerId];
    const voter = game.players[voterId];
    if (!author) {
      await broadcastState(roomId);
      return;
    }

    if (data?.approved) {
      // Approve first so the 1-point-per-letter first-use rule kicks in.
      approveWords(game, pending.unknownWords, pending.playerId, voterId);
      const move = applyMove(game, author, pending.placements);
      if (!move.ok) {
        // Board changed underneath the vote — hand the tiles back.
        emitToPlayer(roomId, pending.playerId, 'word_rejected', { message: move.error });
      } else {
        announce(
          roomId,
          `"${pending.unknownWords.join('", "')}" approved by ${voter?.name ?? 'the people'}! Schwing! (First use scores 1 point per letter.)`,
          'vote'
        );
        announceMove(roomId, author, move);
      }
    } else {
      emitToPlayer(roomId, pending.playerId, 'word_rejected', {
        message: 'Talk to the hand! Word denied.',
        words: pending.unknownWords
      });
      announce(roomId, `${voter?.name ?? 'Somebody'} vetoed "${pending.unknownWords.join('", "')}". Denied!`, 'vote');
    }

    await broadcastState(roomId);
  });

  // --- TRADING ECONOMY -----------------------------------------------------
  socket.on('request_trade', async (rawRoomId, requestedLetter, offerPoints) => {
    const roomId = cleanRoomId(rawRoomId);
    const game = getGame(roomId);
    const playerId = socket.data.playerId;
    if (!game || !playerId || !game.players[playerId]) return fail(socket, 'You are not in this game.');

    const letter = String(requestedLetter ?? '').toUpperCase().slice(0, 1);
    if (!/^[A-Z]$/.test(letter)) return fail(socket, 'Pick a real letter, chief.');

    const points = Math.round(Number(offerPoints));
    if (!Number.isFinite(points) || points < MIN_TRADE_POINTS || points > MAX_TRADE_POINTS) {
      return fail(socket, `Bounty must be between ${MIN_TRADE_POINTS} and ${MAX_TRADE_POINTS} points.`);
    }

    const result = openTrade(game, playerId, letter, points);
    if (!result.ok) return fail(socket, result.error);

    const from = game.players[playerId];
    for (const id of game.order.filter((other) => other !== playerId)) {
      emitToPlayer(roomId, id, 'trade_offer_received', {
        from: playerId,
        fromName: from.name,
        letter,
        points,
        message: `${from.name} wants a ${letter} for ${points} pts! "Deal or No Deal?"`
      });
    }
    announce(roomId, `📟 ${from.name} is paging the table for a "${letter}" — ${points} pts on offer.`, 'trade');

    setTimer(roomId, 'trade', async () => {
      if (!game.pendingTrade) return;
      game.pendingTrade = null;
      announce(roomId, 'Trade offer expired. *busy signal*', 'trade');
      io.to(roomId).emit('trade_closed', { reason: 'expired' });
      await broadcastState(roomId);
    });

    await broadcastState(roomId);
  });

  socket.on('accept_trade', async (rawRoomId) => {
    const roomId = cleanRoomId(rawRoomId);
    const game = getGame(roomId);
    const playerId = socket.data.playerId;
    if (!game || !playerId) return;

    const result = acceptTrade(game, playerId);
    if (!result.ok) {
      clearTimer(roomId, 'trade');
      fail(socket, result.error);
      io.to(roomId).emit('trade_closed', { reason: 'failed' });
      await broadcastState(roomId);
      return;
    }

    clearTimer(roomId, 'trade');
    io.to(roomId).emit('trade_closed', { reason: 'accepted' });
    announce(
      roomId,
      `Trade complete! ${result.accepter.name} handed over a "${result.letter}" for ${result.points} pts. That was all that and a bag of chips.`,
      'trade'
    );
    await broadcastState(roomId);
  });

  socket.on('reject_trade', async (rawRoomId) => {
    const roomId = cleanRoomId(rawRoomId);
    const game = getGame(roomId);
    const playerId = socket.data.playerId;
    if (!game || !game.pendingTrade) return;
    if (game.pendingTrade.from === playerId) return fail(socket, 'Use cancel to pull your own offer.');

    const trade = rejectTrade(game);
    clearTimer(roomId, 'trade');
    io.to(roomId).emit('trade_closed', { reason: 'rejected' });
    emitToPlayer(roomId, trade.from, 'trade_rejected', {
      message: `No deal on that ${trade.letter}. Talk to the hand!`
    });
    announce(roomId, `${game.players[playerId]?.name ?? 'Somebody'} passed on the trade. No deal!`, 'trade');
    await broadcastState(roomId);
  });

  socket.on('cancel_trade', async (rawRoomId) => {
    const roomId = cleanRoomId(rawRoomId);
    const game = getGame(roomId);
    if (!game?.pendingTrade) return;
    if (game.pendingTrade.from !== socket.data.playerId) return;
    rejectTrade(game);
    clearTimer(roomId, 'trade');
    io.to(roomId).emit('trade_closed', { reason: 'cancelled' });
    announce(roomId, 'Offer pulled off the table.', 'trade');
    await broadcastState(roomId);
  });

  // --- OTHER TURN ACTIONS --------------------------------------------------
  socket.on('pass_turn', async (rawRoomId) => {
    const roomId = cleanRoomId(rawRoomId);
    const game = getGame(roomId);
    const playerId = socket.data.playerId;
    if (!game || !playerId || game.over) return;
    const blocked = isBlocked(game);
    if (blocked) return fail(socket, blocked);
    if (!isCurrentPlayer(game, playerId)) return fail(socket, 'Not your turn, buddy.');

    const { ended } = passTurn(game);
    announce(roomId, `${game.players[playerId].name} passed. Weak sauce.`, 'turn');
    if (ended) announceGameOver(roomId);
    await broadcastState(roomId);
  });

  socket.on('swap_tiles', async (rawRoomId, letters) => {
    const roomId = cleanRoomId(rawRoomId);
    const game = getGame(roomId);
    const playerId = socket.data.playerId;
    if (!game || !playerId || game.over) return;
    const blocked = isBlocked(game);
    if (blocked) return fail(socket, blocked);
    if (!isCurrentPlayer(game, playerId)) return fail(socket, 'Not your turn, buddy.');

    const result = swapTiles(game, game.players[playerId], Array.isArray(letters) ? letters.slice(0, 10) : []);
    if (!result.ok) return fail(socket, result.error);

    announce(roomId, `${game.players[playerId].name} dumped ${result.count} tile(s) back in the bag.`, 'turn');
    if (result.ended) announceGameOver(roomId);
    await broadcastState(roomId);
  });

  // Rescue a table stuck behind someone who walked away.
  socket.on('skip_player', async (rawRoomId) => {
    const roomId = cleanRoomId(rawRoomId);
    const game = getGame(roomId);
    const playerId = socket.data.playerId;
    if (!game || !playerId) return;

    const blocked = isBlocked(game);
    if (blocked) return fail(socket, blocked);

    const allowed = canSkipTurn(game, playerId);
    if (!allowed.ok) return fail(socket, allowed.error);

    const { ended } = passTurn(game);
    announce(roomId, `${allowed.target.name} went AWOL — turn skipped. *crickets*`, 'turn');
    if (ended) announceGameOver(roomId);
    await broadcastState(roomId);
  });

  // Same seats, same house dictionary, fresh board.
  socket.on('rematch', async (rawRoomId) => {
    const roomId = cleanRoomId(rawRoomId);
    const game = getGame(roomId);
    const playerId = socket.data.playerId;
    if (!game || !playerId || !game.players[playerId]) return;
    if (!game.over) return fail(socket, 'Finish this game first!');

    clearTimer(roomId, 'word');
    clearTimer(roomId, 'trade');

    const reset = resetForRematch(game);
    if (!reset.ok) return fail(socket, reset.error);

    io.to(roomId).emit('rematch_started', { round: reset.round });
    announce(
      roomId,
      `${game.players[playerId].name} hit RUN IT BACK. Round ${reset.round}! ${cheer()}`,
      'join'
    );
    await broadcastState(roomId);
  });

  socket.on('chat', (rawRoomId, text) => {
    const roomId = cleanRoomId(rawRoomId);
    const game = getGame(roomId);
    const playerId = socket.data.playerId;
    if (!game || !playerId || !game.players[playerId]) return;
    const message = String(text ?? '').trim().slice(0, 200);
    if (!message) return;
    announce(roomId, `<${game.players[playerId].name}> ${message}`, 'chat');
  });

  socket.on('disconnect', async () => {
    const { roomId, playerId } = socket.data;
    if (!roomId || !playerId) return;
    const game = getGame(roomId);
    if (!game?.players[playerId]) return;

    // The seat is held — mobile browsers drop sockets constantly.
    const stillHere = [...io.sockets.sockets.values()].some(
      (s) => s.id !== socket.id && s.data.playerId === playerId && s.data.roomId === roomId
    );
    if (stillHere) return;

    markDisconnected(game, playerId);
    announce(roomId, `${game.players[playerId].name} got disconnected. *modem screech*`, 'leave');
    await broadcastState(roomId);
  });
});

// -------------------------------------------------------------
// Announcements
// -------------------------------------------------------------

/** Shared tail of every way into a room: bind the socket, greet, broadcast. */
async function seatPlayer(socket, roomId, playerId, player, rejoined, silent = false) {
  socket.data.roomId = roomId;
  socket.data.playerId = playerId;
  socket.join(roomId);

  socket.emit('joined', {
    roomId,
    playerId,
    seat: player.seat,
    rejoined,
    maxPlayers: MAX_PLAYERS
  });

  if (!silent) {
    announce(
      roomId,
      rejoined
        ? `${player.name} is back online. *dial-up noises*`
        : `${player.name} entered the chat room. ${cheer()}`,
      'join'
    );
  }
  await broadcastState(roomId);
}

function announceMove(roomId, player, move) {
  const game = getGame(roomId);
  const headline = move.breakdown
    .map((entry) => `${entry.word} (${entry.score}${entry.firstUse ? ', house rules' : ''})`)
    .join(' + ');
  announce(
    roomId,
    `${player.name} played ${headline} for ${move.total} pts${move.bingo ? ' — BINGO +50! ' + cheer() : '.'}`,
    'move'
  );
  io.to(roomId).emit('move_played', {
    playerId: player.id,
    name: player.name,
    total: move.total,
    bingo: move.bingo,
    breakdown: move.breakdown
  });
  if (game?.over) announceGameOver(roomId);
}

function announceGameOver(roomId) {
  const game = getGame(roomId);
  if (!game) return;
  const standings = game.order
    .map((id) => game.players[id])
    .sort((a, b) => b.score - a.score);
  const winner = standings[0];
  announce(
    roomId,
    `GAME OVER. ${winner ? `${winner.name} wins with ${winner.score} pts. ${cheer()}` : 'Nobody wins.'}`,
    'over'
  );
  io.to(roomId).emit('game_over', {
    standings: standings.map((p) => ({ name: p.name, score: p.score, id: p.id }))
  });
}

// -------------------------------------------------------------
// Housekeeping
// -------------------------------------------------------------

setInterval(async () => {
  const now = Date.now();
  let swept = 0;
  for (const [roomId, game] of Object.entries(games)) {
    const sockets = await io.in(roomId).fetchSockets();
    const idleFor = now - (game.lastActivity ?? game.createdAt ?? 0);
    if (sockets.length === 0 && idleFor > ROOM_TTL_MS) {
      for (const kind of Object.keys(timers[roomId] ?? {})) clearTimer(roomId, kind);
      delete timers[roomId];
      delete games[roomId];
      swept += 1;
    }
  }
  if (swept > 0) scheduleSave(games);
}, 15 * 60 * 1000).unref();

// Never lose a move to a restart or a redeploy.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    flush();
    process.exit(0);
  });
}

/** Every address on the local network this server can be reached at. */
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address);
}

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  const saved = Object.keys(games).length;
  console.log(`\n  Y2K WORD SLAM · ${dictionarySize().toLocaleString()} words loaded\n`);
  console.log(`  On this computer:  http://localhost:${PORT}`);
  for (const address of lanAddresses()) {
    console.log(`  On your wifi:      http://${address}:${PORT}   <- use this on phones`);
  }
  console.log(`\n  Saving games to:   ${SAVE_FILE}`);
  console.log(saved > 0
    ? `  ${saved} game(s) picked up where you left off. Ctrl+C is safe.\n`
    : '  No saved games yet. Ctrl+C is safe — progress is written to disk.\n');
});

export { app, server, io, games };
