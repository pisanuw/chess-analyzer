// Opening clash, source indexes: parsing and aggregating each side's games
// into a position-keyed index, the expensive step (an opponent's whole book,
// about 17ms per game). Forest assembly (clash.js) is a separate, cheap,
// per-request step over these indexes; splitting the two apart means the
// trickiest part (forest assembly) can be read, tested, and changed without
// wading through book-parsing and feature-harvesting code, and vice versa.
import { parseGame } from './pgn.js';
import { ageDays, pgnToDate, recencyWeight } from './scoutbook.js';
import { listGames, loadGames, getScoutBook, getClashStore, saveClashStore, getSettings, DEFAULT_USER } from './store.js';
import { resultScore, posKeyOf } from '../public/shared.js';

// Defaults tuned to the measured data: on the opponent's main lines support runs
// 6 to 10 plies deep, thinning to single-game nodes by move 3 to 4 off the beaten
// path. maxPly is a safety limit, not an expected depth.
export const CLASH_DEFAULTS = {
  maxPly: 20,        // hard depth cap; also caps the opponent PGN walk
  oppBranch: 3,      // top-N opponent replies kept per node
  minCountOpp: 2,    // never branch on a single opponent game (except the only reply)
  minShareOpp: 0.08, // drop replies under this weighted share (except the only reply)
  studentBranch: 1,      // the player is single-file (one repertoire) below his first move
  rootStudentBranch: 6,  // ...but his first move fans out over his whole opening menu
  minRootGames: 2,   // ignore one-off opening roots
  maxNodes: 400,     // per-forest hard node cap
  maxParse: 1200,    // backstop on how many book games one build parses
};

/** scoutDossier's own recency weight, so the clash numbers reconcile with the
 * repertoire book. No Elo-band filter here (scoutDossier does not apply one in
 * its repertoire loop either). */
export const weightOf = (dateStr, now, maxDays, halfLifeDays) => recencyWeight(ageDays(dateStr, now), maxDays, halfLifeDays);

/** The student's analysed own games (one full read each), the only source deep
 * enough for their side of the tree. Scoped to the member whose openings the
 * clash crosses, so every viewer sees their own lines against the opponent. */
export async function loadStudentGames(userId = DEFAULT_USER) {
  const index = (await listGames(userId)).filter(g => (g.status === 'analysed' || g.status === 'explained') && g.purpose === 'own');
  return (await loadGames(index)).filter(g => g.playerColor && g.analysis?.moves);
}

/** Index of the player's own opening moves, keyed by colour then by the position
 * before each move: { white: { posKey: { uci: agg } }, black: {...} }. */
export function buildStudentIndex(studentGames, maxPly = CLASH_DEFAULTS.maxPly) {
  const index = { white: {}, black: {} };
  const counts = { white: 0, black: 0 };
  for (const g of studentGames) {
    const color = g.playerColor;
    if (color !== 'white' && color !== 'black') continue;
    counts[color]++;
    const score = resultScore(g.headers?.Result, color);
    for (const m of g.analysis.moves) {
      if (m.ply > maxPly) break;
      if (m.color !== color || !m.fenBefore || !m.fenAfter || !m.uci) continue;
      const map = index[color][posKeyOf(m.fenBefore)] ||= {};
      const a = map[m.uci] ||= { san: m.san, uci: m.uci, childFen: m.fenAfter, count: 0, scoreSum: 0, scoredN: 0, cpSum: 0, cpN: 0, cp: null, accSum: 0, accN: 0, deviation: false };
      a.count++;
      if (score != null) { a.scoreSum += score; a.scoredN++; }
      if (typeof m.evalAfter === 'number') { a.cpSum += m.evalAfter; a.cpN++; a.cp = Math.round(a.cpSum / a.cpN); }
      if (typeof m.accuracy === 'number') { a.accSum += m.accuracy; a.accN++; }
      // Where the player's opening understanding ran out: he left the engine's
      // lines or dropped 10+ win-% (the marker repertoire.js uses for prep-ends).
      if (m.phase === 'opening' && (m.playedRank == null || m.loss >= 10)) a.deviation = true;
    }
  }
  return { index, counts };
}

