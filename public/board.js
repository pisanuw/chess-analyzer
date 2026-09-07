// Chessground wrapper with chess.js for legal moves.
import { Chessground } from '/vendor/chessground/chessground.min.js';
import { Chess } from '/vendor/chess.js/chess.js';

export function legalDests(fen) {
  const chess = new Chess(fen);
  const dests = new Map();
  for (const m of chess.moves({ verbose: true })) {
    if (!dests.has(m.from)) dests.set(m.from, []);
    dests.get(m.from).push(m.to);
  }
  return { dests, turn: chess.turn() === 'w' ? 'white' : 'black', inCheck: chess.inCheck() };
}

/** Apply a move (orig, dest) to a FEN; asks which piece on promotion. Returns { san, uci, fen } or null. */
export function applyMove(fen, orig, dest) {
  const chess = new Chess(fen);
  try {
    let promotion = 'q';
    const piece = chess.get(orig);
    if (piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) {
      const ans = (window.prompt('Promote to: q, r, b, or n', 'q') || 'q').trim().toLowerCase();
      if (ans.length === 1 && 'qrbn'.includes(ans)) promotion = ans;
    }
    const m = chess.move({ from: orig, to: dest, promotion });
    if (!m) return null;
    return { san: m.san, uci: m.from + m.to + (m.promotion || ''), fen: chess.fen() };
  } catch { return null; }
}

/** Walk a SAN line from a FEN; returns [{ san, uci, fen }], stopping at the first illegal move. */
export function walkSans(fen, sans) {
  const chess = new Chess(fen);
  const out = [];
  for (const san of sans) {
    try {
      const m = chess.move(san);
      if (!m) break;
      out.push({ san: m.san, uci: m.from + m.to + (m.promotion || ''), fen: chess.fen() });
    } catch { break; }
  }
  return out;
}

/** Walk a UCI line from a FEN; returns [{ san, uci, fen }]. */
export function walkLine(fen, uciMoves) {
  const chess = new Chess(fen);
  const out = [];
  for (const u of uciMoves) {
    try {
      const m = chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      if (!m) break;
      out.push({ san: m.san, uci: u, fen: chess.fen() });
    } catch { break; }
  }
  return out;
}

export class Board {
  constructor(el, { orientation = 'white', onMove = null } = {}) {
    this.el = el;
    this.onMove = onMove;
    this.cg = Chessground(el, {
      orientation,
      coordinates: true,
      animation: { duration: 150 },
      movable: { free: false, color: undefined, showDests: true, events: { after: (orig, dest) => this.onMove && this.onMove(orig, dest) } },
      draggable: { showGhost: true },
      drawable: { enabled: true, visible: true },
      highlight: { lastMove: true, check: true },
    });
  }

  /** Show a position. `movableFor` = 'white' | 'black' | null to allow input for that side. */
  set(fen, { lastMove = null, movableFor = null, shapes = [] } = {}) {
    const { dests, turn, inCheck } = legalDests(fen);
    this.cg.set({
      fen,
      turnColor: turn,
      check: inCheck,
      lastMove: lastMove ? [lastMove.slice(0, 2), lastMove.slice(2, 4)] : undefined,
      movable: { color: movableFor === turn ? movableFor : undefined, dests: movableFor === turn ? dests : new Map() },
      drawable: { autoShapes: shapes },
    });
  }

  /** Unbind chessground's document/window listeners; boards leak them otherwise. */
  destroy() { this.cg.destroy(); }

  shapes(shapes) { this.cg.setAutoShapes(shapes); }
  orient(color) { this.cg.set({ orientation: color }); }
  flip() { this.cg.toggleOrientation(); }
  get orientation() { return this.cg.state.orientation; }
}

/** Build arrow shapes for engine lines: first line green, others blue, played move red. */
export function lineShapes(lines, playedUci = null) {
  const shapes = [];
  lines.slice(0, 3).forEach((l, i) => {
    if (!l.uci) return;
    shapes.push({ orig: l.uci.slice(0, 2), dest: l.uci.slice(2, 4), brush: i === 0 ? 'green' : 'blue' });
  });
  if (playedUci && !lines.some(l => l.uci === playedUci)) {
    shapes.push({ orig: playedUci.slice(0, 2), dest: playedUci.slice(2, 4), brush: 'red' });
  }
  return shapes;
}
