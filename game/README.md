# Y2K WORD SLAM

A mobile-friendly multiplayer word game you join by sharing a URL. Standard
crossword-tile rules, plus two house mechanics: a **trading economy** and a
**democratic dictionary**.

Node + Express + Socket.io on the back, HTML/CSS/vanilla JS on the front. No
build step, no framework, no database.

```
game/
├── server.js            ← Express + Socket.io wiring
├── src/
│   ├── constants.js     ← tile values, distribution, premium-square board
│   ├── dictionary.js    ← baseline word list loader
│   ├── store.js         ← saves games to disk so they survive restarts
│   └── game.js          ← rules engine (no sockets — unit tested)
├── public/
│   ├── index.html
│   ├── style.css        ← the neon crime scene
│   └── client.js
├── test/                ← node:test suites (engine + end-to-end sockets)
└── Dockerfile           ← for container hosts; see also ../render.yaml
```

## Running it

```bash
cd game
npm install
npm start          # http://localhost:3000
npm test           # 44 tests: rules engine, persistence, socket end-to-end
npm run dev        # restarts on file changes
```

Open the URL, and it drops you into a room with a generated code
(`?room=RAD42`). Hit **Copy Link to Invite Buddy** and send that link to
whoever you want to play. Two to four players per room.

Environment variables, all optional:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `game/data` | Where saved games are written |
| `ROOM_TTL_DAYS` | `30` | Days an untouched room is kept before sweeping |
| `ABANDON_SKIP_MS` | `120000` | How long a player must be offline before their turn can be skipped |

## The two house mechanics

### 1. Trading economy

Tap **PAGE OPPONENT**, pick a letter, and set a bounty of 1–25 points. The
offer pops up on everyone else's screen as a Windows 95 alert.

- If someone accepts, the tile moves to you and the points move to them:
  requester `−N`, accepter `+N`.
- The accepter draws a replacement from the bag, so they stay at seven tiles.
  **You** end up holding eight — the tile you begged for is an extra, and your
  rack only refills back down to seven after you play. Racks are capped at 10.
- The server verifies the accepter actually holds that letter and that the
  requester can still cover the bounty; either failing kills the deal.
- Offers expire after 90 seconds, and only one can be open at a time.
- Trading is free-running: you can page the table on anyone's turn.

Everyone starts at 50 points so trading is possible from the first move.

### 2. Democratic dictionary

The baseline is a ~270,000-word English list (from the `word-list` package,
filtered to 2–15 letter a–z entries). Play something outside it and, instead
of a rejection, every other player gets a vote:

> *Ace played "YEET". Not in the dictionary. Allow it?*

- **Allow it** → the word joins that room's dictionary permanently, and the
  move is scored and applied.
- **Talk to the hand** → the tiles come back and the turn stays with the
  player, who can try something else.
- The proposer cannot vote on their own word, and the first response settles
  it. Votes expire after 90 seconds.

### Scoring house-ruled words

A word that exists **only** in the room's custom dictionary scores a flat
**1 point per letter** the first time it is played — face values, letter
premiums and word premiums are all ignored. So `YEET` across the centre star
scores 4, not 14.

Every subsequent play of that word scores normally, at full face value with
premium squares. Cheap to invent, valuable to reuse.

## Everything else is standard

15×15 board with the usual premium-square layout, the standard 100-tile
English distribution including two blanks, first word must cross the centre
star, plays must line up and connect to existing tiles, cross-words are scored,
seven-tile plays get the 50-point bingo bonus, and unplayed racks are deducted
at the end (with the leftovers going to whoever went out).

The game ends when the bag is empty and someone plays their last tile, or after
six consecutive scoreless turns.

## Saving and resuming

Games are written to `game/data/games.json` (override with `DATA_DIR`) after
every move, so you can stop the server, reboot the machine, and pick the game
back up days later. Writes are debounced to one per burst of activity and go
through a temp file plus rename, so a crash mid-write cannot leave a truncated
save. `SIGINT`/`SIGTERM` flush before exiting, which means Ctrl+C is safe.

Bookmark the room URL (`.../?room=RAD42`). Reopening it drops you straight back
into your seat — no join screen, no re-entering your name.

Two things deliberately do **not** survive a restart: an open trade offer and a
word waiting on a vote. Both need an answer from someone who is no longer
connected, so restoring them would just deadlock the table. Everything else —
board, racks, scores, bag, turn order, house dictionary, chat log — comes back.

