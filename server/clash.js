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
import { scoreToCp, stmSign } from './analyze.js';
import { winProb, WP_ACCEPT, posKeyOf, fmtLine } from '../public/shared.js';
import { getCachedEval, putCachedEval, evalCacheKey, flushCache } from './evalcache.js';
import { poolAnalyse } from './enginepool.js';
import { CLASH_DEFAULTS, loadStudentGames, buildStudentIndex, buildOpponentIndex, ensureClashIndex } from './clashindex.js';
import { DEFAULT_USER } from './store.js';

// Building the two source indexes (this module's own concern is assembling and
// querying the forest from them) lives in clashindex.js; re-exported here so
// every existing importer of clash.js is unaffected by the split.
export { CLASH_DEFAULTS, loadStudentGames, buildStudentIndex, buildOpponentIndex, ensureClashIndex };

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const sideOf = fen => (fen.split(' ')[1] === 'w' ? 'white' : 'black');
const keyOf = fen => `${sideOf(fen)}|${posKeyOf(fen)}`;

const clampInt = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

/** Merge caller-supplied query params over the defaults, clamped to sane ranges. */
export function clashParams(params = {}) {
  const p = { ...CLASH_DEFAULTS };
  if (params.maxPly != null) p.maxPly = clampInt(params.maxPly, 4, 24, p.maxPly);
  if (params.oppBranch != null) p.oppBranch = clampInt(params.oppBranch, 1, 5, p.oppBranch);
  if (params.minShareOpp != null) p.minShareOpp = clampInt(params.minShareOpp, 0, 40, 8) / 100;
  if (params.studentBranch != null) p.studentBranch = clampInt(params.studentBranch, 1, 3, p.studentBranch);
  return p;
}

/** A display-only leaf: a position we choose not to expand (a thin opponent reply
 * past the point the book supports). Not memoised, carries no edges. */
function leafOf(fen, ply, studentColor) {
  const side = sideOf(fen);
  return { key: keyOf(fen), side, mover: side === studentColor ? 'student' : 'opponent', ply, fenBefore: fen, edges: [], studentPrepEnds: false, oppPrepEnds: false, oppPrepEndsReason: null, truncated: false, leaf: true };
}

/** Assemble the two forests from the pre-built indexes. Cheap (no parsing), so it
 * runs per request. White forest: root is the player to move (his opening menu).
 * Black forest: root is the opponent to move (they choose the opening), then the
 * player replies. Depth alternates from there. */
export function assembleClashForest({ oppIndex, coverage, student, book, params = {} }) {
  const P = clashParams(params);
  const forests = { white: null, black: null };
  for (const studentColor of ['white', 'black']) {
    if (!student.counts[studentColor]) continue; // no games of this colour, no forest
    const oppColor = studentColor === 'white' ? 'black' : 'white';
    const studentMap = student.index[studentColor] || {};
    const oppMap = (oppIndex && oppIndex[oppColor]) || {};
    const memo = new Set();
    const counter = { n: 0 };
    forests[studentColor] = expand(START_FEN, 0, false, { studentColor, studentMap, oppMap, memo, counter, P });
  }
  const nodeCount = countNodes(forests.white) + countNodes(forests.black);
  return {
    fideId: book.fideId, name: book.name,
    builtAt: new Date().toISOString(), bookImportedAt: book.importedAt,
    params: { maxPly: P.maxPly, oppBranch: P.oppBranch, minCountOpp: P.minCountOpp, minShareOpp: P.minShareOpp, studentBranch: P.studentBranch },
    studentColorCounts: student.counts,
    forests, nodeCount,
    truncated: (forests.white?.truncated || forests.black?.truncated) || nodeCount >= 2 * P.maxNodes,
    coverage,
  };
}

function expand(fen, ply, studentMoved, ctx) {
  const { studentColor, studentMap, oppMap, memo, counter, P } = ctx;
  const side = sideOf(fen);
  const key = keyOf(fen);
  const mover = side === studentColor ? 'student' : 'opponent';
  const node = { key, side, mover, ply, fenBefore: fen, edges: [], studentPrepEnds: false, oppPrepEnds: false, oppPrepEndsReason: null, truncated: false };
  const posKey = posKeyOf(fen);
  const hasData = mover === 'student' ? !!studentMap[posKey] : !!oppMap[posKey];

  if (memo.has(key)) { node.transposesTo = key; return node; } // merge move orders; do not re-expand
  memo.add(key);
  counter.n++;
  if (ply >= P.maxPly || counter.n >= P.maxNodes) {
    if (hasData) node.truncated = true;
    else if (mover === 'student') node.studentPrepEnds = true;
    else { node.oppPrepEnds = true; node.oppPrepEndsReason = 'nodata'; }
    return node;
  }

  if (mover === 'student') {
    const moves = studentMap[posKey] ? Object.values(studentMap[posKey]) : [];
    let kept = moves.sort((a, b) => b.count - a.count);
    if (!studentMoved) kept = kept.filter(m => m.count >= P.minRootGames); // ignore one-off roots at his first move
    kept = kept.slice(0, studentMoved ? P.studentBranch : P.rootStudentBranch);
    if (!kept.length) { node.studentPrepEnds = true; return node; }
    // Engine lines stored by the student's own analysis at this position (the
    // same for every move played from it): the answer key for a repair card.
    const analysed = moves.find(m => m.lines?.length);
    if (analysed) node.ownLines = analysed.lines;
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
      child: node.oppPrepEndsReason === 'thin' ? leafOf(m.childFen, ply + 1, studentColor) : expand(m.childFen, ply + 1, studentMoved, ctx),
    });
    if (counter.n >= P.maxNodes) break;
  }
  return node;
}

