// Play a position out against the strength-limited sparring engine. One
// controller per play-out: it owns the running position, drives the board, and
// calls `render()` whenever something changes; the caller draws the panel from
// `state`. Evals stay hidden until the caller asks for the verdict.
import { api, winProb, WP_ACCEPT } from './api.js';
import { applyMove, gameStatus } from './board.js';

export function createPlayout({ board, fen, seat, elo, startEval = null, render }) {
  const state = { fen, seat, elo, sans: [], over: null, busy: false, assess: null, startEval, stopped: false };
  board.set(fen, { movableFor: seat, shapes: [] });
  render(state);

  async function move(orig, dest) {
    if (state.busy || state.over || state.stopped) return;
    const res = await applyMove(state.fen, orig, dest);
    if (!res) return board.set(state.fen, { movableFor: seat });
    state.fen = res.fen; state.sans.push(res.san); state.assess = null;
    let status = gameStatus(res.fen);
    if (status.over) { state.over = status; board.set(state.fen, { lastMove: res.uci }); return render(state); }
    state.busy = true;
    board.set(state.fen, { lastMove: res.uci });
    render(state);
    try {
      const r = await api.playoutMove(state.fen, state.elo);
      if (state.stopped) return;
      state.fen = r.fen; state.sans.push(r.san);
      status = gameStatus(r.fen);
      if (status.over) state.over = status;
      state.busy = false;
      board.set(state.fen, { lastMove: r.uci, movableFor: state.over ? null : seat });
    } catch (err) {
      if (state.stopped) return;
      state.busy = false;
      state.error = err.message;
      board.set(state.fen, { movableFor: seat });
    }
    render(state);
  }

  async function assess() {
    if (state.busy || state.stopped) return;
    state.busy = true;
    render(state);
    try { state.assess = await api.playoutAssess(state.fen); }
    catch (err) { state.error = err.message; }
    if (!state.stopped) { state.busy = false; render(state); }
  }

  /** The verdict line once the game ended or was assessed, from the seat's side. */
  function verdict() {
    const wpFor = cp => (seat === 'white' ? winProb(cp) : 100 - winProb(cp));
    const startWp = state.startEval != null ? wpFor(state.startEval) : null;
    if (state.over) {
      const won = state.over.over === 'checkmate' && state.over.winner === seat;
      const lost = state.over.over === 'checkmate' && !won;
      return { good: won || (!lost && startWp != null && startWp < 50), text: won ? 'Checkmate: you converted it.' : lost ? 'Checkmate against you.' : state.over.over === 'stalemate' ? 'Stalemate.' : 'Drawn.' };
    }
    if (!state.assess) return null;
    const nowWp = wpFor(state.assess.cp);
    const held = startWp == null ? nowWp >= 50 - WP_ACCEPT : nowWp >= startWp - WP_ACCEPT;
    return { good: held, text: `Engine verdict: winning chances ${nowWp.toFixed(0)}%${startWp != null ? ` (started at ${startWp.toFixed(0)}%)` : ''}.${held ? ' Held.' : ' Ground given up.'}` };
  }

  return { state, move, assess, verdict, stop() { state.stopped = true; } };
}
