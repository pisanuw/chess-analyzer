// Engine analysis of a whole game: per-move evaluations, judgments, phases, critical moments.
import { Chess } from 'chess.js';
import { winProb, formatEval } from '../public/shared.js';
import { getCachedEval, putCachedEval, evalCacheKey, CACHE_PLIES } from './evalcache.js';
import { poolAnalyse, singleEnginePool } from './enginepool.js';

// Shared with the frontend (public/shared.js); re-exported so server modules
// keep importing them from here.
export { winProb, formatEval };

const MATE_CP = 10000;

// A move is a critical moment only if the position was still worth contesting:
// the mover's win probability before the move was at least this. Piling loss
// onto an already-lost position is not something a coach flags. The winning
// side is kept (throwing part of a win is a real conversion lesson), so only
// this already-lost floor applies.
const MOMENT_CONTEST_FLOOR = 15;

/** Sign that converts a side-to-move value to White's perspective (and back). */
export const stmSign = stm => (stm === 'white' ? 1 : -1);

/** Convert a UCI score (side-to-move perspective) to centipawns; mates map to +/- (MATE_CP - plies). */
export function scoreToCp(line) {
  if (!line) return 0;
  if (line.mate !== null && line.mate !== undefined) {
    return line.mate > 0 ? MATE_CP - line.mate : -MATE_CP - line.mate;
  }
  return line.cp ?? 0;
}

/** Lichess-style move accuracy from win-probability drop (both in 0..100). */
export function moveAccuracy(wpBefore, wpAfter) {
  const drop = Math.max(0, wpBefore - wpAfter);
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
}

export function judge(loss) {
  if (loss >= 30) return 'blunder';
  if (loss >= 20) return 'mistake';
  if (loss >= 10) return 'inaccuracy';
  if (loss >= 3) return 'good';
  return 'best';
}

/** Rough phase classification from material and move number. */
export function phaseOf(fen, ply) {
  const board = fen.split(' ')[0];
  const pieces = board.replace(/[^qrbnQRBN]/g, '').length; // majors + minors on board
  const queens = board.replace(/[^qQ]/g, '').length;
  const pawns = board.replace(/[^pP]/g, '').length;
  // Endgame: little material left. Queens off is not enough on its own, or a
  // queenless middlegame with rooks, minors, and a full pawn set gets misfiled;
  // require a small total force too.
  if (pieces <= 6 || (queens === 0 && pieces + pawns <= 10)) return 'endgame';
  if (ply <= 24 && pieces >= 12) return 'opening';
  return 'middlegame';
}

/** Convert a UCI pv into SAN moves from a FEN, stopping at the first illegal move. */
export function pvToSan(fen, pv, maxPlies = 8) {
  const chess = new Chess(fen);
  const san = [];
  for (const uci of pv.slice(0, maxPlies)) {
    try {
      const mv = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      if (!mv) break;
      san.push(mv.san);
    } catch { break; }
  }
  return san;
}

/** Terminal position evaluation (mate/stalemate/draw) from side-to-move perspective, or null. */
function terminalCp(fen) {
  const chess = new Chess(fen);
  if (chess.isCheckmate()) return -MATE_CP;
  if (chess.isStalemate() || chess.isInsufficientMaterial()) return 0; // repetition is invisible from a bare FEN
  return null;
}

/**
 * Analyse every position of a game. `pool` is an engine pool (enginepool.js);
 * a bare Engine is accepted and wrapped. Calls onProgress(done, total).
 * Returns { moves: [...annotated], summary }.
 */
