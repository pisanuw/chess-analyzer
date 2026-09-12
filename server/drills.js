// Drills: positions from the player's own mistakes, scheduled with a small spaced-repetition ladder.
import { getDrills, saveDrills, getSettings, listGames, listAllGames, getGameCached, DrillConflict, DEFAULT_USER } from './store.js';
import { winProb, WP_ACCEPT, normalizeKey } from '../public/shared.js';

const LADDER_DAYS = [1, 3, 7, 14, 30, 60];
const DAY = 86400000;

/** UCI moves of the lines close enough to best. `sign` converts the stored
 * White-perspective cp to the mover's perspective. */
export function acceptedLines(lines, sign) {
  const best = lines[0];
  if (best?.cp == null) return [];
  // When the best move forces mate, winProb saturates near 100% and the band
  // would accept any clearly-winning-but-not-mating move. Require another mate
  // for the same side instead. Stored `mate` is from the side to move (the
  // mover), so its sign already reads from the mover's perspective.
  if (best.mate != null) {
    const moverMates = best.mate > 0;
    return lines.filter(l => l.mate != null && (l.mate > 0) === moverMates).map(l => l.uci);
  }
  const bestWp = winProb(best.cp * sign);
  return lines.filter(l => l.cp != null && bestWp - winProb(l.cp * sign) <= WP_ACCEPT).map(l => l.uci);
}

// All drill-store mutations run through one chain: the store is a single JSON
// file read-modified-written whole, so concurrent mutations (job sync vs a
// review vs a delete) would silently drop each other's changes otherwise.
// On the hosted store the chain cannot serialize other function instances, so
// a write can lose a compare-and-swap race (DrillConflict from saveDrills);
// re-running fn re-reads the store and reapplies the mutation.
let chain = Promise.resolve();
function locked(fn) {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); } catch (err) {
        if (!(err instanceof DrillConflict) || attempt >= 2) throw err;
      }
    }
  };
  const p = chain.then(run, run);
  chain = p.then(() => {}, () => {});
  return p;
}

export function drillId(gameId, ply) {
  return `${gameId}:${ply}`;
}

export function threatDrillId(gameId, ply) {
  return `${gameId}:${ply}:threat`;
}

export function openingDrillId(gameId, ply) {
  return `${gameId}:${ply}:opening`;
}

/** A tactics-allowed moment gets a second drill: see the threat you missed.
 * Needs the analysed reply position (the punishment) to exist. */
export function wantsThreatDrill(game, ply) {
  return (game.purpose || 'own') !== 'scout'
    && game.explanations?.[ply]?.category === 'tactics-allowed'
    && !!game.analysis.moves[ply]?.lines?.length;
}

/** The first opening move where preparation visibly ran out (left the engine's
 * list or lost 10+ points) AND it cost something real (5+ win-prob points)
 * without already being a critical moment. One per game: the "your prep ended
 * here, what is the move" flashcard. Returns the ply or null. */
export function openingDrillPly(game) {
  if ((game.purpose || 'own') === 'scout') return null;
  const moments = new Set(game.analysis.summary.moments);
  const dev = game.analysis.moves.find(m => m.isPlayer && m.phase === 'opening'
    && (m.playedRank == null || m.loss >= 10));
  if (!dev || dev.loss < 5 || moments.has(dev.ply)) return null;
  return dev.ply;
}

function makeOpeningDrill(game, ply, existing) {
  const d = makeDrill(game, ply, 'opening', existing);
  return { ...d, id: openingDrillId(game.id, ply), kind: 'opening' };
}

