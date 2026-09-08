// Opening repertoire: group analysed games by colour and first plies, find where preparation ends.
import { getGame, listGames } from './store.js';
import { gamesForSubject } from './subjects.js';

const LINE_PLIES = 8;

/** Most frequent key in a count map (ties: first inserted). */
const topKey = map => [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

export async function buildRepertoire({ purpose = 'own', subject = null } = {}) {
  let games;
  if (purpose === 'scout') {
    games = await gamesForSubject(subject);
  } else {
    const index = (await listGames()).filter(g => (g.status === 'analysed' || g.status === 'explained') && g.purpose === 'own');
    games = (await Promise.all(index.map(g => getGame(g.id)))).filter(g => g && g.playerColor && g.analysis);
  }
  const lines = new Map();
  for (const g of games) {
    const opening = g.analysis.moves.slice(0, LINE_PLIES);
    // Group by the POSITION after the opening plies, not the move order, so
    // transpositions merge. Placement, turn, and castling identify it; en
    // passant and the counters would split identical positions spuriously.
    const posKey = opening.length ? opening[opening.length - 1].fenAfter.split(' ').slice(0, 3).join(' ') : 'start';
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

function resultScore(result, color) {
  if (result === '1-0') return color === 'white' ? 1 : 0;
  if (result === '0-1') return color === 'black' ? 1 : 0;
  if (result === '1/2-1/2') return 0.5;
  return null;
}
