// Games featuring a scouted subject: scout imports as-is, plus the player's own
// games against them, flipped so the opponent is the studied side. The flip is
// derived from stored per-move analysis (both colours are already evaluated), so
// no engine work is needed. Own games contribute engine data only: explanations
// exist for the player's moments, not the opponent's, so categories stay
// "unexplained" unless the subject's other games are imported as scout games.
import { getGame, listAllGames, getSettings } from './store.js';
import { summarize } from './analyze.js';

export async function gamesForSubject(subject) {
  const settings = await getSettings();
  const out = [];
  for (const e of await listAllGames()) {
    if (e.status !== 'analysed' && e.status !== 'explained') continue;
    if (e.purpose === 'scout') {
      if (e.subject !== subject) continue;
      const g = await getGame(e.id);
      if (g?.analysis && g.playerColor) out.push(g);
      continue;
    }
    if (!e.playerColor) continue;
    const oppName = e.playerColor === 'white' ? e.black : e.white;
    if (oppName !== subject) continue;
    const g = await getGame(e.id);
    if (g?.analysis) out.push(flipToOpponent(g, settings));
  }
  return out;
}

/** View an own game from the opponent's side: their moments, their summary. */
export function flipToOpponent(g, settings) {
  const color = g.playerColor === 'white' ? 'black' : 'white';
  const moves = g.analysis.moves.map(m => ({ ...m, isPlayer: m.color === color }));
  const summary = { ...g.analysis.summary, ...summarize(moves, color, settings.momentThreshold ?? 12) };
  return {
    ...g,
    playerColor: color,
    purpose: 'scout',
    subject: (color === 'white' ? g.headers.White : g.headers.Black) || 'opponent',
    explanations: {},
    gameSummary: null,
    analysis: { ...g.analysis, moves, summary },
  };
}