/** Build one drill record for a moment, preserving spaced-repetition state from `existing`. */
function makeDrill(game, ply, tier, existing) {
  const m = game.analysis.moves[ply - 1];
  const e = game.explanations?.[ply];
  const accepted = acceptedLines(m.lines, m.color === 'white' ? 1 : -1);
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
    clock: m.clock ?? null, // seconds left after the mistake: the time situation the position was played in
    tier, // 'core' (mistakes/blunders) or 'sharpen' (near-miss moments below the drill threshold)
    category: e?.category || existing?.category || null,
    pattern: e?.pattern || existing?.pattern || null,
    timePressure: e?.time_pressure ?? existing?.timePressure ?? false,
    ...(existing?.suspended ? { suspended: true } : {}),
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
  const accepted = acceptedLines(next.lines, next.color === 'white' ? 1 : -1);
  return {
    id: drillId(game.id, ply),
    kind: 'punish',
    subject: game.subject || null,
    subjectColor: m.color, // the colour the subject erred in: a prep round asks for one colour only
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
    clock: m.clock ?? null, // the subject's clock when they erred: context for how the mistake happened
    tier,
    category: e?.category || existing?.category || null,
    pattern: e?.pattern || existing?.pattern || null,
    timePressure: e?.time_pressure ?? existing?.timePressure ?? false,
    ...(existing?.suspended ? { suspended: true } : {}),
    label: `vs ${game.subject || '?'}: ${game.headers.White || '?'} vs ${game.headers.Black || '?'}${game.headers.Date ? ', ' + game.headers.Date : ''}`,
    createdAt: existing?.createdAt || new Date().toISOString(),
    due: existing?.due || new Date().toISOString(),
    step: existing?.step ?? 0,
    reviews: existing?.reviews || [],
  };
}

/** Threat drill for an own-game tactics-allowed moment: the position AFTER the
 * player's mistake, played from the OPPONENT's side. The failure was not seeing
 * what the move allowed, so the drill is to find the punishment the opponent
 * had; the answer lines are the next ply's stored MultiPV. The board stays
 * oriented from the player's own side: that is where threats must be seen. */
function makeThreatDrill(game, ply, tier, existing) {
  const m = game.analysis.moves[ply - 1]; // the player's mistake
  const next = game.analysis.moves[ply];  // the reply position: the threat lands
  if (!next?.lines?.length) return null;
  const e = game.explanations?.[ply];
  const accepted = acceptedLines(next.lines, next.color === 'white' ? 1 : -1);
  return {
    id: threatDrillId(game.id, ply),
    kind: 'threat',
    gameId: game.id,
    ply,
    fen: m.fenAfter,
    sideToMove: next.color,
    orientation: m.color, // see the threat from your own side of the board
    mistakeSan: m.san,
    playedUci: next.uci, // what the opponent actually played
    playedSan: next.san,
    bestUci: next.bestUci,
    bestSan: next.bestSan,
    acceptedUci: accepted.length ? accepted : [next.bestUci].filter(Boolean),
    lines: next.lines,
    phase: m.phase,
    judgment: m.judgment,
    loss: m.loss,
    clock: m.clock ?? null,
    tier,
    category: e?.category || existing?.category || null,
    pattern: e?.pattern || existing?.pattern || null,
    timePressure: e?.time_pressure ?? existing?.timePressure ?? false,
    ...(existing?.suspended ? { suspended: true } : {}),
    label: `${game.headers.White || '?'} vs ${game.headers.Black || '?'}${game.headers.Date ? ', ' + game.headers.Date : ''}`,
    createdAt: existing?.createdAt || new Date().toISOString(),
    due: existing?.due || new Date().toISOString(),
    step: existing?.step ?? 0,
    reviews: existing?.reviews || [],
  };
}

/** Create or refresh drills for a game's critical moments: every moment becomes a
 * drill, tiered 'core' at or above the drill threshold, 'sharpen' below it.
 * Own games drill the player's mistakes (plus a see-the-threat drill for
 * tactics-allowed moments); scout games drill their punishment. */
export function syncDrillsForGame(game, settings, userId = DEFAULT_USER) {
  return locked(() => syncGameUnlocked(game, settings, userId));
}

