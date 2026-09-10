// Opening clash: an alternating, branching prediction of how a scouted opponent
// would meet the player's own openings. Unlike repertoire.js and scoutbook.js
// (which stop at 8 to 10 plies and keep a single move order), this walks full
// move lists and branches, so it is genuinely a tree, not a summary.
//
// Two sources, two indexes:
//   - the player's side, from his own analysed games (analysis.moves[] already
//     carry san/uci/fenAfter/evalAfter, so no re-parse), keyed by the position
//     before each of his moves;
//   - the opponent's side, by parsing every book game's full PGN (the book keeps
//     only 10 SAN plies), weighted with scoutDossier's exact recency scheme so a
//     predicted reply's share matches the repertoire book shown alongside it.
//
// The two are interleaved into a position-keyed forest: transpositions merge on
// the same 3-field posKey used everywhere else, branching is capped, and every
// node records, per side, where preparation runs out (the player leaving his own
// lines, or the opponent having no or too few games in the position).
import { parseGame } from './pgn.js';
import { ageDays } from './scoutbook.js';
import { resultScore } from './report.js';
import { getGame, listGames } from './store.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Defaults tuned to the measured data: on the opponent's main lines support runs
// 6 to 10 plies deep, thinning to single-game nodes by move 3 to 4 off the beaten
// path. maxPly is a safety limit, not an expected depth.
export const CLASH_DEFAULTS = {
  maxPly: 20,        // hard depth cap; also caps the opponent PGN walk
  oppBranch: 3,      // top-N opponent replies kept per node
  minCountOpp: 2,    // never branch on a single opponent game (except the only reply)
  minShareOpp: 0.08, // drop replies under this weighted share (except the only reply)
  kaiBranch: 1,      // the player is single-file (one repertoire) below his first move
  rootKaiBranch: 6,  // ...but his first move fans out over his whole opening menu
  minRootGames: 2,   // ignore one-off opening roots
  maxNodes: 400,     // per-forest hard node cap
  maxParse: 1200,    // backstop on how many book games one build parses
};

const posKeyOf = fen => fen.split(' ').slice(0, 3).join(' ');
const sideOf = fen => (fen.split(' ')[1] === 'w' ? 'white' : 'black');
const keyOf = fen => `${sideOf(fen)}|${posKeyOf(fen)}`;

/** scoutDossier's recency weight, replicated so the clash numbers reconcile with
 * the repertoire book: halves every halfLifeDays, zero past the age cutoff, a
 * small flat weight for undated games. No Elo-band filter here (scoutDossier does
 * not apply one in its repertoire loop either). */
function weightOf(dateStr, now, maxDays, halfLifeDays) {
  const age = ageDays(dateStr, now);
  if (age != null && age > maxDays) return 0;
  return age == null ? 0.25 : Math.pow(0.5, age / halfLifeDays);
}

/** The player's analysed own games (one full read each), the only source deep
 * enough for his side of the tree. */
export async function loadKaiGames() {
  const index = (await listGames()).filter(g => (g.status === 'analysed' || g.status === 'explained') && g.purpose === 'own');
  const games = await Promise.all(index.map(g => getGame(g.id)));
  return games.filter(g => g && g.playerColor && g.analysis?.moves);
}

/** Index of the player's own opening moves, keyed by colour then by the position
 * before each move: { white: { posKey: { uci: agg } }, black: {...} }. */
export function buildKaiIndex(kaiGames, maxPly = CLASH_DEFAULTS.maxPly) {
  const index = { white: {}, black: {} };
  const counts = { white: 0, black: 0 };
  for (const g of kaiGames) {
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
    parsed++; colorCounts[color]++;
  }
  onProgress?.(games.length, games.length);
  return { index, coverage: { total: games.length, bookGamesParsed: parsed, bookGamesSkipped: skipped, oppColorCounts: colorCounts } };
}

const clampInt = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

/** Merge caller-supplied query params over the defaults, clamped to sane ranges. */
export function clashParams(params = {}) {
  const p = { ...CLASH_DEFAULTS };
  if (params.maxPly != null) p.maxPly = clampInt(params.maxPly, 4, 24, p.maxPly);
  if (params.oppBranch != null) p.oppBranch = clampInt(params.oppBranch, 1, 5, p.oppBranch);
  if (params.minShareOpp != null) p.minShareOpp = clampInt(params.minShareOpp, 0, 40, 8) / 100;
  if (params.kaiBranch != null) p.kaiBranch = clampInt(params.kaiBranch, 1, 3, p.kaiBranch);
  return p;
}

/** A display-only leaf: a position we choose not to expand (a thin opponent reply
 * past the point the book supports). Not memoised, carries no edges. */
function leafOf(fen, ply, kaiColor) {
  const side = sideOf(fen);
  return { key: keyOf(fen), side, mover: side === kaiColor ? 'kai' : 'opponent', ply, fenBefore: fen, edges: [], kaiPrepEnds: false, oppPrepEnds: false, oppPrepEndsReason: null, truncated: false, leaf: true };
}

/** Assemble the two forests from the pre-built indexes. Cheap (no parsing), so it
 * runs per request. White forest: root is the player to move (his opening menu).
 * Black forest: root is the opponent to move (they choose the opening), then the
 * player replies. Depth alternates from there. */
