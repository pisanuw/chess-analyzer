// Opening repertoire: group analysed games by colour and first plies, find where preparation ends.
import { DEFAULT_USER } from './store.js';
import { gamesForSubject } from './subjects.js';
import { analysedOwnGames, gamesKey } from './report.js';
import { memo } from './memo.js';
import { resultScore, posKeyOf } from '../public/shared.js';

const LINE_PLIES = 8;

/** Most frequent key in a count map (ties: first inserted). */
const topKey = map => [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

/** Memoised on the game files' fingerprint, like the report; cloned on return. */
export async function buildRepertoire({ purpose = 'own', subject = null, userId = DEFAULT_USER, color = null } = {}) {
  const key = `${await gamesKey({ purpose, subject, userId })}|${color || 'all'}`;
  return structuredClone(await memo('repertoire', key, async () => {
    let games = purpose === 'scout' ? await gamesForSubject(subject) : await analysedOwnGames(userId);
    if (color) games = games.filter(g => g.playerColor === color);
    return repertoireOf(games);
  }));
}

export function repertoireOf(games) {
  const lines = new Map();
  for (const g of games) {
    const opening = g.analysis.moves.slice(0, LINE_PLIES);
    // Group by the POSITION after the opening plies, not the move order, so
    // transpositions merge. Placement, turn, and castling identify it; en
    // passant and the counters would split identical positions spuriously.
    const posKey = opening.length ? posKeyOf(opening[opening.length - 1].fenAfter) : 'start';
    const key = `${g.playerColor}|${posKey}`;
    if (!lines.has(key)) lines.set(key, { color: g.playerColor, variants: new Map(), ecos: new Map(), games: [], score: 0, scored: 0, acc: 0, prepEnds: [] });
    const l = lines.get(key);
    const san = opening.map(m => m.san).join(' ');
    l.variants.set(san, (l.variants.get(san) || 0) + 1);
    if (g.headers.ECO) l.ecos.set(g.headers.ECO, (l.ecos.get(g.headers.ECO) || 0) + 1);
    const score = resultScore(g.headers.Result, g.playerColor);
    // Earliest opening move by the player that left the engine's list or lost ≥10 win-%:
    // a practical marker for "this is where preparation or understanding ran out".
    const dev = g.analysis.moves.find(m => m.isPlayer && m.phase === 'opening' && (m.playedRank == null || m.loss >= 10));
    l.games.push({ id: g.id, date: g.headers.Date || '', label: `${g.headers.White || '?'} - ${g.headers.Black || '?'}`, result: g.headers.Result || '*', accuracy: g.analysis.summary[g.playerColor].accuracy, deviationPly: dev?.ply ?? null });
    if (score != null) { l.score += score; l.scored++; }
    l.acc += g.analysis.summary[g.playerColor].accuracy;
    if (dev) l.prepEnds.push(dev.ply);
  }
  return [...lines.values()].map(l => ({
    color: l.color,
    line: (topKey(l.variants) || '').split(' ').filter(Boolean), // most common move order
    moveOrders: l.variants.size,
    eco: topKey(l.ecos) || '',
    count: l.games.length,
    scorePct: l.scored ? Math.round((l.score / l.scored) * 100) : null,
    accuracy: +(l.acc / l.games.length).toFixed(1),
    prepEndsPly: l.prepEnds.length ? Math.min(...l.prepEnds) : null,
    games: l.games.sort((a, b) => (b.date || '').localeCompare(a.date || '')),
  })).sort((a, b) => a.color.localeCompare(b.color) || b.count - a.count);
}
