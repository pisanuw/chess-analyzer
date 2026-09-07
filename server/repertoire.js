// Opening repertoire: group analysed games by colour and first plies, find where preparation ends.
import { getGame, listGames } from './store.js';

const LINE_PLIES = 8;

export async function buildRepertoire({ purpose = 'own', subject = null } = {}) {
  const index = (await listGames()).filter(g => (g.status === 'analysed' || g.status === 'explained')
    && g.purpose === purpose && (purpose === 'own' || g.subject === subject));
  const games = (await Promise.all(index.map(g => getGame(g.id)))).filter(g => g && g.playerColor && g.analysis);
  const lines = new Map();
  for (const g of games) {
    const sans = g.analysis.moves.slice(0, LINE_PLIES).map(m => m.san);
    const key = `${g.playerColor}|${sans.join(' ')}`;
    if (!lines.has(key)) lines.set(key, { color: g.playerColor, line: sans, eco: g.headers.ECO || '', games: [], score: 0, scored: 0, acc: 0, prepEnds: [] });
    const l = lines.get(key);
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
    line: l.line,
    eco: l.eco,
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
