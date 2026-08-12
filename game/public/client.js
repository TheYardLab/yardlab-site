/* =============================================================
   Y2K WORD SLAM · CLIENT
   ============================================================= */
(function () {
  'use strict';

  // -----------------------------------------------------------
  // Constants (mirrors of the server's board + tile tables)
  // -----------------------------------------------------------

  var PREMIUM_ROWS = [
    'T..d...T...d..T', '.D...t...t...D.', '..D...d.d...D..', 'd..D...d...D..d',
    '....D.....D....', '.t...t...t...t.', '..d...d.d...d..', 'T..d...D...d..T',
    '..d...d.d...d..', '.t...t...t...t.', '....D.....D....', 'd..D...d...D..d',
    '..D...d.d...D..', '.D...t...t...D.', 'T..d...T...d..T'
  ];
  var PREMIUM_LABEL = { T: 'TW', D: 'DW', t: 'TL', d: 'DL', '.': '' };
  var PREMIUM_MULT = {
    T: { letter: 1, word: 3 }, D: { letter: 1, word: 2 },
    t: { letter: 3, word: 1 }, d: { letter: 2, word: 1 }, '.': { letter: 1, word: 1 }
  };
  var TILE_VALUES = {
    A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8, K: 5, L: 1, M: 3,
    N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1, U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10, '?': 0
  };
  var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  var SIZE = 15;

  var TICKERS = [
    '★ TRADE TILES ★ VOTE IN FAKE WORDS ★ NO CHEATING ★',
    '★ THIS SITE IS BEST VIEWED WITH YOUR EYES ★',
    '★ WARNING: CONTAINS EXTREME AMOUNTS OF RAD ★',
    '★ Y2K COMPLIANT SINCE 1999 ★ BOOYAH ★',
    '★ ASK YOUR OPPONENT FOR A "Q". LIVE DANGEROUSLY ★'
  ];

  // -----------------------------------------------------------
  // State
  // -----------------------------------------------------------

  var socket = null;
  var state = null;          // latest game_state_update
  var roomId = null;
  var playerId = null;
  var pending = [];          // [{row, col, letter, blank}]
  var selectedRackIdx = -1;
  var blankTarget = null;    // {row, col} awaiting a letter choice
  var swapPicks = [];
  var tradeLetter = null;
  var rackOrder = null;      // local shuffle order

  var $ = function (id) { return document.getElementById(id); };

  // -----------------------------------------------------------
  // Room code + identity
  // -----------------------------------------------------------

  function randomRoomCode() {
    var words = ['RAD', 'FLY', 'DOPE', 'ZANY', 'YO', 'MOSH', 'DUDE', 'WHOA', 'JAZZ', 'FUNK'];
    var word = words[Math.floor(Math.random() * words.length)];
    return (word + Math.floor(Math.random() * 90 + 10)).slice(0, 8);
  }

  function getOrMakeRoom() {
    var params = new URLSearchParams(window.location.search);
    var room = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!room) {
      room = randomRoomCode();
      params.set('room', room);
      history.replaceState(null, '', window.location.pathname + '?' + params.toString());
    }
    return room;
  }

  function getPlayerId() {
    var id = null;
    try { id = localStorage.getItem('y2k-player-id'); } catch (e) { /* private mode */ }
    if (!id) {
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'p-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      try { localStorage.setItem('y2k-player-id', id); } catch (e) { /* ignore */ }
    }
    return id;
  }

  function savedName() {
    try { return localStorage.getItem('y2k-player-name') || ''; } catch (e) { return ''; }
  }

  // -----------------------------------------------------------
  // Boot
  // -----------------------------------------------------------

  function boot() {
    roomId = getOrMakeRoom();
    playerId = getPlayerId();
    $('room-code').textContent = roomId;
    $('room-input').value = roomId;
    $('name-input').value = savedName();
    $('ticker').textContent = TICKERS[Math.floor(Math.random() * TICKERS.length)];
    $('visitor-n').textContent = String(Math.floor(Math.random() * 9) + 1);
    setInterval(function () {
      $('year-wobble').textContent = String(Math.floor(Math.random() * 2) + 8);
    }, 3000);

    buildBoard();
    buildLetterGrids();
    wireControls();

    $('join-btn').addEventListener('click', join);
    $('name-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') join(); });
    $('room-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') join(); });
  }

  function join() {
    var name = $('name-input').value.trim() || 'Player';
    var room = ($('room-input').value || roomId).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!room) { toast('Room code required!'); return; }
    try { localStorage.setItem('y2k-player-name', name); } catch (e) { /* ignore */ }

    if (room !== roomId) {
      roomId = room;
      var params = new URLSearchParams(window.location.search);
      params.set('room', roomId);
      history.replaceState(null, '', window.location.pathname + '?' + params.toString());
      $('room-code').textContent = roomId;
    }

    $('join-screen').classList.add('hidden');
    connect(name);
  }

  // -----------------------------------------------------------
  // Socket wiring
  // -----------------------------------------------------------

  function connect(name) {
    socket = io();

    socket.on('connect', function () {
      setStatus(true);
      socket.emit('join_game', roomId, name, playerId);
    });
    socket.on('disconnect', function () { setStatus(false); });

    socket.on('joined', function (data) {
      if (data.rejoined) toast('Welcome back! Your seat was saved.');
    });

    socket.on('game_state_update', function (next) {
      state = next;
      reconcilePending();
      render();
    });

    socket.on('chat_message', function (msg) {
      var text = typeof msg === 'string' ? msg : msg.text;
      appendLog(text, (msg && msg.kind) || 'info');
    });

    socket.on('error_message', function (data) { toast(data.message); });

    socket.on('move_played', function (data) {
      if (data.playerId === playerId) {
        pending = [];
        selectedRackIdx = -1;
      }
      if (data.bingo) toast('BINGO! +50. ' + data.name + ' is on fire! 🔥');
    });

    socket.on('word_rejected', function (data) {
      toast(data.message);
      // Tiles are still on our rack — leave the pending placement so the
      // player can rearrange instead of starting over.
      render();
    });

    socket.on('vote_new_word', function (data) {
      $('vote-text').textContent = data.message;
      $('vote-modal').classList.remove('hidden');
    });

    socket.on('trade_offer_received', function (data) {
      $('offer-text').textContent = data.message;
      $('offer-modal').classList.remove('hidden');
    });

    socket.on('trade_closed', function () {
      $('offer-modal').classList.add('hidden');
    });

    socket.on('trade_rejected', function (data) { toast(data.message); });

    socket.on('rematch_started', function (data) {
      pending = [];
      selectedRackIdx = -1;
      rackOrder = null;
      $('over-modal').classList.add('hidden');
      toast('Round ' + data.round + '! Fresh board, same rivalry.');
    });

    socket.on('game_over', function (data) {
      var list = $('standings');
      list.innerHTML = '';
      data.standings.forEach(function (p) {
        var li = document.createElement('li');
        li.textContent = p.name + ' — ' + p.score + ' pts';
        list.appendChild(li);
      });
      $('over-modal').classList.remove('hidden');
    });
  }

  function setStatus(online) {
    var dot = $('conn-status');
    dot.className = 'status-dot ' + (online ? 'online' : 'offline');
    dot.title = online ? 'Connected' : 'Reconnecting…';
  }

  // -----------------------------------------------------------
  // Board construction + rendering
  // -----------------------------------------------------------

  function buildBoard() {
    var board = $('board');
    var frag = document.createDocumentFragment();
    for (var r = 0; r < SIZE; r += 1) {
      for (var c = 0; c < SIZE; c += 1) {
        var prem = PREMIUM_ROWS[r][c];
        var cell = document.createElement('div');
        cell.className = 'cell' + (prem !== '.' ? ' prem-' + prem : '') +
          (r === 7 && c === 7 ? ' center' : '');
        cell.dataset.row = r;
        cell.dataset.col = c;
        cell.setAttribute('role', 'gridcell');
        cell.textContent = (r === 7 && c === 7) ? '' : PREMIUM_LABEL[prem];
        frag.appendChild(cell);
      }
    }
    board.appendChild(frag);
    board.addEventListener('click', onBoardClick);
  }

  function tileEl(letter, blank, extraClass) {
    var el = document.createElement('div');
    el.className = 'tile' + (blank ? ' blank' : '') + (extraClass ? ' ' + extraClass : '');
    el.textContent = letter === '?' ? '★' : letter;
    if (letter !== '?') {
      var val = document.createElement('span');
      val.className = 'val';
      val.textContent = blank ? 0 : (TILE_VALUES[letter] || 0);
      el.appendChild(val);
    }
    return el;
  }

  function render() {
    if (!state) return;
    renderPlayers();
    renderBoard();
    renderRack();
    renderDictionary();
    renderControls();
    renderAwol();
  }

  /**
   * Offer an escape hatch when the player whose turn it is has gone offline.
   * Ticks on a timer because eligibility is a function of wall-clock time,
   * not of anything the server pushes.
   */
  function renderAwol() {
    var bar = $('awol-bar');
    if (!state || state.over) { bar.classList.add('hidden'); return; }

    var current = state.players.filter(function (p) { return p.id === state.turn; })[0];
    if (!current || current.connected || current.id === state.you) {
      bar.classList.add('hidden');
      return;
    }

    var waited = current.offlineSince ? Date.now() - current.offlineSince : 0;
    var left = Math.ceil((state.skipAfterMs - waited) / 1000);
    bar.classList.remove('hidden');
    if (left > 0) {
      $('awol-text').textContent = current.name + ' dropped out — skippable in ' + left + 's';
      $('skip-btn').disabled = true;
    } else {
      $('awol-text').textContent = current.name + ' is AWOL.';
      $('skip-btn').disabled = false;
    }
  }

  function renderPlayers() {
    var wrap = $('players');
    wrap.innerHTML = '';
    state.players.forEach(function (p) {
      var card = document.createElement('div');
      card.className = 'player-card' +
        (p.id === state.turn ? ' is-turn' : '') +
        (p.id === state.you ? ' is-you' : '') +
        (p.connected ? '' : ' gone');
      var name = document.createElement('span');
      name.className = 'pname';
      name.textContent = p.name;
      var right = document.createElement('span');
      right.className = 'pmeta';
      var tiles = document.createElement('span');
      tiles.className = 'ptiles';
      tiles.textContent = p.tiles + '▮';
      tiles.title = p.tiles + ' tiles on their rack';
      var score = document.createElement('b');
      score.className = 'pscore';
      score.textContent = p.score;
      right.appendChild(tiles);
      right.appendChild(score);
      card.appendChild(name);
      card.appendChild(right);
      wrap.appendChild(card);
    });

    $('bag-count').textContent = state.bagCount;

    var banner = $('turn-banner');
    var yourTurn = state.turn === state.you;
    if (state.over) {
      banner.textContent = 'GAME OVER';
      banner.className = '';
    } else if (state.players.length < 2) {
      banner.textContent = 'WAITING FOR A BUDDY…';
      banner.className = '';
    } else if (yourTurn) {
      banner.textContent = '★ YOUR TURN ★';
      banner.className = 'your-turn';
    } else {
      var current = state.players.filter(function (p) { return p.id === state.turn; })[0];
      banner.textContent = (current ? current.name : '???') + "'S TURN";
      banner.className = '';
    }
  }

  function renderBoard() {
    var cells = $('board').children;
    for (var r = 0; r < SIZE; r += 1) {
      for (var c = 0; c < SIZE; c += 1) {
        var cell = cells[r * SIZE + c];
        var placed = state.board[r][c];
        var provisional = findPending(r, c);
        cell.innerHTML = '';
        cell.classList.remove('target');
        cell.classList.toggle('filled', Boolean(placed || provisional));

        if (placed) {
          cell.appendChild(tileEl(placed.letter, placed.blank, placed.fresh ? 'fresh' : ''));
        } else if (provisional) {
          cell.appendChild(tileEl(provisional.letter, provisional.blank, 'pending'));
        } else {
          var prem = PREMIUM_ROWS[r][c];
          cell.textContent = (r === 7 && c === 7) ? '' : PREMIUM_LABEL[prem];
          // Only nudge the player toward the star on an empty board.
          if (selectedRackIdx >= 0 && state.moveCount === 0 && r === 7 && c === 7) {
            cell.classList.add('target');
          }
        }
      }
    }
  }

  function renderRack() {
    var rack = $('rack');
    rack.innerHTML = '';
    var letters = orderedRack();
    letters.forEach(function (letter, idx) {
      var used = pending.filter(function (p) { return p.rackIdx === idx; }).length > 0;
      var el = tileEl(letter, letter === '?', used ? 'spent' : '');
      if (idx === selectedRackIdx) el.classList.add('selected');
      el.addEventListener('click', function () {
        selectedRackIdx = (selectedRackIdx === idx) ? -1 : idx;
        render();
      });
      rack.appendChild(el);
    });

    var preview = $('pending-score');
    if (pending.length === 0) {
      preview.classList.add('hidden');
    } else {
      preview.classList.remove('hidden');
      preview.textContent = pending.length + ' tile(s) placed · ≈ ' + estimateScore() + ' pts';
    }
  }

  function orderedRack() {
    var letters = state ? state.yourRack.slice() : [];
    if (!rackOrder || rackOrder.length !== letters.length) return letters;
    // Apply the local shuffle where it still matches the rack contents.
    var pool = letters.slice();
    var out = [];
    for (var i = 0; i < rackOrder.length; i += 1) {
      var idx = pool.indexOf(rackOrder[i]);
      if (idx === -1) { out = null; break; }
      out.push(pool.splice(idx, 1)[0]);
    }
    return out && pool.length === 0 ? out : letters;
  }

  function renderDictionary() {
    var words = Object.keys(state.customDictionary);
    $('dict-count').textContent = '(' + words.length + ')';
    var list = $('dict-list');
    list.innerHTML = '';
    if (words.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'muted';
      empty.textContent = 'No made-up words yet. Boring!';
      list.appendChild(empty);
      return;
    }
    words.forEach(function (word) {
      var li = document.createElement('li');
      var uses = state.customDictionary[word].uses;
      li.textContent = word + (uses === 0 ? ' ✨1/letter' : ' ×' + uses);
      if (uses === 0) li.className = 'fresh-word';
      list.appendChild(li);
    });
  }

  function renderControls() {
    var yourTurn = state.turn === state.you && !state.over;
    var blocked = Boolean(state.pendingWord || state.pendingTrade);
    $('play-btn').disabled = !yourTurn || blocked || pending.length === 0;
    $('pass-btn').disabled = !yourTurn || blocked;
    $('swap-btn').disabled = !yourTurn || blocked || state.bagCount === 0;
    $('recall-btn').disabled = pending.length === 0;
    $('trade-btn').disabled = state.over || blocked || state.players.length < 2;
  }

  // -----------------------------------------------------------
  // Placement handling
  // -----------------------------------------------------------

  function findPending(row, col) {
    return pending.filter(function (p) { return p.row === row && p.col === col; })[0] || null;
  }

  function onBoardClick(event) {
    var cell = event.target.closest ? event.target.closest('.cell') : null;
    if (!cell || !state) return;
    var row = Number(cell.dataset.row);
    var col = Number(cell.dataset.col);

    // Tapping a provisional tile takes it back.
    var existing = findPending(row, col);
    if (existing) {
      pending = pending.filter(function (p) { return p !== existing; });
      render();
      return;
    }

    if (state.board[row][col]) return;
    if (state.turn !== state.you) { toast('Hold up — not your turn.'); return; }
    if (selectedRackIdx < 0) { toast('Pick a tile from your rack first.'); return; }

    var letters = orderedRack();
    var letter = letters[selectedRackIdx];
    if (letter === '?') {
      blankTarget = { row: row, col: col, rackIdx: selectedRackIdx };
      $('blank-modal').classList.remove('hidden');
      return;
    }

    place(row, col, letter, false, selectedRackIdx);
  }

  function place(row, col, letter, blank, rackIdx) {
    pending.push({ row: row, col: col, letter: letter, blank: blank, rackIdx: rackIdx });
    // Deliberately no auto-advance: the next tap should always mean
    // "select this tile", never "deselect the one I just guessed".
    selectedRackIdx = -1;
    render();
  }

  /** Drop provisional tiles once the server confirms something on those squares. */
  function reconcilePending() {
    if (pending.length === 0) return;
    var collides = pending.some(function (p) { return state.board[p.row][p.col]; });
    var rackShrank = pending.length > state.yourRack.length;
    if (collides || rackShrank) {
      pending = [];
      selectedRackIdx = -1;
    }
  }

  /** Rough local score preview — cross-words are not counted. */
  function estimateScore() {
    if (pending.length === 0) return 0;
    var sum = 0;
    var wordMult = 1;
    pending.forEach(function (p) {
      var prem = PREMIUM_MULT[PREMIUM_ROWS[p.row][p.col]];
      sum += (p.blank ? 0 : (TILE_VALUES[p.letter] || 0)) * prem.letter;
      wordMult *= prem.word;
    });
    // Letters already on the board that sit in the same line.
    var rows = {};
    var cols = {};
    pending.forEach(function (p) { rows[p.row] = true; cols[p.col] = true; });
    var sameRow = Object.keys(rows).length === 1;
    var line = sameRow ? Number(Object.keys(rows)[0]) : Number(Object.keys(cols)[0]);
    var spots = pending.map(function (p) { return sameRow ? p.col : p.row; });
    var lo = Math.min.apply(null, spots);
    var hi = Math.max.apply(null, spots);
    for (var i = lo; i <= hi; i += 1) {
      var cell = sameRow ? state.board[line][i] : state.board[i][line];
      if (cell) sum += cell.value;
    }
    return sum * wordMult + (pending.length >= 7 ? 50 : 0);
  }

  // -----------------------------------------------------------
  // Controls
  // -----------------------------------------------------------

  function wireControls() {
    $('play-btn').addEventListener('click', function () {
      if (pending.length === 0) return;
      socket.emit('play_word', roomId, {
        placements: pending.map(function (p) {
          return { row: p.row, col: p.col, letter: p.letter, blank: p.blank };
        })
      });
    });

    $('recall-btn').addEventListener('click', function () {
      pending = [];
      selectedRackIdx = -1;
      render();
    });

    $('shuffle-btn').addEventListener('click', function () {
      if (!state) return;
      pending = [];
      selectedRackIdx = -1;
      var letters = state.yourRack.slice();
      for (var i = letters.length - 1; i > 0; i -= 1) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = letters[i]; letters[i] = letters[j]; letters[j] = tmp;
      }
      rackOrder = letters;
      render();
    });

    $('pass-btn').addEventListener('click', function () {
      if (!confirm('Pass your turn? Weak.')) return;
      pending = [];
      socket.emit('pass_turn', roomId);
    });

    $('swap-btn').addEventListener('click', function () {
      swapPicks = [];
      renderSwapGrid();
      $('swap-modal').classList.remove('hidden');
    });

    $('swap-confirm').addEventListener('click', function () {
      if (swapPicks.length === 0) { toast('Pick at least one dud.'); return; }
      socket.emit('swap_tiles', roomId, swapPicks.map(function (i) { return orderedRack()[i]; }));
      $('swap-modal').classList.add('hidden');
      pending = [];
    });

    $('trade-btn').addEventListener('click', function () {
      tradeLetter = null;
      Array.prototype.forEach.call($('letter-grid').children, function (btn) {
        btn.classList.remove('picked');
      });
      $('trade-modal').classList.remove('hidden');
    });

    $('trade-points').addEventListener('input', function () {
      $('points-label').textContent = this.value;
      $('cost-preview').textContent = this.value;
      $('gain-preview').textContent = this.value;
    });

    $('trade-send').addEventListener('click', function () {
      if (!tradeLetter) { toast('Pick a letter to beg for.'); return; }
      socket.emit('request_trade', roomId, tradeLetter, Number($('trade-points').value));
      $('trade-modal').classList.add('hidden');
      toast('Paging opponent… *beep beep*');
    });

    $('offer-accept').addEventListener('click', function () {
      socket.emit('accept_trade', roomId);
      $('offer-modal').classList.add('hidden');
    });
    $('offer-reject').addEventListener('click', function () {
      socket.emit('reject_trade', roomId);
      $('offer-modal').classList.add('hidden');
    });

    $('vote-yes').addEventListener('click', function () {
      socket.emit('vote_result', roomId, { approved: true });
      $('vote-modal').classList.add('hidden');
    });
    $('vote-no').addEventListener('click', function () {
      socket.emit('vote_result', roomId, { approved: false });
      $('vote-modal').classList.add('hidden');
    });

    $('chat-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = $('chat-input');
      var text = input.value.trim();
      if (!text) return;
      socket.emit('chat', roomId, text);
      input.value = '';
    });

    $('skip-btn').addEventListener('click', function () {
      socket.emit('skip_player', roomId);
    });

    $('rematch-btn').addEventListener('click', function () {
      socket.emit('rematch', roomId);
    });

    $('copy-link').addEventListener('click', copyLink);

    // Eligibility to skip an absent player depends on elapsed time alone.
    setInterval(renderAwol, 1000);

    document.addEventListener('click', function (e) {
      var target = e.target.dataset ? e.target.dataset.close : null;
      if (target) $(target).classList.add('hidden');
    });
  }

  function buildLetterGrids() {
    var letterGrid = $('letter-grid');
    ALPHABET.forEach(function (letter) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'letter-key';
      btn.textContent = letter;
      btn.addEventListener('click', function () {
        tradeLetter = letter;
        Array.prototype.forEach.call(letterGrid.children, function (el) { el.classList.remove('picked'); });
        btn.classList.add('picked');
      });
      letterGrid.appendChild(btn);
    });

    var blankGrid = $('blank-grid');
    ALPHABET.forEach(function (letter) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'letter-key';
      btn.textContent = letter;
      btn.addEventListener('click', function () {
        if (!blankTarget) return;
        place(blankTarget.row, blankTarget.col, letter, true, blankTarget.rackIdx);
        blankTarget = null;
        $('blank-modal').classList.add('hidden');
      });
      blankGrid.appendChild(btn);
    });
  }

  function renderSwapGrid() {
    var grid = $('swap-grid');
    grid.innerHTML = '';
    orderedRack().forEach(function (letter, idx) {
      var el = tileEl(letter, letter === '?', '');
      el.addEventListener('click', function () {
        var at = swapPicks.indexOf(idx);
        if (at === -1) { swapPicks.push(idx); el.classList.add('picked'); }
        else { swapPicks.splice(at, 1); el.classList.remove('picked'); }
      });
      grid.appendChild(el);
    });
  }

  function copyLink() {
    var url = window.location.origin + window.location.pathname + '?room=' + roomId;
    var done = function () { toast('Link copied! Send it to your buddy. 📠'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { window.prompt('Copy this link:', url); });
    } else {
      window.prompt('Copy this link:', url);
    }
  }

  // -----------------------------------------------------------
  // Log + toast
  // -----------------------------------------------------------

  function appendLog(text, kind) {
    var log = $('log');
    var p = document.createElement('p');
    p.className = kind || 'info';
    p.textContent = text;
    log.appendChild(p);
    while (log.children.length > 60) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  var toastTimer = null;
  function toast(message) {
    var el = $('toast');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 3200);
  }

  boot();
}());
