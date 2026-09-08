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

async function load() {
  if (loaded) return loaded;
  try {
    loaded = new Map(Object.entries(JSON.parse(await fs.readFile(FILE, 'utf8'))));
  } catch {
    loaded = new Map(); // missing or corrupt: start fresh, it is only a cache
  }
  return loaded;
}

export function evalCacheKey(engineName, depth, multipv, fen) {
  return `${engineName}|${depth}|${multipv}|${fen}`;
}

export async function getCachedEval(key) {
  return (await load()).get(key) || null;
}

export async function putCachedEval(key, value) {
  const map = await load();
  map.delete(key); // refresh insertion order so busy lines stay resident
  map.set(key, value);
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
  await writeJson(FILE, Object.fromEntries(map));
}
