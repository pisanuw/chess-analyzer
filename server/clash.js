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
import { Chess } from 'chess.js';
import { parseGame } from './pgn.js';
import { ageDays } from './scoutbook.js';
import { resultScore } from './report.js';
import { getGame, listGames, getScoutBook, getClashStore, saveClashStore, getSettings } from './store.js';
import { scoreToCp, stmSign } from './analyze.js';
import { winProb, WP_ACCEPT } from '../public/shared.js';
import { getCachedEval, putCachedEval, evalCacheKey, flushCache } from './evalcache.js';
import { poolAnalyse } from './enginepool.js';

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

/** Build (or reuse) one opponent's parsed opening index, persisted to the local
 * clash store (data/clash.json). The parse is the only expensive step, so it is
 * skipped when the stored index already matches the book's import. Shared by the
 * clash job (with progress/cancel), the startup pre-build, and the publish step. */
export async function ensureClashIndex(fideId, { force = false, onProgress, cancelled, now } = {}) {
  const book = await getScoutBook(fideId);
  if (!book) return null;
  const store = await getClashStore();
  if (!force && store[book.fideId]?.bookImportedAt === book.importedAt) return store[book.fideId];
  const { index, coverage } = await buildOpponentIndex(book, await getSettings(), { onProgress, cancelled, now });
  if (cancelled?.()) return null;
  store[book.fideId] = { bookImportedAt: book.importedAt, builtAt: new Date().toISOString(), coverage, index };
  await saveClashStore(store);
  return store[book.fideId];
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

// --- principal lines (for the optional LLM narration) ---------------------------

const fmtSanLine = sans => sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}.` : '') + s).join(' ');

function endReasonOf(node) {
  if (node.kaiPrepEnds) return 'you have no games continuing here';
  if (node.oppPrepEnds) return node.oppPrepEndsReason === 'nodata' ? 'the opponent has never faced this position' : 'the opponent has too few games here to trust';
  if (node.leaf) return 'the opponent has too few games here to continue';
  if (node.truncated) return 'the shown depth limit was reached';
  return 'this is as far as the games go';
}

function walkPaths(node, sans, likelihood, color, out) {
  if (node.transposesTo) return; // merges into a line collected elsewhere
  if (!node.edges.length) {
    if (sans.length) out.push({ color, sans: [...sans], sanLine: fmtSanLine(sans), endReason: endReasonOf(node), endEval: node.engineBest?.cp ?? null, likelihood });
    return;
  }
  for (const e of node.edges) {
    const share = node.mover === 'opponent' ? (e.share || 0) / 100 : 1; // player edges do not divide the probability
    walkPaths(e.child, [...sans, e.san], likelihood * (share || 0.01), color, out);
  }
}

/** Flatten the forest into full root-to-leaf lines, most likely first, for the
 * optional coach narration. Pure data; the model only writes prose about these. */
export function clashPrincipalLines(clash, max = 12) {
  const out = [];
  for (const color of ['white', 'black']) if (clash.forests[color]) walkPaths(clash.forests[color], [], 1, color, out);
  out.sort((a, b) => b.likelihood - a.likelihood);
  return out.slice(0, max).map((l, idx) => ({ idx, ...l }));
}

// --- optional engine extension of prep-end leaves -------------------------------

const MAX_EXTEND = 40; // bound the engine work in one synchronous request

/** Every terminal node worth an engine suggestion: a position where a side ran
 * out of data (yours, or the opponent's). Keyed by FEN so a position reached
 * more than once is evaluated once. Skips transposition stubs and finished
 * positions. */
function collectExtendable(node, byFen) {
  if (!node) return;
  if (!node.edges.length && !node.transposesTo && (node.kaiPrepEnds || node.oppPrepEnds || node.leaf || node.truncated)) {
    let over = false;
    try { const c = new Chess(node.fenBefore); over = c.isGameOver(); } catch { over = true; }
    if (!over) (byFen.get(node.fenBefore) || byFen.set(node.fenBefore, []).get(node.fenBefore)).push(node);
  }
  for (const e of node.edges) collectExtendable(e.child, byFen);
}

/** Opponent's aggregate score in a position they have reached (across all their
 * moves there), or null. Used to flag when a candidate transposes into a
 * structure the opponent handles badly. */
function oppScoreAt(oppMapForColor, posKey) {
  const moves = oppMapForColor?.[posKey];
  if (!moves) return null;
  let count = 0, scoreW = 0, scoredW = 0;
  for (const m of Object.values(moves)) { count += m.count; scoreW += m.scoreW; scoredW += m.scoredW; }
  return { count, scorePct: scoredW ? Math.round((scoreW / scoredW) * 100) : null };
}

/** Attach the engine's view to one leaf: its best line(s) as White-POV evals,
 * and, for your-move leaves, which engine-approved move steers into a structure
 * the opponent scores worst in (min 4 games, so it is signal not noise). */
function annotateLeaf(node, fen, result, oppIndex) {
  if (!result?.lines?.length) return;
  const stm = sideOf(fen);
  const sign = stmSign(stm);
  const lines = result.lines.map(l => {
    const uci = l.pv?.[0];
    if (!uci) return null;
    let san = uci, childFen = null;
    try { const c = new Chess(fen); const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); if (mv) { san = mv.san; childFen = c.fen(); } } catch { /* keep uci */ }
    return { uci, san, cp: scoreToCp(l) * sign, stmCp: scoreToCp(l), childFen };
  }).filter(Boolean);
  if (!lines.length) return;

  // Steering only makes sense when it is your move (you choose). Look up the
  // opponent's historical score in each engine-approved candidate's resulting
  // position; prefer the acceptable move that heads into their worst structure.
  if (node.mover === 'kai' && oppIndex) {
    const oppColor = stm === 'white' ? 'black' : 'white';
    const bestStm = lines[0].stmCp;
    let steer = null;
    for (const l of lines) {
      if (winProb(bestStm) - winProb(l.stmCp) > WP_ACCEPT || !l.childFen) continue; // not engine-approved
      const opp = oppScoreAt(oppIndex[oppColor], posKeyOf(l.childFen));
      if (!opp || opp.count < 4 || opp.scorePct == null) continue;
      l.oppScorePct = opp.scorePct; l.oppCount = opp.count;
      if (!steer || opp.scorePct < steer.oppScorePct) steer = { uci: l.uci, san: l.san, cp: l.cp, oppScorePct: opp.scorePct, oppCount: opp.count };
    }
    if (steer) node.steer = steer;
  }

  node.engineBest = { uci: lines[0].uci, san: lines[0].san, cp: lines[0].cp };
  node.engineLines = lines.map(l => ({ uci: l.uci, san: l.san, cp: l.cp, childFen: l.childFen, ...(l.oppScorePct != null ? { oppScorePct: l.oppScorePct, oppCount: l.oppCount } : {}) }));
}

/** Evaluate the tree's prep-end leaves with Stockfish (engine-grounded: candidate
 * moves come from the engine, never a model), cache-first so the many opening
 * positions already seen cost nothing. Mutates and returns the forest. */
export async function extendClashLeaves(forest, oppIndex, settings, pool) {
  const depth = settings.engineDepth || 18;
  const multipv = Math.max(2, settings.engineMultiPv || 3);
  const byFen = new Map();
  collectExtendable(forest.forests.white, byFen);
  collectExtendable(forest.forests.black, byFen);
  // Shallowest leaves first, so if we hit the cap the earliest (most relevant)
  // positions are the ones that get engine data.
  const fens = [...byFen.entries()].sort((a, b) => Math.min(...a[1].map(n => n.ply)) - Math.min(...b[1].map(n => n.ply))).map(([f]) => f);
  const chosen = fens.slice(0, MAX_EXTEND);
  forest.engineExtendTruncated = fens.length > chosen.length;

  await poolAnalyse(pool, chosen,
    async (engine, fen) => {
      for (const name of pool.names) { const hit = await getCachedEval(evalCacheKey(name, depth, multipv, fen)); if (hit) return hit; }
      let r = await engine.analyse(fen, { depth, multipv });
      if (!r.lines.length) r = await engine.analyse(fen, { depth, multipv }); // one retry: a remote pipe can drop the info lines
      if (!r.lines.length) return { bestmove: null, lines: [] };            // give up rather than fabricate an eval
      await putCachedEval(evalCacheKey(engine.name, depth, multipv, fen), { bestmove: r.bestmove, lines: r.lines });
      return r;
    },
    async (fen, result) => { for (const node of byFen.get(fen)) annotateLeaf(node, fen, result, oppIndex); },
  );
  await flushCache();
  forest.engineExtended = true;
  return forest;
}