export function assembleClashForest({ oppIndex, coverage, kai, book, params = {} }) {
  const P = clashParams(params);
  const forests = { white: null, black: null };
  for (const kaiColor of ['white', 'black']) {
    if (!kai.counts[kaiColor]) continue; // no games of this colour, no forest
    const oppColor = kaiColor === 'white' ? 'black' : 'white';
    const kaiMap = kai.index[kaiColor] || {};
    const oppMap = (oppIndex && oppIndex[oppColor]) || {};
    const memo = new Set();
    const counter = { n: 0 };
    forests[kaiColor] = expand(START_FEN, 0, false, { kaiColor, kaiMap, oppMap, memo, counter, P });
  }
  const nodeCount = countNodes(forests.white) + countNodes(forests.black);
  return {
    fideId: book.fideId, name: book.name,
    builtAt: new Date().toISOString(), bookImportedAt: book.importedAt,
    params: { maxPly: P.maxPly, oppBranch: P.oppBranch, minCountOpp: P.minCountOpp, minShareOpp: P.minShareOpp, kaiBranch: P.kaiBranch },
    kaiColorCounts: kai.counts,
    forests, nodeCount,
    truncated: (forests.white?.truncated || forests.black?.truncated) || nodeCount >= 2 * P.maxNodes,
    coverage,
  };
}

function expand(fen, ply, kaiMoved, ctx) {
  const { kaiColor, kaiMap, oppMap, memo, counter, P } = ctx;
  const side = sideOf(fen);
  const key = keyOf(fen);
  const mover = side === kaiColor ? 'kai' : 'opponent';
  const node = { key, side, mover, ply, fenBefore: fen, edges: [], kaiPrepEnds: false, oppPrepEnds: false, oppPrepEndsReason: null, truncated: false };
  const posKey = posKeyOf(fen);
  const hasData = mover === 'kai' ? !!kaiMap[posKey] : !!oppMap[posKey];

  if (memo.has(key)) { node.transposesTo = key; return node; } // merge move orders; do not re-expand
  memo.add(key);
  counter.n++;
  if (ply >= P.maxPly || counter.n >= P.maxNodes) {
    if (hasData) node.truncated = true;
    else if (mover === 'kai') node.kaiPrepEnds = true;
    else { node.oppPrepEnds = true; node.oppPrepEndsReason = 'nodata'; }
    return node;
  }

  if (mover === 'kai') {
    const moves = kaiMap[posKey] ? Object.values(kaiMap[posKey]) : [];
    let kept = moves.sort((a, b) => b.count - a.count);
    if (!kaiMoved) kept = kept.filter(m => m.count >= P.minRootGames); // ignore one-off roots at his first move
    kept = kept.slice(0, kaiMoved ? P.kaiBranch : P.rootKaiBranch);
    if (!kept.length) { node.kaiPrepEnds = true; return node; }
    for (const m of kept) {
      node.edges.push({
        san: m.san, uci: m.uci, fenAfter: m.childFen, childKey: keyOf(m.childFen),
        count: m.count, weight: m.count,
        scorePct: m.scoredN ? Math.round((m.scoreSum / m.scoredN) * 100) : null,
        cp: m.cp, accuracy: m.accN ? Math.round(m.accSum / m.accN) : null,
        deviation: !!m.deviation,
        child: expand(m.childFen, ply + 1, true, ctx),
      });
      if (counter.n >= P.maxNodes) break;
    }
    return node;
  }

  // opponent to move
  const all = oppMap[posKey] ? Object.values(oppMap[posKey]) : [];
  if (!all.length) { node.oppPrepEnds = true; node.oppPrepEndsReason = 'nodata'; return node; }
  const totalW = all.reduce((s, m) => s + m.weight, 0) || 1;
  const sorted = all.sort((a, b) => b.weight - a.weight);
  let kept = sorted.filter(m => m.count >= P.minCountOpp && m.weight / totalW >= P.minShareOpp).slice(0, P.oppBranch);
  if (!kept.length) { kept = [sorted[0]]; node.oppPrepEnds = true; node.oppPrepEndsReason = 'thin'; }
  for (const m of kept) {
    node.edges.push({
      san: m.san, uci: m.uci, fenAfter: m.childFen, childKey: keyOf(m.childFen),
      count: m.count, weight: +m.weight.toFixed(2), share: Math.round((m.weight / totalW) * 100),
      scorePct: m.scoredW ? Math.round((m.scoreW / m.scoredW) * 100) : null,
      avgOppElo: m.oppEloN ? Math.round(m.oppEloSum / m.oppEloN) : null,
      lastDate: m.lastDate || '',
      // A thin reply is speculative past this point, so show it but do not mine
      // deeper into single-game noise.
      child: node.oppPrepEndsReason === 'thin' ? leafOf(m.childFen, ply + 1, kaiColor) : expand(m.childFen, ply + 1, kaiMoved, ctx),
    });
    if (counter.n >= P.maxNodes) break;
  }
  return node;
}

function countNodes(node) {
  if (!node) return 0;
  return 1 + (node.edges || []).reduce((s, e) => s + countNodes(e.child), 0);
}
