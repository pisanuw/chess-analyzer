// Pure chess-math helpers used by BOTH sides: the server imports this file
// directly (plain ESM, no browser APIs) and the frontend loads it statically.
// One definition each for the values that used to be duplicated across
// server/ and public/ with "keep in sync" comments.

/** Lichess win-probability model, 0..100, from the perspective of the side the cp is for. */
export function winProb(cp) {
  const c = Math.max(-1500, Math.min(1500, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

// "Close enough to best" band for guesses and drills, in win-probability
// points: the same currency as judgments and thresholds, so acceptance is
// strict in balanced positions and forgiving in already-decided ones.
export const WP_ACCEPT = 3;

/** "+0.42" / "-1.10", "#3" / "#-3" for mates, '' for null. cp is from White's side. */
export function formatEval(cp) {
  if (cp == null) return '';
  if (Math.abs(cp) >= 9800) return (cp > 0 ? '#' : '#-') + (10000 - Math.abs(cp));
  return (cp >= 0 ? '+' : '') + (cp / 100).toFixed(2);
}

/** The score of a PGN result for `color` (1, 0.5, 0), or null for an unknown result. */
export function resultScore(result, color) {
  if (result === '1-0') return color === 'white' ? 1 : 0;
  if (result === '0-1') return color === 'black' ? 1 : 0;
  if (result === '1/2-1/2') return 0.5;
  return null;
}

/** Lowercase alphanumeric key for aggregating free-text names (patterns, concepts). */
export function normalizeKey(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Placement, side to move, and castling: the position identity used wherever
 * transpositions merge (repertoire lines, scout books, the opening clash). */
export function posKeyOf(fen) {
  return fen.split(' ').slice(0, 3).join(' ');
}

/** "1.e4 c5 2.Nf3" from a SAN list that starts with White's first move. */
export function fmtLine(sans) {
  return sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}.` : '') + s).join(' ');
}

/** The lichess analysis board for a SAN line from the start position. */
export function lichessUrl(sans) {
  return `https://lichess.org/analysis/pgn/${encodeURIComponent(fmtLine(sans))}`;
}

/** A sortable number for a PGN date, padded or not ("2026.7.29", "2026-07-29",
 * "2026.??.??"): YYYYMMDD, with missing parts as zero, 0 when there is no year.
 * String order ranks "2026.7.29" after "2026.10.01"; this does not. */
export function pgnDateKey(s) {
  const str = String(s || '');
  const m = str.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) return (+m[1]) * 10000 + (+m[2]) * 100 + (+m[3]);
  const y = str.match(/^(\d{4})/);
  return y ? (+y[1]) * 10000 : 0;
}

/** Parse a PGN TimeControl header like "5400+30" or "600" into { base, inc } seconds. */
export function parseTimeControl(tc) {
  const m = (tc || '').match(/^(\d+)(?:\+(\d+))?$/);
  if (!m) return null;
  return { base: Number(m[1]), inc: Number(m[2] || 0) };
}

/** classical | rapid | blitz | unknown, from a TimeControl header (FIDE bands on
 * the time for 60 moves) or, failing that, words in the event name. */
export function classifyTimeControl(tc, event = '') {
  const t = parseTimeControl(tc);
  if (t) {
    const sixty = t.base + 60 * t.inc;
    return sixty >= 3600 ? 'classical' : sixty >= 600 ? 'rapid' : 'blitz';
  }
  const e = String(event || '').toLowerCase();
  if (/\b(blitz|bullet)\b/.test(e)) return 'blitz';
  if (/\b(rapid|quick|active)\b/.test(e)) return 'rapid';
  if (/\b(classical|standard)\b/.test(e)) return 'classical';
  return 'unknown';
}

/** Seconds spent on each move, aligned with `moves` (null where unknown).
 * [%clk] comments store seconds REMAINING after the move; spent time is the
 * difference from the mover's previous clock (or the base time control),
 * plus the increment they got back. */
export function spentPerMove(moves, timeControl) {
  const tc = parseTimeControl(timeControl);
  const prev = { white: tc ? tc.base : null, black: tc ? tc.base : null };
  return moves.map(m => {
    let spent = null;
    if (m.clock != null && prev[m.color] != null) spent = Math.max(0, prev[m.color] - m.clock + (tc ? tc.inc : 0));
    if (m.clock != null) prev[m.color] = m.clock;
    return spent;
  });
}