/** Parse an opponent's book and index their moves by colour and position. This is
 * the expensive step (about 17 ms per game): it runs in the clash job, yielding
 * to the event loop every few games via onProgress so a long parse never blocks
 * the server. Old games (weight 0) are skipped before parsing, so cost tracks the
 * recent, on-strength subset, not the whole history. */
export async function buildOpponentIndex(book, settings, { onProgress, cancelled, now = new Date() } = {}) {
  const maxDays = (settings.scoutMaxAgeYears ?? 3) * 365.25;
  const halfLife = settings.scoutHalfLifeDays ?? 540;
  const index = { white: {}, black: {} };
  const colorCounts = { white: 0, black: 0 };
  let parsed = 0, skipped = 0;
  const games = book.games || [];
  const features = featureCollector(games, now, maxDays, halfLife);
  for (let i = 0; i < games.length; i++) {
    if (cancelled?.()) break;
    if (onProgress && i % 25 === 0) { onProgress(i, games.length); await new Promise(r => setImmediate(r)); }
    const g = games[i];
    const color = g.color;
    // Skip non-standard starts (posKey null: Chess960/odds), games with no PGN,
    // and games outside the recency window, before paying the parse.
    if (!g.posKey || !g.pgn || (color !== 'white' && color !== 'black')) { skipped++; continue; }
    const w = weightOf(g.date, now, maxDays, halfLife);
    if (w <= 0) { skipped++; continue; }
    if (parsed >= CLASH_DEFAULTS.maxParse) { skipped++; continue; }
    let pg;
    try { pg = parseGame(g.pgn); } catch { skipped++; continue; }
    const score = resultScore(g.result, color);
    for (const m of pg.moves) {
      if (m.ply > CLASH_DEFAULTS.maxPly) break;
      if (m.color !== color || !m.fenBefore || !m.fenAfter) continue;
      const map = index[color][posKeyOf(m.fenBefore)] ||= {};
      const a = map[m.uci] ||= { san: m.san, uci: m.uci, childFen: m.fenAfter, count: 0, weight: 0, scoreW: 0, scoredW: 0, oppEloSum: 0, oppEloN: 0, lastDate: '' };
      a.count++; a.weight += w;
      if (score != null) { a.scoreW += score * w; a.scoredW += w; }
      if (g.oppElo) { a.oppEloSum += g.oppElo; a.oppEloN++; }
      if ((g.date || '') > a.lastDate) a.lastDate = g.date || '';
    }
    features.parsed(g, pg); // the whole game is parsed anyway: harvest the structure habits
    parsed++; colorCounts[color]++;
  }
  onProgress?.(games.length, games.length);
  return { index, features: features.finish(), coverage: { total: games.length, bookGamesParsed: parsed, bookGamesSkipped: skipped, oppColorCounts: colorCounts } };
}

// --- book features: habits the whole history reveals without an engine --------
// Computed in the same pass as the opening index (the PGNs are parsed anyway):
// game length, draw rate, castling side, queen trades, first capture, the score
// against higher- and lower-rated opponents, the score when out of their own
// main lines, and current form. Everything is a count next to a rate so a thin
// sample reads as thin.
const RATING_GAP = 50;      // "higher rated" means at least this much above the subject
const MAIN_LINES = 3;       // a game is "in book" when its 8-ply position is one of the subject's top lines per colour
const FORM_GAMES = 10;      // form: the last this-many dated games
const RECENT_DAYS = 90;     // ...and how many games in this window

