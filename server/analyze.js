// Engine analysis of a whole game: per-move evaluations, judgments, phases, critical moments.
import { Chess } from 'chess.js';

const MATE_CP = 10000;

/** Sign that converts a side-to-move value to White's perspective (and back). */
const stmSign = stm => (stm === 'white' ? 1 : -1);

/** Convert a UCI score (side-to-move perspective) to centipawns; mates map to +/- (MATE_CP - plies). */
export function scoreToCp(line) {
  if (!line) return 0;
  if (line.mate !== null && line.mate !== undefined) {
    return line.mate > 0 ? MATE_CP - line.mate : -MATE_CP - line.mate;
  }
  return line.cp ?? 0;
}

/** Lichess win-probability model, 0..100, from the perspective of the side the cp is for. */
export function winProb(cp) {
  const c = Math.max(-1500, Math.min(1500, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
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
  if (pieces <= 6 || (queens === 0 && pieces <= 8)) return 'endgame';
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

export function formatEval(cpForWhite) {
  if (Math.abs(cpForWhite) >= MATE_CP - 200) {
    const n = MATE_CP - Math.abs(cpForWhite);
    return (cpForWhite > 0 ? '#' : '#-') + n;
  }
  return (cpForWhite >= 0 ? '+' : '') + (cpForWhite / 100).toFixed(2);
}

/** Terminal position evaluation (mate/stalemate/draw) from side-to-move perspective, or null. */
function terminalCp(fen) {
  const chess = new Chess(fen);
  if (chess.isCheckmate()) return -MATE_CP;
  if (chess.isStalemate() || chess.isInsufficientMaterial()) return 0; // repetition is invisible from a bare FEN
  return null;
}

/**
 * Analyse every position of a game. `game.moves` from pgn.js. Calls onProgress(ply, total).
 * Returns { moves: [...annotated], summary }.
 */
export async function analyseGame(engine, game, settings, onProgress) {
  const depth = settings.engineDepth || 18;
  const multipv = settings.engineMultiPv || 3;
  const threshold = settings.momentThreshold ?? 12;
  const player = game.playerColor;
  const total = game.moves.length + 1;

  // Evaluate each position (before each move, plus the final one).
  const positions = [];
  const fens = [...game.moves.map(m => m.fenBefore), game.moves.length ? game.moves[game.moves.length - 1].fenAfter : new Chess().fen()];
  for (let i = 0; i < fens.length; i++) {
    const fen = fens[i];
    const term = terminalCp(fen);
    let result;
    if (term !== null) {
      result = { bestmove: null, lines: [], cp: term };
    } else {
      // Third onProgress arg = current search depth within position i; those calls
      // come from the engine's stdout handler and must not throw (see jobs.js).
      const r = await engine.analyse(fen, { depth, multipv, onDepth: onProgress ? d => onProgress(i, total, d) : null });
      result = { bestmove: r.bestmove, lines: r.lines, cp: scoreToCp(r.lines[0]) };
    }
    result.stm = fen.split(' ')[1] === 'w' ? 'white' : 'black';
    positions.push(result);
    if (onProgress) onProgress(i + 1, total);
  }

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
  summary.engine = engine.name;
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
  const moments = moves
    .filter(m => m.isPlayer && m.loss >= threshold)
    .map(m => m.ply);
  return { white: forColor('white'), black: forColor('black'), player, moments };
}
