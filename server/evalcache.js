// Cache of engine evaluations for opening positions, keyed by engine name,
// MultiPV, and FEN, with the search depth stored per entry. Imports keep
// re-searching the same repertoire lines at full depth; the first CACHE_PLIES
// positions of every game are served from here on a repeat. An entry searched
// at least as deep as requested is accepted, so raising the depth setting
// keeps every deeper or equal entry and only re-searches the shallow ones.
// Per-machine derived data: lives next to the game files but is ignored by
// the data repo (see ensureDataIgnores) and is cheap to rebuild from scratch.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, writeJson } from './store.js';

export const CACHE_PLIES = 20; // only positions this early in a game are cached
const MAX_ENTRIES = 4000;      // insertion-ordered; oldest entries fall out first
const FILE = path.join(DATA_DIR, 'evalcache.json');

let loaded = null; // Map key -> { depth, bestmove, lines }
let dirty = false;
let flushTimer = null;
const FLUSH_MS = 3000;

async function load() {
  if (loaded) return loaded;
  try {
    loaded = migrate(JSON.parse(await fs.readFile(FILE, 'utf8')));
  } catch {
    loaded = new Map(); // missing or corrupt: start fresh, it is only a cache
  }
  return loaded;
}

/** Entries written before the depth moved into the value were keyed
 * `engine|depth|multipv|fen`; fold them onto the new key, keeping the deepest. */
function migrate(obj) {
  const map = new Map();
  for (const [key, value] of Object.entries(obj)) {
    const parts = key.split('|');
    let k = key, v = value;
    if (parts.length === 4 && /^\d+$/.test(parts[1]) && typeof value?.depth !== 'number') {
      k = `${parts[0]}|${parts[2]}|${parts[3]}`;
      v = { depth: Number(parts[1]), bestmove: value.bestmove, lines: value.lines };
    }
    if (typeof v?.depth !== 'number' || !Array.isArray(v.lines)) continue;
    const have = map.get(k);
    if (!have || have.depth < v.depth) map.set(k, v);
  }
  return map;
}

/** Position, side, castling, and en-passant only: the halfmove and fullmove
 * counters do not change the engine's evaluation, so dropping them lets
 * transpositions and repeated openings share one cache entry. */
function normalizeFen(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

export function evalCacheKey(engineName, multipv, fen) {
  return `${engineName}|${multipv}|${normalizeFen(fen)}`;
}

/** The cached search for a key when it was made at least `depth` deep, else null. */
export async function getCachedEval(key, depth) {
  const hit = (await load()).get(key);
  return hit && hit.depth >= depth ? hit : null;
}

/** Store a search; a shallower one never overwrites a deeper one. */
export async function putCachedEval(key, value) {
  const map = await load();
  const have = map.get(key);
  if (have && have.depth > value.depth) return;
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