async function syncGameUnlocked(game, settings, userId = DEFAULT_USER, sharedStore = null) {
  // With sharedStore, mutate the caller's in-memory store and let the caller
  // save once: against the hosted (Supabase) store a per-game read+write is two
  // full-row network transfers, which made syncAllDrills crawl for many minutes.
  const store = sharedStore ?? await getDrills(userId);
  const byId = new Map(store.drills.map(d => [d.id, d]));
  const threshold = settings.drillThreshold ?? 20;
  const scout = (game.purpose || 'own') === 'scout';
  for (const ply of game.analysis.summary.moments) {
    const m = game.analysis.moves[ply - 1];
    const tier = m.loss >= threshold ? 'core' : 'sharpen';
    const id = drillId(game.id, ply);
    const drill = scout ? makePunishDrill(game, ply, tier, byId.get(id)) : makeDrill(game, ply, tier, byId.get(id));
    if (drill) byId.set(id, drill);
    if (!scout) {
      const tid = threatDrillId(game.id, ply);
      if (wantsThreatDrill(game, ply)) {
        const td = makeThreatDrill(game, ply, tier, byId.get(tid));
        if (td) byId.set(tid, td);
      } else {
        byId.delete(tid); // the explanation changed category: the threat drill no longer applies
      }
    }
  }
  if (!scout) {
    // Opening flashcard for the game's prep-end deviation; pruned when a
    // re-analysis or threshold change moves or removes the deviation.
    const devPly = openingDrillPly(game);
    for (const [id, d] of byId) {
      if (d.gameId === game.id && d.kind === 'opening' && (!devPly || id !== openingDrillId(game.id, devPly))) byId.delete(id);
    }
    if (devPly) {
      const oid = openingDrillId(game.id, devPly);
      byId.set(oid, makeOpeningDrill(game, devPly, byId.get(oid)));
    }
  }
  store.drills = [...byId.values()];
  if (!sharedStore) await saveDrills(store, userId);
  return store;
}

/** Record a guess-first attempt from the game view (per-machine, like reviews).
 * A correct first-try guess starts the drill higher up the ladder: the player
 * already knows this one, so it should not come back tomorrow. */
export function recordGuess(game, ply, uci, correct, settings, userId = DEFAULT_USER) {
  return locked(() => recordGuessUnlocked(game, ply, uci, correct, settings, userId));
}

async function recordGuessUnlocked(game, ply, uci, correct, settings, userId = DEFAULT_USER) {
  const store = await getDrills(userId);
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
    if (!drill) { await saveDrills(store, userId); return { seeded: false }; }
    store.drills.push(drill);
    seeded = true;
  }
  if (correct && firstTry && drill.reviews.length === 0) {
    // A correct first-try guess is thin evidence: one rep, on a position the
    // player got wrong in the real game. Seed one rung up, not two; a real
    // review (or a second success) moves it further.
    drill.step = Math.max(drill.step, 1);
    drill.due = new Date(Date.now() + LADDER_DAYS[drill.step] * DAY).toISOString();
  }
  await saveDrills(store, userId);
  return { seeded, step: drill.step, due: drill.due };
}

/** Rebuild drills from every analysed game and prune drills whose game is gone.
 * Runs at startup: drills.json is per-machine (never synced between clones), so
 * each machine derives its own drill ladder from the shared game files while
 * keeping its local review history. */
export function syncAllDrills(userId = DEFAULT_USER) {
  return locked(async () => {
    const settings = await getSettings();
    const validIds = new Set();   // drill ids that match a current moment
    const pendingGames = new Set(); // games mid-pipeline: keep their drills as-is
    const store = await getDrills(userId); // read once, sync every game in memory, write once
    for (const entry of await listGames(userId)) {
      if (entry.status !== 'analysed' && entry.status !== 'explained') { pendingGames.add(entry.id); continue; }
      const game = await getGameCached(entry);
      if (!game?.analysis) { pendingGames.add(entry.id); continue; }
      await syncGameUnlocked(game, settings, userId, store);
      for (const ply of game.analysis.summary.moments) {
        validIds.add(drillId(game.id, ply));
        if (wantsThreatDrill(game, ply)) validIds.add(threatDrillId(game.id, ply));
      }
      const devPly = openingDrillPly(game);
      if (devPly) validIds.add(openingDrillId(game.id, devPly));
    }
    // Prune drills for deleted games AND for plies that are no longer moments
    // (e.g. after a colour fix or re-analysis changed which side is tracked).
    store.drills = store.drills.filter(d => validIds.has(d.id) || pendingGames.has(d.gameId));
    await saveDrills(store, userId);
  });
}

export function removeDrillsForGame(gameId, userId = DEFAULT_USER) {
  return locked(async () => {
    const store = await getDrills(userId);
    store.drills = store.drills.filter(d => d.gameId !== gameId);
    await saveDrills(store, userId);
  });
}

/** Record a review. grade: 'again' | 'good' | 'easy'. A failed drill stays due
 * today (retried at the end of the session); the ladder only advances after a
 * same-day pass. Practice reviews (lightning and category rounds) are extra
 * reps outside the schedule: a miss still resets the drill (a miss is real
 * evidence), but a pass does not advance the ladder. `ms` is the time from
 * seeing the position to answering: recognition speed is the real signal of
 * pattern acquisition, and the raw material for fitting per-drill ease later. */
