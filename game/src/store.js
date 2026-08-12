// =============================================================
// PERSISTENCE
// =============================================================
// Games are plain JSON-safe objects, so the whole table just gets written to
// a file. Not a database — deliberately. It survives restarts and redeploys
// on any host with a real disk, which is what "finish the game tomorrow"
// actually needs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'games.json');
const TMP = `${FILE}.tmp`;
const FORMAT_VERSION = 1;

// Writes are debounced: a burst of moves produces one write, not twenty.
const SAVE_DEBOUNCE_MS = 750;
let pending = null;
let source = null;

/**
 * Read saved games back off disk.
 * Anything unreadable is reported and skipped rather than crashing the boot —
 * losing a game is bad, refusing to start is worse.
 */
function loadGames() {
  try {
    if (!fs.existsSync(FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw.version !== FORMAT_VERSION || typeof raw.games !== 'object' || !raw.games) {
      console.warn('[store] save file is in an unknown format — starting fresh.');
      return {};
    }

    const now = Date.now();
    for (const game of Object.values(raw.games)) {
      // Nobody is connected to a server that just booted.
      for (const player of Object.values(game.players ?? {})) {
        player.connected = false;
        // Restart the AWOL clock so a restart cannot instantly forfeit a turn.
        player.offlineSince = now;
      }
      // A vote or trade nobody can answer any more is just a deadlock.
      game.pendingWord = null;
      game.pendingTrade = null;
    }

    const count = Object.keys(raw.games).length;
    if (count > 0) console.log(`[store] restored ${count} game(s) from ${FILE}`);
    return raw.games;
  } catch (error) {
    console.warn(`[store] could not read ${FILE}: ${error.message} — starting fresh.`);
    return {};
  }
}

/** Write immediately, via a temp file so a crash mid-write cannot truncate it. */
function saveNow(games = source) {
  if (!games) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = JSON.stringify({ version: FORMAT_VERSION, savedAt: Date.now(), games });
    fs.writeFileSync(TMP, payload);
    fs.renameSync(TMP, FILE);
  } catch (error) {
    console.warn(`[store] save failed: ${error.message}`);
  }
}

/** Queue a save. Safe to call after every single state change. */
function scheduleSave(games) {
  source = games;
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    saveNow(games);
  }, SAVE_DEBOUNCE_MS);
  if (pending.unref) pending.unref();
}

/** Flush any queued write — call before the process exits. */
function flush() {
  if (pending) {
    clearTimeout(pending);
    pending = null;
  }
  saveNow();
}

export { loadGames, saveNow, scheduleSave, flush, FILE as SAVE_FILE };