function featureCollector(games, now, maxDays, halfLife) {
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
  const tally = () => ({ games: 0, scored: 0, score: 0 });
  const add = (t, score) => { t.games++; if (score != null) { t.scored++; t.score += score; } };
  const rate = t => ({ games: t.games, scorePct: pct(t.score, t.scored) });
  // Main lines per colour from the stored 8-ply posKeys (no parse needed).
  const inWindow = games.filter(g => g.posKey && (g.color === 'white' || g.color === 'black') && weightOf(g.date, now, maxDays, halfLife) > 0);
  const mainLines = { white: new Set(), black: new Set() };
  for (const color of ['white', 'black']) {
    const counts = new Map();
    for (const g of inWindow) if (g.color === color) counts.set(g.posKey, (counts.get(g.posKey) || 0) + 1);
    [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAIN_LINES).forEach(([k]) => mainLines[color].add(k));
  }
  const f = {
    white: { games: 0, draws: 0, castled: { short: 0, long: 0, none: 0 } },
    black: { games: 0, draws: 0, castled: { short: 0, long: 0, none: 0 } },
    oppositeCastling: 0, queenTrades: 0, queenTradePlies: [], firstCapturePlies: [], plies: [],
    vsHigher: tally(), vsLower: tally(), vsLevel: tally(),
    inBook: tally(), outOfBook: tally(),
  };
  return {
    parsed(g, pg) {
      const color = g.color;
      const score = resultScore(g.result, color);
      const c = f[color];
      c.games++;
      if (score === 0.5) c.draws++;
      f.plies.push(pg.moves.length);
      const castle = { white: null, black: null };
      let queenTrade = null, firstCapture = null;
      for (const m of pg.moves) {
        if (m.san === 'O-O' || m.san === 'O-O-O') castle[m.color] = m.san === 'O-O' ? 'short' : 'long';
        if (firstCapture == null && m.san.includes('x')) firstCapture = m.ply;
        if (queenTrade == null && !/[qQ]/.test(m.fenAfter.split(' ')[0])) queenTrade = m.ply;
      }
      c.castled[castle[color] || 'none']++;
      if (castle.white && castle.black && castle.white !== castle.black) f.oppositeCastling++;
      if (queenTrade != null) { f.queenTrades++; f.queenTradePlies.push(queenTrade); }
      if (firstCapture != null) f.firstCapturePlies.push(firstCapture);
      if (g.subjectElo && g.oppElo) {
        const gap = g.oppElo - g.subjectElo;
        add(gap >= RATING_GAP ? f.vsHigher : gap <= -RATING_GAP ? f.vsLower : f.vsLevel, score);
      }
      add(mainLines[color].has(g.posKey) ? f.inBook : f.outOfBook, score);
    },
    finish() {
      const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
      const dated = games.filter(g => pgnToDate(g.date)).sort((a, b) => pgnToDate(b.date) - pgnToDate(a.date));
      const form = tally();
      for (const g of dated.slice(0, FORM_GAMES)) add(form, resultScore(g.result, g.color));
      const recent = dated.filter(g => ageDays(g.date, now) <= RECENT_DAYS).length;
      const total = f.white.games + f.black.games;
      return {
        games: total,
        avgMoves: f.plies.length ? Math.round(f.plies.reduce((s, n) => s + n, 0) / f.plies.length / 2) : null,
        drawRate: { white: pct(f.white.draws, f.white.games), black: pct(f.black.draws, f.black.games) },
        castling: { white: f.white.castled, black: f.black.castled },
        oppositeCastlingPct: pct(f.oppositeCastling, total),
        queenTrade: { pct: pct(f.queenTrades, total), medianMove: f.queenTradePlies.length ? Math.ceil(median(f.queenTradePlies) / 2) : null },
        firstCaptureMedianMove: f.firstCapturePlies.length ? Math.ceil(median(f.firstCapturePlies) / 2) : null,
        vsHigher: rate(f.vsHigher), vsLower: rate(f.vsLower), vsLevel: rate(f.vsLevel),
        inBook: rate(f.inBook), outOfBook: rate(f.outOfBook),
        form: { ...rate(form), recentGames: recent, days: RECENT_DAYS },
      };
    },
  };
}

/** Build (or reuse) one opponent's parsed opening index, persisted to the local
 * clash store (data/clash.json). The parse is the only expensive step, so it is
 * skipped when the stored index already matches the book's import. Shared by the
 * clash job (with progress/cancel), the startup pre-build, and the publish step. */
export async function ensureClashIndex(fideId, { force = false, onProgress, cancelled, now } = {}) {
  const book = await getScoutBook(fideId);
  if (!book) return null;
  const store = await getClashStore();
  if (!force && store[book.fideId]?.bookImportedAt === book.importedAt) return store[book.fideId];
  const { index, features, coverage } = await buildOpponentIndex(book, await getSettings(), { onProgress, cancelled, now });
  if (cancelled?.()) return null;
  store[book.fideId] = { bookImportedAt: book.importedAt, builtAt: new Date().toISOString(), coverage, features, index };
  await saveClashStore(store);
  return store[book.fideId];
}