export function reviewDrill(id, grade, correct, practice = false, ms = null, userId = DEFAULT_USER) {
  return locked(() => reviewUnlocked(id, grade, correct, practice, ms, userId));
}

async function reviewUnlocked(id, grade, correct, practice, ms, userId = DEFAULT_USER) {
  const store = await getDrills(userId);
  const d = store.drills.find(x => x.id === id);
  if (!d) throw new Error('drill not found');
  const prev = { prevStep: d.step, prevDue: d.due }; // lets undoReview restore the ladder
  if (grade === 'again' || correct === false) {
    // Soften the lapse: drop two rungs, not all the way to day one. A single
    // slip on a mature drill should not erase months of spacing (the up-ladder
    // is gentle at +1/+2, so the down-step should be comparable). It still
    // comes back at the end of this session.
    d.step = Math.max(0, d.step - 2);
    d.due = new Date().toISOString(); // due now: it comes back at the end of this session
  } else if (!practice) {
    if (grade === 'easy') d.step = Math.min(LADDER_DAYS.length - 1, d.step + 2);
    else d.step = Math.min(LADDER_DAYS.length - 1, d.step + 1);
    d.due = new Date(Date.now() + LADDER_DAYS[d.step] * DAY).toISOString();
  }
  d.reviews.push({
    at: new Date().toISOString(), grade, correct: !!correct, ...prev,
    ...(practice ? { practice: true } : {}),
    ...(Number.isFinite(ms) && ms >= 0 ? { ms: Math.round(ms) } : {}),
  });
  await saveDrills(store, userId);
  return d;
}

/** Undo the last review of a drill (a fat-fingered grade): pop it and restore
 * the ladder position it recorded. Session stats are the caller's business. */
export function undoReview(id, userId = DEFAULT_USER) {
  return locked(async () => {
    const store = await getDrills(userId);
    const d = store.drills.find(x => x.id === id);
    if (!d) throw new Error('drill not found');
    const r = d.reviews.pop();
    if (!r) throw new Error('no review to undo');
    if (r.prevStep != null) { d.step = r.prevStep; d.due = r.prevDue; }
    await saveDrills(store, userId);
    return d;
  });
}

/** Park a drill (mis-tagged, trivial, or just resented): it leaves every queue
 * but keeps its history. Restoring makes it due now. */
export function suspendDrill(id, suspended = true, userId = DEFAULT_USER) {
  return locked(async () => {
    const store = await getDrills(userId);
    const d = store.drills.find(x => x.id === id);
    if (!d) throw new Error('drill not found');
    if (suspended) d.suspended = true;
    else { delete d.suspended; d.due = new Date().toISOString(); }
    await saveDrills(store, userId);
    return d;
  });
}

export function restoreSuspended(userId = DEFAULT_USER) {
  return locked(async () => {
    const store = await getDrills(userId);
    let n = 0;
    for (const d of store.drills) {
      if (!d.suspended) continue;
      delete d.suspended;
      d.due = new Date().toISOString();
      n++;
    }
    if (n) await saveDrills(store, userId);
    return n;
  });
}

/** Was this explanation useful? Stored per machine like reviews; the report
 * aggregates it so prompts can be tuned from real use. */
export function recordFeedback(gameId, ply, helpful, userId = DEFAULT_USER) {
  return locked(async () => {
    const store = await getDrills(userId);
    store.feedback[drillId(gameId, ply)] = { helpful: !!helpful, at: new Date().toISOString() };
    await saveDrills(store, userId);
    return store.feedback;
  });
}

/** Record a quiet-position (decoy) outcome. Decoys are ephemeral and never
 * graded into the ladder, but whether the player correctly recognises "nothing
 * is wrong here" is the discrimination half of the skill; keep a per-machine
 * tally so the report can show the false-positive rate. */
export function recordDecoy(correct, userId = DEFAULT_USER) {
  return locked(async () => {
    const store = await getDrills(userId);
    store.decoys = store.decoys || { seen: 0, right: 0 };
    store.decoys.seen++;
    if (correct) store.decoys.right++;
    await saveDrills(store, userId);
    return store.decoys;
  });
}

