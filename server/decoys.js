// Quiet-position decoys: positions from the player's own games where nothing
// went wrong, asked exactly like a real drill, so a session trains noticing
// that a moment IS critical, not just solving it once flagged. Split out of
// drills.js (which owns the store-locking and ladder CRUD) so the decoy
// heuristic BRIEFING flags as "needs tuning from use" can be iterated on its
// own; buildDecoys is still re-exported from drills.js for existing callers.
import { winProb } from '../public/shared.js';
import { acceptedLines } from './ease.js';
import { listGames, getGameCached, DEFAULT_USER } from './store.js';

// About one decoy per this many real due drills in a session.
const DECOY_RATIO = 4;

/** Would this move make a decoy? A quiet position the player HANDLED: his move
 * was genuinely fine, but the stored lines show real ways to go wrong. */
function decoyCandidate(m, moments) {
  if (!m.isPlayer || moments.has(m.ply)) return false;
  if (m.judgment !== 'best') return false; // his move was genuinely fine
  if (m.ply <= 10) return false;           // skip rote opening moves
  if (!m.lines || m.lines.length < 2) return false;
  const sign = m.color === 'white' ? 1 : -1;
  const spread = winProb(m.lines[0].cp * sign) - winProb(m.lines[m.lines.length - 1].cp * sign);
  return spread >= 10;                     // wrong choices existed
}

function makeDecoy(game, m) {
  const accepted = acceptedLines(m.lines, m.color === 'white' ? 1 : -1);
  return {
    id: `${game.id}:${m.ply}:decoy`,
    kind: 'decoy',
    ephemeral: true, // never stored, never graded into the ladder
    gameId: game.id,
    ply: m.ply,
    fen: m.fenBefore,
    sideToMove: m.color,
    playedUci: m.uci,
    playedSan: m.san,
    bestUci: m.bestUci,
    bestSan: m.bestSan,
    acceptedUci: [...new Set([...(accepted.length ? accepted : [m.bestUci].filter(Boolean)), m.uci])],
    lines: m.lines,
    phase: m.phase,
    judgment: m.judgment,
    loss: m.loss,
    clock: m.clock ?? null,
    tier: 'decoy',
    category: null,
    pattern: null,
    label: `${game.headers.White || '?'} vs ${game.headers.Black || '?'}${game.headers.Date ? ', ' + game.headers.Date : ''}`,
  };
}

/** DECOY_RATIO exported for dueDrills to size a session's decoy count from its
 * real due-drill count. */
export { DECOY_RATIO };

/** Ephemeral detection drills, built fresh from the player's own games. Every
 * stored drill is a position where an error is KNOWN to exist, so the deck
 * alone teaches "there is always something here" and does the hardest
 * real-game skill (spotting that this is a critical moment) for the player.
 * Decoys are quiet positions he handled correctly, asked exactly the same
 * way; the accepted answers include the fine move he actually played. */
export async function buildDecoys(count, rand = Math.random, userId = DEFAULT_USER) {
  if (count <= 0) return [];
  const index = (await listGames(userId)).filter(g => (g.status === 'analysed' || g.status === 'explained') && g.purpose !== 'scout' && g.playerColor);
  const order = [...index].sort(() => rand() - 0.5);
  const out = [];
  for (const entry of order) {
    if (out.length >= count) break;
    const game = await getGameCached(entry);
    if (!game?.analysis) continue;
    const moments = new Set(game.analysis.summary.moments);
    const candidates = game.analysis.moves.filter(m => decoyCandidate(m, moments));
    if (!candidates.length) continue;
    out.push(makeDecoy(game, candidates[Math.floor(rand() * candidates.length) % candidates.length]));
  }
  return out;
}
