// Drills: positions from the player's own mistakes, scheduled with a small spaced-repetition ladder.
import { getDrills, saveDrills, getSettings, listGames, getGame } from './store.js';

const LADDER_DAYS = [1, 3, 7, 14, 30, 60];
const DAY = 86400000;

export function drillId(gameId, ply) {
  return `${gameId}:${ply}`;
}

/** Build one drill record for a moment, preserving spaced-repetition state from `existing`. */
function makeDrill(game, ply, tier, existing) {
  const m = game.analysis.moves[ply - 1];
  const e = game.explanations?.[ply];
  const bestCp = m.lines[0]?.cp;
  const sign = m.color === 'white' ? 1 : -1;
  const accepted = m.lines
    .filter(l => bestCp != null && (bestCp - l.cp) * sign <= 30)
    .map(l => l.uci);
  return {
    id: drillId(game.id, ply),
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
    tier, // 'core' (mistakes/blunders) or 'sharpen' (near-miss moments below the drill threshold)
    category: e?.category || existing?.category || null,
    pattern: e?.pattern || existing?.pattern || null,
    label: `${game.headers.White || '?'} vs ${game.headers.Black || '?'}${game.headers.Date ? ', ' + game.headers.Date : ''}`,
    createdAt: existing?.createdAt || new Date().toISOString(),
    due: existing?.due || new Date().toISOString(),
    step: existing?.step ?? 0,
    reviews: existing?.reviews || [],
  };
}

/** Punish drill for a scout game: the position AFTER the subject's mistake, with
 * the student to move. The answer lines are the next ply's stored MultiPV, so no
 * extra engine work is needed. Returns null when the mistake ended the game. */
function makePunishDrill(game, ply, tier, existing) {
  const m = game.analysis.moves[ply - 1]; // the subject's mistake
  const next = game.analysis.moves[ply];  // the reply position: student to move
  if (!next?.lines?.length) return null;
  const e = game.explanations?.[ply];
  const bestCp = next.lines[0]?.cp;
  const sign = next.color === 'white' ? 1 : -1;
  const accepted = next.lines
    .filter(l => bestCp != null && (bestCp - l.cp) * sign <= 30)
    .map(l => l.uci);
  return {
    id: drillId(game.id, ply),
    kind: 'punish',
    subject: game.subject || null,
    gameId: game.id,
    ply,
    fen: m.fenAfter,
    sideToMove: next.color,
    mistakeSan: m.san,
    playedUci: next.uci, // what was actually played against it in the game
    playedSan: next.san,
    bestUci: next.bestUci,
    bestSan: next.bestSan,
    acceptedUci: accepted.length ? accepted : [next.bestUci].filter(Boolean),
    lines: next.lines,
    phase: m.phase,
    judgment: m.judgment,
    loss: m.loss,
    tier,
    category: e?.category || existing?.category || null,
    pattern: e?.pattern || existing?.pattern || null,
    label: `vs ${game.subject || '?'}: ${game.headers.White || '?'} vs ${game.headers.Black || '?'}${game.headers.Date ? ', ' + game.headers.Date : ''}`,
    createdAt: existing?.createdAt || new Date().toISOString(),
    due: existing?.due || new Date().toISOString(),
    step: existing?.step ?? 0,
    reviews: existing?.reviews || [],
  };
}

/** Create or refresh drills for a game's critical moments: every moment becomes a
 * drill, tiered 'core' at or above the drill threshold, 'sharpen' below it.
 * Own games drill the player's mistakes; scout games drill their punishment. */
export async function syncDrillsForGame(game, settings) {
  const store = await getDrills();
  const byId = new Map(store.drills.map(d => [d.id, d]));
  const threshold = settings.drillThreshold ?? 20;
  const scout = (game.purpose || 'own') === 'scout';
  for (const ply of game.analysis.summary.moments) {
    const m = game.analysis.moves[ply - 1];
    const tier = m.loss >= threshold ? 'core' : 'sharpen';
    const id = drillId(game.id, ply);
    const drill = scout ? makePunishDrill(game, ply, tier, byId.get(id)) : makeDrill(game, ply, tier, byId.get(id));
    if (drill) byId.set(id, drill);
  }
  store.drills = [...byId.values()];
  await saveDrills(store);
  return store;
}

/** Record a guess-first attempt from the game view (per-machine, like reviews).
 * A correct first-try guess starts the drill higher up the ladder: the player
 * already knows this one, so it should not come back tomorrow. */
export async function recordGuess(game, ply, uci, correct, settings) {
  const store = await getDrills();
  const key = drillId(game.id, ply);
  const prior = store.guesses[key] || [];
  const firstTry = prior.length === 0;
  store.guesses[key] = [...prior, { at: new Date().toISOString(), uci, correct }].slice(-20);
  let drill = store.drills.find(d => d.id === key);
  let seeded = false;
  if (!drill) {
    const threshold = settings.drillThreshold ?? 20;
    const m = game.analysis.moves[ply - 1];
    const tier = m.loss >= threshold ? 'core' : 'sharpen';
    drill = (game.purpose || 'own') === 'scout' ? makePunishDrill(game, ply, tier, null) : makeDrill(game, ply, tier, null);
    if (!drill) { await saveDrills(store); return { seeded: false }; }
    store.drills.push(drill);
    seeded = true;
  }
  if (correct && firstTry && drill.reviews.length === 0) {
    drill.step = Math.max(drill.step, 2);
    drill.due = new Date(Date.now() + LADDER_DAYS[drill.step] * DAY).toISOString();
  }
  await saveDrills(store);
  return { seeded, step: drill.step, due: drill.due };
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

/** Record a review. grade: 'again' | 'good' | 'easy'. A failed drill stays due
 * today (retried at the end of the session); the ladder only advances after a
 * same-day pass. */
export async function reviewDrill(id, grade, correct) {
  const store = await getDrills();
  const d = store.drills.find(x => x.id === id);
  if (!d) throw new Error('drill not found');
  if (grade === 'again' || correct === false) {
    d.step = 0;
    d.due = new Date().toISOString(); // due now: it comes back at the end of this session
  } else {
    if (grade === 'easy') d.step = Math.min(LADDER_DAYS.length - 1, d.step + 2);
    else d.step = Math.min(LADDER_DAYS.length - 1, d.step + 1);
    d.due = new Date(Date.now() + LADDER_DAYS[d.step] * DAY).toISOString();
  }
  d.reviews.push({ at: new Date().toISOString(), grade, correct: !!correct });
  await saveDrills(store);
  return d;
}

/** Due drills, core tier first, then near-miss sharpeners. */
export async function dueDrills(limit = 20) {
  const store = await getDrills();
  const now = Date.now();
  const rank = d => (d.tier === 'sharpen' ? 1 : 0);
  const due = store.drills.filter(d => Date.parse(d.due) <= now)
    .sort((a, b) => rank(a) - rank(b) || Date.parse(a.due) - Date.parse(b.due));
  return { due: due.slice(0, limit), total: store.drills.length, dueCount: due.length };
}