/** A prep-deck attempt (a line flashcard or a punish drill worked from the
 * Prepare page): a per-drill seen/right tally outside the ladder, so the page
 * can show how much of the deck has been done before the game. */
export function markPrep(id, correct, userId = DEFAULT_USER) {
  return locked(async () => {
    const store = await getDrills(userId);
    store.prep = store.prep || {};
    const m = store.prep[id] || { seen: 0, right: 0 };
    m.seen++;
    if (correct) m.right++;
    m.lastAt = new Date().toISOString();
    store.prep[id] = m;
    // Keep the map bounded: the oldest marks fall out past a generous cap.
    const ids = Object.keys(store.prep);
    if (ids.length > 2000) for (const k of ids.sort((a, b) => (store.prep[a].lastAt || '').localeCompare(store.prep[b].lastAt || '')).slice(0, ids.length - 2000)) delete store.prep[k];
    await saveDrills(store, userId);
    return m;
  });
}

/** Drop the vote on a moment (it was re-explained: the new text starts unrated). */
export function clearFeedback(gameId, ply, userId = DEFAULT_USER) {
  return locked(async () => {
    const store = await getDrills(userId);
    delete store.feedback[drillId(gameId, ply)];
    await saveDrills(store, userId);
  });
}

// About one decoy per this many real due drills in a session.
const DECOY_RATIO = 4;

/** Would this move make a decoy? A quiet position the player HANDLED: his move
 * was genuinely fine, but the stored lines show real ways to go wrong. */
function decoyCandidate(m, moments) {
  if (!m.isPlayer || moments.has(m.ply)) return false;
  if (m.judgment !== 'best') return false; // his move was genuinely fine
  if (m.ply <= 10) return false;           // skip rote opening moves
  if (!m.lines || m.lines.length < 2) return false;
  const sign = m.color === 'white' ? 1 : -1;
  const spread = winProb(m.lines[0].cp * sign) - winProb(m.lines[m.lines.length - 1].cp * sign);
  return spread >= 10;                     // wrong choices existed
}

function makeDecoy(game, m) {
  const accepted = acceptedLines(m.lines, m.color === 'white' ? 1 : -1);
  return {
    id: `${game.id}:${m.ply}:decoy`,
    kind: 'decoy',
    ephemeral: true, // never stored, never graded into the ladder
    gameId: game.id,
    ply: m.ply,
    fen: m.fenBefore,
    sideToMove: m.color,
    playedUci: m.uci,
    playedSan: m.san,
    bestUci: m.bestUci,
    bestSan: m.bestSan,
    acceptedUci: [...new Set([...(accepted.length ? accepted : [m.bestUci].filter(Boolean)), m.uci])],
    lines: m.lines,
    phase: m.phase,
    judgment: m.judgment,
    loss: m.loss,
    clock: m.clock ?? null,
    tier: 'decoy',
    category: null,
    pattern: null,
    label: `${game.headers.White || '?'} vs ${game.headers.Black || '?'}${game.headers.Date ? ', ' + game.headers.Date : ''}`,
  };
}

/** Ephemeral detection drills, built fresh from the player's own games. Every
 * stored drill is a position where an error is KNOWN to exist, so the deck
 * alone teaches "there is always something here" and does the hardest
 * real-game skill (spotting that this is a critical moment) for the player.
 * Decoys are quiet positions he handled correctly, asked exactly the same
 * way; the accepted answers include the fine move he actually played. */
export async function buildDecoys(count, rand = Math.random, userId = DEFAULT_USER) {
  if (count <= 0) return [];
  const index = (await listGames(userId)).filter(g => (g.status === 'analysed' || g.status === 'explained') && g.purpose !== 'scout' && g.playerColor);
  const order = [...index].sort(() => rand() - 0.5);
  const out = [];
  for (const entry of order) {
    if (out.length >= count) break;
    const game = await getGameCached(entry);
    if (!game?.analysis) continue;
    const moments = new Set(game.analysis.summary.moments);
    const candidates = game.analysis.moves.filter(m => decoyCandidate(m, moments));
    if (!candidates.length) continue;
    out.push(makeDecoy(game, candidates[Math.floor(rand() * candidates.length) % candidates.length]));
  }
  return out;
}

