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

/** Overlay asking which piece to promote to; resolves 'q'|'r'|'b'|'n', or null if dismissed. */
function pickPromotion(color) {
  return new Promise(resolve => {
    const glyphs = color === 'w' ? { q: '♕', r: '♖', b: '♗', n: '♘' } : { q: '♛', r: '♜', b: '♝', n: '♞' };
    const div = document.createElement('div');
    div.className = 'promo-overlay';
    div.innerHTML = `<div class="promo">${['q', 'r', 'b', 'n'].map(p => `<button data-p="${p}" title="${p}">${glyphs[p]}</button>`).join('')}</div>`;
    const done = p => { div.remove(); document.removeEventListener('keydown', onKey); resolve(p); };
    const onKey = e => { if (e.key === 'Escape') done(null); if ('qrbn'.includes(e.key)) done(e.key); };
    div.addEventListener('click', e => done(e.target.closest('button[data-p]')?.dataset.p || null));
    document.addEventListener('keydown', onKey);
    document.body.appendChild(div);
  });
}

// A move typed as SAN already names its promotion piece; the input hands it to
// the next applyMove so the overlay is not asked a second time.
let hintedPromotion = null;

/** Apply a move (orig, dest) to a FEN; asks which piece on promotion. Resolves { san, uci, fen } or null. */
export async function applyMove(fen, orig, dest) {
  const chess = new Chess(fen);
  const hinted = hintedPromotion; hintedPromotion = null;
  try {
    let promotion = 'q';
    const piece = chess.get(orig);
    if (piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) {
      promotion = hinted || await pickPromotion(piece.color);
      if (!promotion) return null; // dismissed: the caller re-sets the board
    }
    const m = chess.move({ from: orig, to: dest, promotion });
    if (!m) return null;
    return { san: m.san, uci: m.from + m.to + (m.promotion || ''), fen: chess.fen() };
  } catch { return null; }
}

/** Terminal state of a position: { over: 'checkmate'|'stalemate'|'draw'|null, winner? }. */
export function gameStatus(fen) {
  const chess = new Chess(fen);
  if (chess.isCheckmate()) return { over: 'checkmate', winner: chess.turn() === 'w' ? 'black' : 'white' };
  if (chess.isStalemate()) return { over: 'stalemate' };
  if (chess.isDraw()) return { over: 'draw' };
  return { over: null };
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
  /** `input: true` mounts a text box under the board where a move can be typed
   * in algebraic notation (Nf3, exd5, O-O, e8=Q) and entered with the keyboard:
   * faster for a strong player and the accessible alternative to dragging. */
  constructor(el, { orientation = 'white', onMove = null, input = false } = {}) {
    this.el = el;
    this.onMove = onMove;
    this.fen = null;
    this.movable = null;
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', input ? 'Chess board. Type a move in the box below to play by keyboard.' : 'Chess board');
    this.cg = Chessground(el, {
      orientation,
      coordinates: true,
      animation: { duration: 150 },
      movable: { free: false, color: undefined, showDests: true, events: { after: (orig, dest) => this.onMove && this.onMove(orig, dest) } },
      draggable: { showGhost: true },
      drawable: { enabled: true, visible: true },
      highlight: { lastMove: true, check: true },
    });
    if (input) this.mountInput();
  }

  mountInput() {
    const wrap = document.createElement('div');
    wrap.className = 'san-input';
    wrap.innerHTML = '<input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Type a move in algebraic notation and press Enter" placeholder="Type a move, e.g. Nf3, then Enter" disabled>';
    // Sit under the board's aspect box when there is one, else right after the board.
    const anchor = this.el.parentElement?.classList.contains('board-wrap') ? this.el.parentElement : this.el;
    anchor.insertAdjacentElement('afterend', wrap);
    this.inputWrap = wrap;
    this.input = wrap.querySelector('input');
    this.input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const text = this.input.value.trim();
      if (!text || !this.fen || !this.movable) return;
      let m = null;
      try { m = new Chess(this.fen).move(text); } catch { m = null; }
      if (!m) {
        this.input.setAttribute('aria-invalid', 'true');
        this.input.classList.add('bad');
        setTimeout(() => this.input?.classList.remove('bad'), 600);
        return;
      }
      this.input.value = '';
      this.input.removeAttribute('aria-invalid');
      hintedPromotion = m.promotion || null;
      this.cg.move(m.from, m.to);
      if (this.onMove) this.onMove(m.from, m.to);
    });
  }

  /** Show a position. `movableFor` = 'white' | 'black' | null to allow input for that side. */
  set(fen, { lastMove = null, movableFor = null, shapes = [] } = {}) {
    const { dests, turn, inCheck } = legalDests(fen);
    // A caller asking to move for the side NOT to move yields a dead, unmovable
    // board with no other signal: surface a likely FEN/side or off-by-one bug.
    if (movableFor && movableFor !== turn) console.warn(`Board.set: movableFor "${movableFor}" but ${turn} is to move; board will be read-only`);
    this.fen = fen;
    this.movable = movableFor === turn ? movableFor : null;
    if (this.input) this.input.disabled = !this.movable;
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
  destroy() { this.cg.destroy(); this.inputWrap?.remove(); this.input = null; }

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