export async function analyseGame(pool, game, settings, onProgress) {
  if (!pool.engines) pool = singleEnginePool(pool);
  const depth = settings.engineDepth || 18;
  const multipv = settings.engineMultiPv || 3;
  const threshold = settings.momentThreshold ?? 12;
  const player = game.playerColor;
  const total = game.moves.length + 1;
  const stmOf = fen => (fen.split(' ')[1] === 'w' ? 'white' : 'black');

  // Evaluate each position (before each move, plus the final one).
  const fens = [...game.moves.map(m => m.fenBefore), game.moves.length ? game.moves[game.moves.length - 1].fenAfter : new Chess().fen()];
  const positions = new Array(fens.length);

  // Pre-pass: terminal positions need no engine, and opening positions recur
  // across games (same repertoire, same event), so serve those from the eval
  // cache when engine, depth, and MultiPV match. Only the misses hit the pool.
  const todo = [];
  for (let i = 0; i < fens.length; i++) {
    const term = terminalCp(fens[i]);
    if (term !== null) {
      positions[i] = { bestmove: null, lines: [], cp: term, stm: stmOf(fens[i]) };
      continue;
    }
    // The pool may mix Stockfish versions (local vs remote): try each name.
    let hit = null;
    if (i < CACHE_PLIES) {
      for (const name of pool.names) {
        hit = await getCachedEval(evalCacheKey(name, multipv, fens[i]), depth);
        if (hit) break;
      }
    }
    if (hit) positions[i] = { bestmove: hit.bestmove, lines: hit.lines, cp: scoreToCp(hit.lines[0]), stm: stmOf(fens[i]) };
    else todo.push(i);
  }

  // Fan the remaining positions out across the pool: they are independent, so
  // any engine can take any of them, and progress is completed positions.
  let done = fens.length - todo.length;
  if (onProgress) onProgress(done, total); // also the cancel checkpoint before searching
  // Live search-depth reporting only makes sense when a single engine works
  // the game front to back; with a pool the position counter moves instead.
  const single = pool.engines.length === 1;
  await poolAnalyse(
    pool,
    todo,
    (engine, i) => engine.analyse(fens[i], { depth, multipv, onDepth: onProgress && single ? d => onProgress(done, total, d) : null }),
    async (i, r, engine) => {
      let { bestmove, lines } = r;
      // A non-terminal position with no score lines would be stored as cp 0
      // (dead equal) via scoreToCp(undefined), silently corrupting evalBefore,
      // evalAfter, loss, ACPL, and judgment for the two moves that straddle it.
      // A healthy engine always emits an info...score...pv line before
      // bestmove, but a remote ssh pipe can drop info lines while still
      // delivering bestmove. Retry the search once; if it still yields nothing,
      // fail the job loudly rather than persisting a fabricated evaluation.
      // Throwing here (in onDone) stops dispatch cleanly and propagates;
      // throwing in run() would instead drop an otherwise-healthy engine.
      if (!lines.length) {
        ({ bestmove, lines } = await engine.analyse(fens[i], { depth, multipv }));
        if (!lines.length) throw new Error(`engine ${engine.label || engine.name} returned no evaluation for ${fens[i]}`);
      }
      positions[i] = { bestmove, lines, cp: scoreToCp(lines[0]), stm: stmOf(fens[i]) };
      if (i < CACHE_PLIES) {
        await putCachedEval(evalCacheKey(engine.name, multipv, fens[i]), { depth, bestmove, lines });
      }
      done++;
      if (onProgress) onProgress(done, total);
    });

  const moves = game.moves.map((m, i) => {
    const before = positions[i];
    const after = positions[i + 1];
    const sign = stmSign(m.color);
    const evalBeforeW = before.cp * stmSign(before.stm); // white perspective
    const evalAfterW = after.cp * stmSign(after.stm);
    const wpBefore = winProb(evalBeforeW * sign); // mover perspective
    const wpAfter = winProb(evalAfterW * sign);
    const loss = Math.max(0, wpBefore - wpAfter);
    const cpLoss = Math.max(0, Math.min(1000, (evalBeforeW - evalAfterW) * sign));
    const lines = before.lines.map(l => ({
      multipv: l.multipv,
      cp: scoreToCp(l) * stmSign(before.stm), // white perspective
      mate: l.mate,
      uci: l.pv[0],
      san: pvToSan(m.fenBefore, l.pv, 8),
    }));
    const played = lines.find(l => l.uci === m.uci);
    return {
      ...m,
      evalBefore: evalBeforeW,
      evalAfter: evalAfterW,
      wpBefore: +wpBefore.toFixed(1),
      wpAfter: +wpAfter.toFixed(1),
      loss: +loss.toFixed(1),
      cpLoss: Math.round(cpLoss),
      accuracy: +moveAccuracy(wpBefore, wpAfter).toFixed(1),
      judgment: judge(loss),
      phase: phaseOf(m.fenBefore, m.ply),
      isPlayer: player ? m.color === player : false,
      bestUci: before.bestmove,
      bestSan: lines[0]?.san?.[0] || null,
      playedRank: played ? played.multipv : null,
      lines,
    };
  });

  const finalEval = positions[positions.length - 1];
  const summary = summarize(moves, player, threshold);
  summary.finalEval = finalEval.cp * stmSign(finalEval.stm);
  summary.engine = pool.name;
  if (pool.engines.length > 1) summary.pool = pool.engines.length; // how many engines shared the work
  summary.depth = depth;
  summary.multipv = multipv;
  return { moves, summary };
}

export function summarize(moves, player, threshold) {
  const avg = (ms, f) => ms.reduce((s, m) => s + f(m), 0) / ms.length;
  const acplOf = ms => Math.round(avg(ms, m => m.cpLoss));
  const accuracyOf = ms => +avg(ms, m => m.accuracy).toFixed(1);
  const forColor = color => {
    const ms = moves.filter(m => m.color === color);
    const byPhase = {};
    for (const phase of ['opening', 'middlegame', 'endgame']) {
      const pm = ms.filter(m => m.phase === phase);
      byPhase[phase] = pm.length ? { moves: pm.length, acpl: acplOf(pm), accuracy: accuracyOf(pm) } : null;
    }
    return {
      moves: ms.length,
      acpl: ms.length ? acplOf(ms) : 0,
      accuracy: ms.length ? accuracyOf(ms) : 0,
      inaccuracies: ms.filter(m => m.judgment === 'inaccuracy').length,
      mistakes: ms.filter(m => m.judgment === 'mistake').length,
      blunders: ms.filter(m => m.judgment === 'blunder').length,
      byPhase,
    };
  };
  const contestable = m => winProb((m.evalBefore || 0) * (m.color === 'white' ? 1 : -1)) >= MOMENT_CONTEST_FLOOR;
  const moments = moves
    .filter(m => m.isPlayer && m.loss >= threshold && contestable(m))
    .map(m => m.ply);
  return { white: forColor('white'), black: forColor('black'), player, moments };
}
