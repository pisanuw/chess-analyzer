// Drill grading math: the SM-2-lite ease/interval schedule, and which of a
// position's engine lines count as "correct" for a mover. Pure, dependency-free
// (besides the shared chess-math module) so the two knobs BRIEFING already
// flags as "needs tuning from use" (ease constants, the accepted-move band)
// can be iterated without touching drills.js's store-locking and CRUD code.
import { winProb, WP_ACCEPT } from '../public/shared.js';

export const LADDER_DAYS = [1, 3, 7, 14, 30, 60];

// Per-drill ease (SM-2 lite). The ladder gives the shape of the schedule; ease
// scales it per drill from the evidence the reviews accumulate: grades, answer
// speed, and stated confidence. A drill the player finds easy (fast, sure,
// graded easy) spreads its intervals out; one that keeps lapsing, or that the
// player was sure about and got wrong, comes back sooner. Bounded so a single
// bad day cannot collapse a mature drill or a lucky streak park one forever.
export const EASE_DEFAULT = 2.5;
export const EASE_MIN = 1.3;
export const EASE_MAX = 3.2;
const FAST_MS = 5000;   // a recognised pattern, not a re-derived one
const SLOW_MS = 30000;  // laborious: the interval should not stretch yet
export const CONFIDENCE = ['sure', 'likely', 'guess'];

const clampEase = e => Math.min(EASE_MAX, Math.max(EASE_MIN, +e.toFixed(2)));

/** Days until the next review for a ladder step at a given ease: the ladder
 * day count scaled by ease relative to the default (so an untouched drill
 * keeps the documented 1, 3, 7, 14, 30, 60). Never under one day. */
export function intervalDays(step, ease = EASE_DEFAULT) {
  return Math.max(1, Math.round(LADDER_DAYS[Math.min(step, LADDER_DAYS.length - 1)] * (ease / EASE_DEFAULT) * 10) / 10);
}

/** The ease after one review. Exported for the tests and the report. */
export function nextEase(ease, { grade, correct, ms = null, confidence = null }) {
  let e = ease ?? EASE_DEFAULT;
  if (!correct || grade === 'again') {
    e -= 0.2;
    if (confidence === 'sure') e -= 0.1;   // sure and wrong: the worst kind of miss
  } else {
    if (grade === 'easy') e += 0.15;
    if (Number.isFinite(ms) && ms >= 0 && ms <= FAST_MS) e += 0.05;
    else if (Number.isFinite(ms) && ms >= SLOW_MS) e -= 0.05;
    if (confidence === 'guess') e -= 0.05;  // right by luck is not knowledge yet
  }
  return clampEase(e);
}

/** UCI moves of the lines close enough to best. `sign` converts the stored
 * White-perspective cp to the mover's perspective. */
export function acceptedLines(lines, sign) {
  const best = lines[0];
  if (best?.cp == null) return [];
  // When the best move forces mate, winProb saturates near 100% and the band
  // would accept any clearly-winning-but-not-mating move. Require another mate
  // for the same side instead. Stored `mate` is from the side to move (the
  // mover), so its sign already reads from the mover's perspective.
  if (best.mate != null) {
    const moverMates = best.mate > 0;
    return lines.filter(l => l.mate != null && (l.mate > 0) === moverMates).map(l => l.uci);
  }
  const bestWp = winProb(best.cp * sign);
  return lines.filter(l => l.cp != null && bestWp - winProb(l.cp * sign) <= WP_ACCEPT).map(l => l.uci);
}
