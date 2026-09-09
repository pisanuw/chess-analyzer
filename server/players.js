// A local name <-> FIDE id map, built from FIDE ids that are already present in
// PGN tags (tournament exports carry them) and from scouted book imports. It is
// the stable key that links the player's own games to an opponent's scout book
// and survives the name-spelling drift that a name-only match cannot. No network
// here: associations only come from data the user already imported. Resolving an
// id for a player who has no tag anywhere is the opt-in FIDE-lookup step, later.
import { fideIdFromHeaders } from './pgn.js';
import { getPlayers, savePlayers, listGames, listScoutBooks } from './store.js';

const norm = s => (s || '').trim().toLowerCase();

/** normalized name -> Set(fideId). A name mapping to more than one id is a
 * homonym and must not be resolved automatically. */
export function indexByName(map) {
  const idx = new Map();
  for (const [id, p] of Object.entries(map || {})) {
    for (const n of p.names || []) {
      const k = norm(n);
      if (!k) continue;
      if (!idx.has(k)) idx.set(k, new Set());
      idx.get(k).add(id);
    }
  }
  return idx;
}

/** The FIDE id for a name, only when it is unambiguous (exactly one id). */
export function lookupFideId(map, name) {
  const ids = indexByName(map).get(norm(name));
  return ids && ids.size === 1 ? [...ids][0] : null;
}

/** The {fideId, name} pairs a game's tags assert (zero, one, or two). */
export function assocsFromHeaders(headers) {
  const out = [];
  for (const color of ['white', 'black']) {
    const fideId = fideIdFromHeaders(headers, color);
    const name = color === 'white' ? headers.White : headers.Black;
    if (fideId && name) out.push({ fideId, name });
  }
  return out;
}

/** Merge name->id associations into the map in place; returns how many new
 * (id, name) pairs were learned. */
export function mergeAssociations(map, assocs, now) {
  let learned = 0;
  for (const { fideId, name, federation } of assocs) {
    if (!/^\d{3,}$/.test(String(fideId || '')) || !name) continue;
    const id = String(fideId);
    const p = map[id] || (map[id] = { fideId: id, names: [], updatedAt: '' });
    if (!p.names.some(n => norm(n) === norm(name))) { p.names.push(name); learned++; }
    if (federation && !p.federation) p.federation = federation;
    p.updatedAt = now;
  }
  return learned;
}

/** Learn associations (from import or a book) and persist if anything changed. */
export async function recordAssociations(assocs, now = new Date().toISOString()) {
  if (!assocs.length) return 0;
  const map = await getPlayers();
  const learned = mergeAssociations(map, assocs, now);
  if (learned) await savePlayers(map);
  return learned;
}

/** Backfill the map from everything already imported, so games and books that
 * predate this map contribute their ids. Cheap: the game index already carries
 * the FIDE tags (no full-file reads). Called once at startup. */
export async function syncPlayers(now = new Date().toISOString()) {
  const assocs = [];
  for (const g of await listGames()) {
    if (g.whiteFideId && g.white) assocs.push({ fideId: g.whiteFideId, name: g.white });
    if (g.blackFideId && g.black) assocs.push({ fideId: g.blackFideId, name: g.black });
  }
  for (const b of await listScoutBooks()) if (b.fideId && b.name) assocs.push({ fideId: b.fideId, name: b.name });
  const map = await getPlayers();
  const learned = mergeAssociations(map, assocs, now);
  if (learned) await savePlayers(map);
  return learned;
}
