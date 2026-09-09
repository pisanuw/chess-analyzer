// Cache of engine evaluations for opening positions, keyed by engine name,
// depth, MultiPV, and FEN. Imports keep re-searching the same repertoire
// lines at full depth; the first CACHE_PLIES positions of every game are
// served from here on a repeat. Per-machine derived data: lives next to the
// game files but is ignored by the data repo (see ensureDataIgnores) and is
// cheap to rebuild from scratch.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, writeJson } from './store.js';

export const CACHE_PLIES = 20; // only positions this early in a game are cached
const MAX_ENTRIES = 4000;      // insertion-ordered; oldest entries fall out first
const FILE = path.join(DATA_DIR, 'evalcache.json');

let loaded = null; // Map key -> { bestmove, lines }
let dirty = false;
let flushTimer = null;
const FLUSH_MS = 3000;

async function load() {
  if (loaded) return loaded;
  try {
    loaded = new Map(Object.entries(JSON.parse(await fs.readFile(FILE, 'utf8'))));
  } catch {
    loaded = new Map(); // missing or corrupt: start fresh, it is only a cache
  }
  return loaded;
}

/** Position, side, castling, and en-passant only: the halfmove and fullmove
 * counters do not change the engine's evaluation, so dropping them lets
 * transpositions and repeated openings share one cache entry. */
function normalizeFen(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

export function evalCacheKey(engineName, depth, multipv, fen) {
  return `${engineName}|${depth}|${multipv}|${normalizeFen(fen)}`;
}

export async function getCachedEval(key) {
  return (await load()).get(key) || null;
}

export async function putCachedEval(key, value) {
  const map = await load();
  map.delete(key); // refresh insertion order so busy lines stay resident
  map.set(key, value);
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
  // Mutate in memory now; persist on a debounce (and at job end) instead of
  // re-serializing the whole map on every miss.
  dirty = true;
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushCache().catch(() => {}); }, FLUSH_MS);
  flushTimer.unref?.(); // never hold the process open just for a cache write
}

/** Persist the cache now if it changed. Called on the debounce timer and at the
 * end of an analysis job, so a crash loses at most the last few misses (the
 * cache is cheap to rebuild and is never synced). */
export async function flushCache() {
  if (!dirty || !loaded) return;
  dirty = false;
  await writeJson(FILE, Object.fromEntries(loaded));
}
