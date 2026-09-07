// Drills: positions from the player's own mistakes, scheduled with a small spaced-repetition ladder.
import { getDrills, saveDrills, getSettings, listGames, getGame } from './store.js';

const LADDER_DAYS = [1, 3, 7, 14, 30, 60];
const DAY = 86400000;

export function drillId(gameId, ply) {
  return `${gameId}:${ply}`;
}

/** Create or refresh drills for a game's critical moments at or above the drill threshold. */
export async function syncDrillsForGame(game, settings) {
  const store = await getDrills();
  const byId = new Map(store.drills.map(d => [d.id, d]));
  const threshold = settings.drillThreshold ?? 20;
  for (const ply of game.analysis.summary.moments) {
    const m = game.analysis.moves[ply - 1];
    if (m.loss < threshold) continue;
    const id = drillId(game.id, ply);
    const bestCp = m.lines[0]?.cp;
    const sign = m.color === 'white' ? 1 : -1;
    const accepted = m.lines
      .filter(l => bestCp != null && (bestCp - l.cp) * sign <= 30)
      .map(l => l.uci);
    const existing = byId.get(id);
    byId.set(id, {
      id,
      gameId: game.id,
      ply,
      fen: m.fenBefore,
      sideToMove: m.color,
      playedUci: m.uci,
      playedSan: m.san,
      bestUci: m.bestUci,
      bestSan: m.bestSan,
      acceptedUci: accepted.length ? accepted : [m.bestUci].filter(Boolean),
      lines: m.lines,
      phase: m.phase,
      judgment: m.judgment,
      loss: m.loss,
      label: `${game.headers.White || '?'} vs ${game.headers.Black || '?'}${game.headers.Date ? ', ' + game.headers.Date : ''}`,
      createdAt: existing?.createdAt || new Date().toISOString(),
      due: existing?.due || new Date().toISOString(),
      step: existing?.step ?? 0,
      reviews: existing?.reviews || [],
    });
  }
  store.drills = [...byId.values()];
  await saveDrills(store);
  return store;
}

/** Rebuild drills from every analysed game and prune drills whose game is gone.
 * Runs at startup: drills.json is per-machine (never synced between clones), so
 * each machine derives its own drill ladder from the shared game files while
 * keeping its local review history. */
export async function syncAllDrills() {
  const settings = await getSettings();
  const ids = new Set();
  for (const entry of await listGames()) {
    ids.add(entry.id);
    if (entry.status !== 'analysed' && entry.status !== 'explained') continue;
    const game = await getGame(entry.id);
    if (game?.analysis) await syncDrillsForGame(game, settings);
  }
  const store = await getDrills();
  const kept = store.drills.filter(d => ids.has(d.gameId));
  if (kept.length !== store.drills.length) {
    store.drills = kept;
    await saveDrills(store);
  }
}

export async function removeDrillsForGame(gameId) {
  const store = await getDrills();
  store.drills = store.drills.filter(d => d.gameId !== gameId);
  await saveDrills(store);
}

/** Record a review. grade: 'again' | 'good' | 'easy'. */
export async function reviewDrill(id, grade, correct) {
  const store = await getDrills();
  const d = store.drills.find(x => x.id === id);
  if (!d) throw new Error('drill not found');
  if (grade === 'again' || correct === false) d.step = 0;
  else if (grade === 'easy') d.step = Math.min(LADDER_DAYS.length - 1, d.step + 2);
  else d.step = Math.min(LADDER_DAYS.length - 1, d.step + 1);
  d.due = new Date(Date.now() + LADDER_DAYS[d.step] * DAY).toISOString();
  d.reviews.push({ at: new Date().toISOString(), grade, correct: !!correct });
  await saveDrills(store);
  return d;
}

export async function dueDrills(limit = 20) {
  const store = await getDrills();
  const now = Date.now();
  const due = store.drills.filter(d => Date.parse(d.due) <= now).sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
  return { due: due.slice(0, limit), total: store.drills.length, dueCount: due.length };
}
