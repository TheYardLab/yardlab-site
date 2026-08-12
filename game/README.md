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
npm test           # 34 tests: rules engine + socket end-to-end
npm run dev        # restarts on file changes
```

Open the URL, and it drops you into a room with a generated code
(`?room=RAD42`). Hit **Copy Link to Invite Buddy** and send that link to
whoever you want to play. Two to four players per room.

`PORT` is read from the environment; everything else is zero-config.
`ABANDON_SKIP_MS` (default two minutes) tunes how long a player has to be
offline before the table can skip their turn.

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
its screen rejoins to the same seat, score and rack. Clearing site data loses
the seat, though: the player rejoins as a new one and the abandoned seat still
counts toward the four-player cap.

**Rooms are in memory.** Restarting the server clears every game. Empty rooms
are swept after two hours. Persistence would mean swapping the `games` object
for a store; nothing else in the design assumes memory.

## Deploying

This needs a real Node process holding WebSocket connections open. A static
host will not work, and neither will the repository's existing Vercel setup —
serverless functions cannot hold a socket open or keep the in-memory `games`
object alive between invocations. The Eleventy site and this game server deploy
to different places and do not interact; Eleventy only builds from `src/`.

**Render** (config included). `render.yaml` at the repository root is a Render
blueprint pointing at `game/`. In Render: New → Blueprint → pick this repo →
Apply. It installs with `npm ci --omit=dev`, starts with `npm start`, and
health-checks `/healthz`. The free plan sleeps when idle, which will drop any
game in progress — see the persistence note below.

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

**A note on persistence.** Games are held in memory, so a restart, a redeploy,
or a free-tier idle-sleep wipes every board in progress. That is fine for games
played in one sitting and not fine for play-by-text over days. Fixing it means
swapping the `games` object for a store; nothing else in the design assumes
memory.

**Custom domain.** Prefer a subdomain (`game.theyardlab.com`) CNAME'd at the
Node host over a rewrite from the Vercel site — Vercel's external rewrites do
not reliably proxy the WebSocket upgrade.
