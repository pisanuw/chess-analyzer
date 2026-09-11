// Deterministic tendencies from stored analysis: what the win-probability curve
// of every analysed game says about how a player handles winning, losing, and
// turning positions. No engine and no LLM: wpAfter is already stored per move,
// so these are the real conversion and defence numbers, independent of which
// moments the coach model happened to label.
import { resultScore } from '../public/shared.js';

const WINNING = 75;     // win probability that counts as "clearly winning"
const LOSING = 25;      // ...and "clearly losing"
const SWING_FROM = 70;  // a collapse: from at least this...
const SWING_TO = 30;    // ...down to at most this...
const SWING_PLIES = 10; // ...within this many plies (comebacks are the mirror)
const TURN_BAND = 25;   // the eval "turned" once it left 50 by this much

/** Win probability after each ply from `color`'s side (stored wpAfter is the mover's). */
export function curveFor(moves, color) {
  return moves.map(m => (m.color === color ? m.wpAfter : 100 - m.wpAfter));
}

/** Count swings of at least SWING_FROM to SWING_TO (or the reverse) within
 * SWING_PLIES, each counted once (the search resumes after the swing ends). */
function swings(wp) {
  let collapses = 0, comebacks = 0, i = 0;
  while (i < wp.length) {
    let jumped = false;
    for (let j = i + 1; j <= Math.min(wp.length - 1, i + SWING_PLIES); j++) {
      if (wp[i] >= SWING_FROM && wp[j] <= SWING_TO) { collapses++; i = j; jumped = true; break; }
      if (wp[i] <= SWING_TO && wp[j] >= SWING_FROM) { comebacks++; i = j; jumped = true; break; }
    }
    if (!jumped) i++;
  }
  return { collapses, comebacks };
}

/** Tendencies over analysed games (each with playerColor, headers.Result, and
 * analysis.moves): conversion and hold rates, collapses and comebacks, the
 * phase in which the evaluation first turned, draw rate, and average length. */
export function curveTendencies(games) {
  const t = {
    games: 0, decisive: 0, draws: 0, plies: 0,
    conversion: { reached: 0, won: 0, drawn: 0 },
    hold: { reached: 0, saved: 0 },
    collapses: 0, comebacks: 0,
    turnPhase: { opening: 0, middlegame: 0, endgame: 0, none: 0 },
  };
  for (const g of games) {
    const color = g.playerColor;
    const moves = g.analysis?.moves;
    if (!color || !moves?.length) continue;
    t.games++;
    const score = resultScore(g.headers?.Result, color);
    if (score === 0.5) t.draws++; else if (score != null) t.decisive++;
    t.plies += moves.length;
    const wp = curveFor(moves, color);
    if (Math.max(...wp) >= WINNING) { t.conversion.reached++; if (score === 1) t.conversion.won++; else if (score === 0.5) t.conversion.drawn++; }
    if (Math.min(...wp) <= LOSING) { t.hold.reached++; if (score === 0.5 || score === 1) t.hold.saved++; }
    const s = swings(wp);
    t.collapses += s.collapses; t.comebacks += s.comebacks;
    const turn = wp.findIndex(v => Math.abs(v - 50) >= TURN_BAND);
    t.turnPhase[turn >= 0 ? moves[turn].phase : 'none']++;
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
  return {
    games: t.games,
    conversion: { ...t.conversion, rate: pct(t.conversion.won, t.conversion.reached) },
    hold: { ...t.hold, rate: pct(t.hold.saved, t.hold.reached) },
    collapses: t.collapses,
    comebacks: t.comebacks,
    turnPhase: t.turnPhase,
    drawRate: pct(t.draws, t.draws + t.decisive),
    avgMoves: t.games ? Math.round(t.plies / t.games / 2) : null,
  };
}