/** Due drills, core tier first, then opening flashcards, then near-miss
 * sharpeners. Consecutive drills from the same game are spread apart so one
 * game's context cannot prime the answers to its own next positions. With
 * `pattern` or `category`, a practice round instead: every matching drill,
 * due or not, back to back (blocked practice). Suspended drills never serve.
 * With `session` (a real sitting, not the badge poll), quiet-position decoys
 * are mixed into the queue, never first. */
export async function dueDrills(limit = 20, { pattern = null, category = null, subject = null, color = null, session = false, rand = Math.random, userId = DEFAULT_USER } = {}) {
  const store = await getDrills(userId);
  const now = Date.now();
  const pool = store.drills.filter(d => !d.suspended);
  const suspendedCount = store.drills.length - pool.length;
  if (pattern || category || subject) {
    // A prep round: this opponent's punish drills, optionally only the colour
    // they will have against the student (opening-phase errors first, since those
    // are the positions the student is likeliest to reach).
    const key = normalizeKey(pattern || category || subject);
    const field = pattern ? (d => d.pattern) : category ? (d => d.category) : (d => d.subject);
    let match = pool.filter(d => normalizeKey(field(d)) === key);
    if (subject) match = match.filter(d => d.kind === 'punish' && (!color || punishSubjectColor(d) === color));
    match.sort((a, b) => (subject ? phaseRank(a) - phaseRank(b) : 0) || Date.parse(a.due) - Date.parse(b.due));
    return { due: match.slice(0, limit), total: store.drills.length, dueCount: match.length, pattern, category, subject, color, suspendedCount, feedback: store.feedback };
  }
  const rank = d => (d.tier === 'core' ? 0 : d.tier === 'opening' ? 1 : 2);
  const due = pool.filter(d => Date.parse(d.due) <= now)
    .sort((a, b) => rank(a) - rank(b) || Date.parse(a.due) - Date.parse(b.due));
  for (let i = 1; i < due.length; i++) {
    if (due[i].gameId !== due[i - 1].gameId) continue;
    const j = due.findIndex((d, k) => k > i && d.gameId !== due[i].gameId && rank(d) === rank(due[i]));
    if (j > i) [due[i], due[j]] = [due[j], due[i]];
  }
  const list = due.slice(0, limit);
  if (session && list.length >= 3) {
    const built = await buildDecoys(Math.max(1, Math.floor(list.length / DECOY_RATIO)), rand, userId);
    built.forEach((d, i) => {
      const pos = Math.min(list.length, 1 + Math.floor((i + 1) * list.length / (built.length + 1)));
      list.splice(pos, 0, d);
    });
  }
  return { due: list, total: store.drills.length, dueCount: due.length, suspendedCount, feedback: store.feedback };
}

/** A punish drill's subject colour (older stores predate the field: the subject
 * had the colour opposite the student's). */
export const punishSubjectColor = d => d.subjectColor || (d.sideToMove === 'white' ? 'black' : 'white');
const phaseRank = d => (d.phase === 'opening' ? 0 : d.phase === 'middlegame' ? 1 : 2);

/** An ephemeral practice set for visitors: punish drills drawn from the shared
 * scout library, built fresh on every request and never stored. Visitors have no
 * games and nothing they do is recorded, so there is no ladder, no due dates, and
 * no store read or write here. With `subject` (and `color`), one opponent's
 * drills only, the same prep round members get. */
export async function visitorDrills(limit = 20, rand = Math.random, { subject = null, color = null } = {}) {
  const index = (await listAllGames())
    .filter(g => (g.purpose || 'own') === 'scout' && (g.status === 'analysed' || g.status === 'explained'))
    .filter(g => !subject || normalizeKey(g.subject) === normalizeKey(subject))
    .filter(g => !color || g.playerColor === color)
    .sort(() => rand() - 0.5);
  const out = [];
  for (const entry of index) {
    if (out.length >= limit) break;
    const game = await getGameCached(entry);
    if (!game?.analysis) continue;
    for (const ply of game.analysis.summary.moments) {
      const d = makePunishDrill(game, ply, 'core', null);
      if (d) out.push(d);
      if (out.length >= limit) break;
    }
  }
  return { due: out, total: out.length, dueCount: out.length, subject, color, suspendedCount: 0, feedback: {}, visitor: true };
}