function countNodes(node) {
  if (!node) return 0;
  return 1 + (node.edges || []).reduce((s, e) => s + countNodes(e.child), 0);
}

// --- prediction check: did a real game follow the tree? --------------------------

/** Walk a game's moves through the forest for the student's colour and report
 * where the game left the predicted tree: the ply, whose move it was, the move
 * that left it, and whether that position was one the tree knew (the mover chose
 * an unpredicted move) or one it had no data for. `matched` counts the plies
 * that stayed on a predicted edge. Pure: the truth about one prediction. */
export function walkPrediction(forest, moves, studentColor) {
  const root = forest?.forests?.[studentColor];
  if (!root) return null;
  let node = root, matched = 0;
  for (const m of moves) {
    if (!node || node.transposesTo) return { matched, leftAtPly: null, by: null, san: null, reason: 'the tree ends here', held: true };
    if (!node.edges.length) {
      return { matched, leftAtPly: m.ply, by: node.mover, san: m.san, reason: node.mover === 'student' ? (node.studentPrepEnds ? 'your line ended here' : 'no more of your games here') : (node.oppPrepEndsReason === 'nodata' ? 'they had never reached this position' : 'their book thinned out here'), held: true };
    }
    const edge = node.edges.find(e => e.uci === m.uci || e.san === m.san);
    if (!edge) return { matched, leftAtPly: m.ply, by: node.mover, san: m.san, reason: node.mover === 'student' ? 'you left your own line' : `they chose a move the tree did not predict (${node.edges.map(e => e.san).join(', ')} expected)`, held: false };
    matched++;
    node = edge.child;
  }
  return { matched, leftAtPly: null, by: null, san: null, reason: 'the whole game stayed inside the tree', held: true };
}

// --- principal lines (for the optional LLM narration) ---------------------------

// Narration is about the student's own lines, so it is keyed per member; a bare
// fideId key is a note from before multi-user and belongs to the primary member.
export const clashNoteKey = (fideId, uid) => (uid === DEFAULT_USER ? fideId : `${uid}:${fideId}`);

export function endReasonOf(node) {
  if (node.studentPrepEnds) return 'you have no games continuing here';
  if (node.oppPrepEnds) return node.oppPrepEndsReason === 'nodata' ? 'the opponent has never faced this position' : 'the opponent has too few games here to trust';
  if (node.leaf) return 'the opponent has too few games here to continue';
  if (node.truncated) return 'the shown depth limit was reached';
  return 'this is as far as the games go';
}

function walkPaths(node, sans, likelihood, color, out) {
  if (node.transposesTo) return; // merges into a line collected elsewhere
  if (!node.edges.length) {
    if (sans.length) out.push({ color, sans: [...sans], sanLine: fmtLine(sans), endReason: endReasonOf(node), endEval: node.engineBest?.cp ?? null, likelihood });
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
  if (!node.edges.length && !node.transposesTo && (node.studentPrepEnds || node.oppPrepEnds || node.leaf || node.truncated)) {
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
  if (node.mover === 'student' && oppIndex) {
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
      for (const name of pool.names) { const hit = await getCachedEval(evalCacheKey(name, multipv, fen), depth); if (hit) return hit; }
      let r = await engine.analyse(fen, { depth, multipv });
      if (!r.lines.length) r = await engine.analyse(fen, { depth, multipv }); // one retry: a remote pipe can drop the info lines
      if (!r.lines.length) return { bestmove: null, lines: [] };            // give up rather than fabricate an eval
      await putCachedEval(evalCacheKey(engine.name, multipv, fen), { depth, bestmove: r.bestmove, lines: r.lines });
      return r;
    },
    async (fen, result) => { for (const node of byFen.get(fen)) annotateLeaf(node, fen, result, oppIndex); },
  );
  await flushCache();
  forest.engineExtended = true;
  return forest;
}