**If a browser forgets who you are** (cleared history, private browsing, a new
phone) you would normally be locked out of your own saved game, because seats
are keyed to an id in `localStorage`. So arriving at a room with empty seats
gets you a picker: *"I'm Wife — 50 pts · 7 tiles"* or *"deal me in"*. Claiming
a seat moves it onto your new id, keeping its score, rack and turn position.
Only seats nobody is currently connected to can be claimed — but note that
anyone with the room link could claim one, so treat the link as the only thing
guarding the game.

The `not you?` link in the room bar clears this device's identity, in case you
want to hand a phone to someone else.

## When someone walks away

Closing a tab does not forfeit your seat — you can come back to it. But an
absent player must not be able to freeze the table indefinitely, so once the
player whose turn it is has been offline for two minutes, everyone else gets a
**SKIP THEM** button with a live countdown. Skipping counts as a pass, which
means a fully abandoned game winds itself down to the six-pass ending rather
than hanging forever.

You cannot skip yourself, and you cannot skip someone who is still connected.

## Rematches

The game-over screen has **RUN IT BACK**: same room, same seats, same names,
fresh board and bag, scores back to 50. Whoever opened the last game does not
open the next one — the first move rotates.

The house dictionary carries over, with its use counts intact. Words the room
invented stay legal forever, but their one-point-per-letter debut is spent, so
they score full face value from then on. No re-farming the discount.

## Design notes

**Racks stay private.** The server builds a per-player view of the game
(`viewFor`) rather than broadcasting raw state, so nobody can read an
opponent's tiles out of a socket frame.

**The server owns the rules.** Clients send *placements* (square + letter);
the server re-validates the geometry, checks the tiles against the rack it
dealt, and computes the score. A pending vote is stored server-side and applied
from that stored copy, so a voter cannot smuggle different tiles into the
approval. The client's `≈ N pts` preview is a convenience estimate and is never
trusted.

**Seats survive reconnects.** Players are keyed by a UUID kept in
`localStorage`, not by socket id, so a phone that drops its connection or locks
its screen rejoins to the same seat, score and rack. When that id is gone
entirely, the seat picker above is the way back in.

**Rooms are files, not a database.** The whole `games` object is JSON-safe by
construction, so persistence is one `JSON.stringify` rather than a schema. That
holds fine for a handful of concurrent games; a busy server would want a real
store, and the seam for it is `src/store.js`. Rooms untouched for 30 days are
swept.

**Browser support.** The client is deliberately written in ES5-era syntax with
no build step, and every CSS feature used has been in Safari since version 15.
Where a modern API would help but is not available in an insecure context —
`crypto.randomUUID`, `navigator.clipboard` — there is a tested fallback, since
serving over plain `http://` on a LAN is a first-class way to play this.

## Deploying

This needs a real Node process holding WebSocket connections open. A static
host will not work, and neither will the repository's existing Vercel setup —
serverless functions cannot hold a socket open or keep the in-memory `games`
object alive between invocations. The Eleventy site and this game server deploy
to different places and do not interact; Eleventy only builds from `src/`.

**Render** (config included). `render.yaml` at the repository root is a Render
blueprint pointing at `game/`. In Render: New → Blueprint → pick this repo →
Apply. It installs with `npm ci --omit=dev`, starts with `npm start`, and
health-checks `/healthz`.

Watch out for the free plan's ephemeral filesystem: it is wiped on every
restart, redeploy and idle spin-down, so **saved games do not survive on the
free plan**. Keeping them needs a paid plan with a mounted disk and `DATA_DIR`
pointed at it — `render.yaml` carries the exact block to uncomment. If saving
matters more than a public URL, running on your own machine gives you
persistence for nothing.

**Anywhere else.** `game/Dockerfile` builds a self-contained image for Fly.io,
Railway, a VPS, or any container host:

```bash
cd game
docker build -t y2k-word-slam .
docker run -p 3000:3000 y2k-word-slam
```

**Quick test with no hosting at all.** Run it locally and tunnel:

```bash
npm start
cloudflared tunnel --url http://localhost:3000
```

That prints a public HTTPS URL you can text to someone. It lives as long as the
process does.

**Custom domain.** Prefer a subdomain (`game.theyardlab.com`) CNAME'd at the
Node host over a rewrite from the Vercel site — Vercel's external rewrites do
not reliably proxy the WebSocket upgrade.
