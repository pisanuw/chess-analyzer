// Aggregate weakness report across all analysed games.
import { getGame, listGames } from './store.js';
import { CATEGORIES } from './prompts.js';

const WEIGHT = { inaccuracy: 1, mistake: 2, blunder: 3 };

export async function buildReport() {
  const index = (await listGames()).filter(g => g.status === 'analysed' || g.status === 'explained');
  const games = (await Promise.all(index.map(g => getGame(g.id)))).filter(g => g && g.playerColor && g.analysis);

  const byCategory = Object.fromEntries([...CATEGORIES, 'unexplained'].map(c => [c, { count: 0, weight: 0, moments: [] }]));
  const byPhase = { opening: { moves: 0, cpl: 0, acc: 0, moments: 0, weight: 0 }, middlegame: { moves: 0, cpl: 0, acc: 0, moments: 0, weight: 0 }, endgame: { moves: 0, cpl: 0, acc: 0, moments: 0, weight: 0 } };
  const byColor = { white: { games: 0, acc: 0, moments: 0, score: 0 }, black: { games: 0, acc: 0, moments: 0, score: 0 } };
  const patterns = new Map();
  const concepts = new Map();
  const timeline = [];
  let timePressure = 0, totalMoments = 0, totalJudged = { inaccuracy: 0, mistake: 0, blunder: 0 };

  for (const g of games.sort((a, b) => (a.headers.Date || '').localeCompare(b.headers.Date || '') || a.importedAt.localeCompare(b.importedAt))) {
    const color = g.playerColor;
    const p = g.analysis.summary[color];
    const score = resultScore(g.headers.Result, color);
    byColor[color].games++;
    byColor[color].acc += p.accuracy;
    byColor[color].moments += g.analysis.summary.moments.length;
    if (score != null) byColor[color].score += score;
    for (const m of g.analysis.moves) {
      if (!m.isPlayer) continue;
      const ph = byPhase[m.phase];
      ph.moves++; ph.cpl += m.cpLoss; ph.acc += m.accuracy;
    }
    timeline.push({
      gameId: g.id,
      date: g.headers.Date || '',
      label: `${g.headers.White || '?'} - ${g.headers.Black || '?'}`,
      opponent: color === 'white' ? g.headers.Black : g.headers.White,
      color,
      result: g.headers.Result || '*',
      score,
      accuracy: p.accuracy,
      acpl: p.acpl,
      moments: g.analysis.summary.moments.length,
    });
    for (const ply of g.analysis.summary.moments) {
      const m = g.analysis.moves[ply - 1];
      const e = g.explanations?.[ply];
      const w = WEIGHT[m.judgment] || 1;
      totalMoments++;
      if (totalJudged[m.judgment] != null) totalJudged[m.judgment]++;
      byPhase[m.phase].moments++;
      byPhase[m.phase].weight += w;
      const ref = { gameId: g.id, ply, san: m.san, moveNumber: m.moveNumber, color: m.color, judgment: m.judgment, phase: m.phase, loss: m.loss, label: timeline[timeline.length - 1].label, date: g.headers.Date || '', pattern: e?.pattern || null, category: e?.category || null };
      const cat = e && byCategory[e.category] ? e.category : 'unexplained';
      byCategory[cat].count++;
      byCategory[cat].weight += w;
      byCategory[cat].moments.push(ref);
      if (e) {
        if (e.time_pressure) timePressure++;
        const key = normalizeKey(e.pattern);
        if (!patterns.has(key)) patterns.set(key, { pattern: e.pattern, count: 0, weight: 0, categories: {}, moments: [] });
        const pat = patterns.get(key);
        pat.count++; pat.weight += w; pat.moments.push(ref);
        pat.categories[e.category] = (pat.categories[e.category] || 0) + 1;
        if (e.concept) {
          const ck = normalizeKey(e.concept);
          concepts.set(ck, { concept: e.concept, count: (concepts.get(ck)?.count || 0) + 1 });
        }
      }
    }
  }

  for (const ph of Object.values(byPhase)) {
    ph.acpl = ph.moves ? Math.round(ph.cpl / ph.moves) : null;
    ph.accuracy = ph.moves ? +(ph.acc / ph.moves).toFixed(1) : null;
    ph.momentsPer100 = ph.moves ? +((ph.moments / ph.moves) * 100).toFixed(1) : null;
    delete ph.cpl; delete ph.acc;
  }
  for (const c of Object.values(byColor)) {
    c.accuracy = c.games ? +(c.acc / c.games).toFixed(1) : null;
    c.scorePct = c.games ? +((c.score / c.games) * 100).toFixed(0) : null;
    delete c.acc; delete c.score;
  }

  const focus = Object.entries(byCategory)
    .filter(([k, v]) => k !== 'unexplained' && v.count > 0)
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, 3)
    .map(([k, v]) => ({ category: k, count: v.count, weight: v.weight }));

  return {
    games: games.length,
    totalMoments,
    totalJudged,
    timePressure,
    overallAccuracy: games.length ? +(games.reduce((s, g) => s + g.analysis.summary[g.playerColor].accuracy, 0) / games.length).toFixed(1) : null,
    focus,
    byCategory,
    byPhase,
    byColor,
    patterns: [...patterns.values()].sort((a, b) => b.weight - a.weight),
    concepts: [...concepts.values()].sort((a, b) => b.count - a.count).slice(0, 15),
    timeline,
  };
}

function resultScore(result, color) {
  if (result === '1-0') return color === 'white' ? 1 : 0;
  if (result === '0-1') return color === 'black' ? 1 : 0;
  if (result === '1/2-1/2') return 0.5;
  return null;
}

function normalizeKey(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
