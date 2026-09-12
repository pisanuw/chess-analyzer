// Puzzles: solvable positions derived from analysed games, served on demand for
// free-solve practice (no schedule, no per-puzzle state). Everything a puzzle
// needs is already stored per move by analyze.js (fenBefore, the engine's best
// move, the MultiPV lines with evals), so this module is pure derivation: no
// engine, no LLM, no writes. That also means the read-only hosted mirror serves
// puzzles too. Drills are the spaced-repetition twin of this; the two share the
// acceptedLines band so "correct" means the same thing in both.
import { listGames, loadGames, indexFingerprint, DEFAULT_USER } from './store.js';
import { winProb } from '../public/shared.js';
import { acceptedLines } from './ease.js';
import { memo } from './memo.js';

const MIN_PLY = 8;            // skip book opening moves: a puzzle is a real decision
const WIN_FLOOR = 66;         // the best line must be clearly winning for the mover
const ONLY_MOVE_SPREAD = 20;  // ...and much better than the alternative, so finding THE move is the point

const signOf = color => (color === 'white' ? 1 : -1);

/** Win probability of a stored line from the mover's perspective (stored cp is
 * White's, stored mate is already the mover's). */
function moverWp(line, sign) {
  if (line?.mate != null) return line.mate > 0 ? 100 : 0;
  return winProb((line?.cp ?? 0) * sign);
}

/** Does the position before this move hold a decisive tactic for the side to
 * move: a forced mate, or a clearly winning move that beats the alternatives by
 * a wide margin (an "only move" the player must find)? Engine-derived only. */
export function decisiveTactic(m) {
  if (!m.lines?.length || m.ply < MIN_PLY) return false;
  const sign = signOf(m.color);
  const best = m.lines[0];
  if (best.mate != null) return best.mate > 0; // forced mate for the mover
  if (moverWp(best, sign) < WIN_FLOOR) return false;
  const second = m.lines[1];
  if (!second) return false; // only one line stored: cannot tell the move is unique
  return moverWp(best, sign) - moverWp(second, sign) >= ONLY_MOVE_SPREAD;
}

/** True when the tracked player was on move here and did not find an accepted move. */
function missedByPlayer(m) {
  if (!m.isPlayer || !decisiveTactic(m)) return false;
  const accepted = acceptedLines(m.lines, signOf(m.color));
  return !(accepted.length ? accepted : [m.bestUci]).includes(m.uci);
}

// The three switchable sources. `ownOnly` drops opponent-scouting games; `pick`
// decides whether a move becomes a puzzle (moments also gets the game's flagged
// ply set, the same pool Drills draws from).
const SOURCES = {
  tactics: { ownOnly: false, pick: (m, moments) => decisiveTactic(m) },
  moments: { ownOnly: true, pick: (m, moments) => moments.has(m.ply) },
  missed: { ownOnly: true, pick: (m, moments) => missedByPlayer(m) },
};

export const PUZZLE_SOURCES = Object.keys(SOURCES);

function makePuzzle(game, m, source) {
  const accepted = acceptedLines(m.lines, signOf(m.color));
  return {
    id: `${game.id}:${m.ply}`,
    source,
    gameId: game.id,
    ply: m.ply,
    fen: m.fenBefore,
    sideToMove: m.color,
    orientation: m.color, // solve from the mover's side of the board
    bestUci: m.bestUci,
    bestSan: m.bestSan,
    acceptedUci: accepted.length ? accepted : [m.bestUci].filter(Boolean),
    lines: m.lines,
    playedUci: m.uci,
    playedSan: m.san,
    playedByPlayer: !!m.isPlayer,
    judgment: m.judgment,
    loss: m.loss,
    phase: m.phase,
    label: `${game.headers.White || '?'} vs ${game.headers.Black || '?'}${game.headers.Date ? ', ' + game.headers.Date : ''}`,
  };
}

/** Every puzzle for a source, shuffled, capped at `limit`. `total` is the full
 * candidate count so the UI can say how many exist. `rand` is injectable for
 * deterministic tests. */
export async function buildPuzzles(source = 'tactics', limit = 30, rand = Math.random, userId = DEFAULT_USER) {
  const spec = SOURCES[source] || SOURCES.tactics;
  const resolved = SOURCES[source] ? source : 'tactics';
  // A member's puzzles come from the games they can see: their own games plus the
  // shared scout library (tactics can draw on scout games; moments/missed are own only).
  const index = (await listGames(userId)).filter(e => (e.status === 'analysed' || e.status === 'explained') && !(spec.ownOnly && (e.purpose || 'own') === 'scout'));
  // The candidate pool is memoised on the games' fingerprint; only the shuffle
  // and the cut are per request.
  const pool = await memo('puzzles', `${resolved}|${indexFingerprint(index)}`, async () => {
    const found = [];
    for (const game of await loadGames(index)) {
      if (!game.analysis?.moves) continue;
      const moments = new Set(game.analysis.summary?.moments || []);
      for (const m of game.analysis.moves) {
        if (spec.pick(m, moments)) found.push(makePuzzle(game, m, resolved));
      }
    }
    return found;
  });
  const out = [...pool];
  for (let i = out.length - 1; i > 0; i--) { // Fisher-Yates so the deck is fresh each request
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return { source: resolved, total: out.length, puzzles: out.slice(0, limit) };
}
