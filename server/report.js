// Aggregate weakness report across all analysed games.
import { getGame, listGames, getDrills } from './store.js';
import { CATEGORIES } from './prompts.js';

const WEIGHT = { inaccuracy: 1, mistake: 2, blunder: 3 };

/** Weakness report for the tracked player (default), or for a scouted subject. */
export async function buildReport({ purpose = 'own', subject = null } = {}) {
  const index = (await listGames()).filter(g => (g.status === 'analysed' || g.status === 'explained')
    && g.purpose === purpose && (purpose === 'own' || g.subject === subject));
  const games = (await Promise.all(index.map(g => getGame(g.id)))).filter(g => g && g.playerColor && g.analysis);

  const byCategory = Object.fromEntries([...CATEGORIES, 'unexplained'].map(c => [c, { count: 0, weight: 0, moments: [] }]));
  const byPhase = { opening: { moves: 0, cpl: 0, acc: 0, moments: 0, weight: 0 }, middlegame: { moves: 0, cpl: 0, acc: 0, moments: 0, weight: 0 }, endgame: { moves: 0, cpl: 0, acc: 0, moments: 0, weight: 0 } };
  const byColor = { white: { games: 0, acc: 0, moments: 0, score: 0 }, black: { games: 0, acc: 0, moments: 0, score: 0 } };
  const patterns = new Map();
  const concepts = new Map();
  const timeline = [];
  const perGameCats = []; // per-game category weights, chronological, for the trend
  const time = { moves: 0, momentSpentTotal: 0, momentSpentN: 0, otherSpentTotal: 0, otherSpentN: 0, comfortBlunders: 0, underTwoMin: 0, fastMoments: 0 };
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
    // Time management from stored clocks (seconds remaining after each move).
    const tc = parseTimeControl(g.headers.TimeControl);
    const prevClock = { white: tc?.base ?? null, black: tc?.base ?? null };
    const momentSet = new Set(g.analysis.summary.moments);
    for (const m of g.analysis.moves) {
      let spent = null;
      if (m.clock != null && prevClock[m.color] != null) spent = Math.max(0, prevClock[m.color] - m.clock + (tc?.inc || 0));
      if (m.clock != null) prevClock[m.color] = m.clock;
      if (!m.isPlayer || m.clock == null) continue;
      time.moves++;
      if (momentSet.has(m.ply)) {
        if (spent != null) { time.momentSpentTotal += spent; time.momentSpentN++; if (spent <= 10) time.fastMoments++; }
        if (m.clock > 300 && m.loss >= 20) time.comfortBlunders++;
        if (m.clock < 120) time.underTwoMin++;
      } else if (spent != null) { time.otherSpentTotal += spent; time.otherSpentN++; }
    }

    const gameCats = {};
    for (const ply of g.analysis.summary.moments) {
      const m = g.analysis.moves[ply - 1];
      const e = g.explanations?.[ply];
      const w = WEIGHT[m.judgment] || 1;
      if (e) gameCats[e.category] = (gameCats[e.category] || 0) + w;
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
    perGameCats.push(gameCats);
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

  // Per-category trend: recent window vs earlier games, weighted moments per game.
  // Only shown with enough games, and only for categories with a real sample.
  let categoryTrend = null;
  if (perGameCats.length >= 8) {
    const n = Math.min(10, Math.floor(perGameCats.length / 2));
    const recent = perGameCats.slice(-n), prior = perGameCats.slice(0, -n);
    const avg = (list, cat) => list.reduce((s, gc) => s + (gc[cat] || 0), 0) / list.length;
    categoryTrend = CATEGORIES
      .filter(cat => byCategory[cat].count >= 3)
      .map(cat => {
        const r = avg(recent, cat), p = avg(prior, cat);
        return { category: cat, recentPerGame: +r.toFixed(2), priorPerGame: +p.toFixed(2), delta: +(r - p).toFixed(2), recentGames: recent.length, priorGames: prior.length };
      });
    if (!categoryTrend.length) categoryTrend = null;
  }

  // Drill performance from this machine's review history (the player's own drills).
  const dstore = purpose === 'own' ? await getDrills() : { drills: [] };
  const drillByPhase = {}, drillByCategory = {};
  let drillAttempts = 0, drillCorrect = 0;
  for (const d of dstore.drills) {
    for (const r of d.reviews || []) {
      drillAttempts++; if (r.correct) drillCorrect++;
      const bump = (obj, k) => { if (!k) return; const o = obj[k] = obj[k] || { attempts: 0, correct: 0 }; o.attempts++; if (r.correct) o.correct++; };
      bump(drillByPhase, d.phase);
      bump(drillByCategory, d.category);
    }
  }
  const drillStats = drillAttempts ? {
    attempts: drillAttempts,
    correct: drillCorrect,
    rate: Math.round((drillCorrect / drillAttempts) * 100),
    byPhase: drillByPhase,
    byCategory: drillByCategory,
  } : null;

  const timeManagement = time.moves ? {
    movesWithClock: time.moves,
    momentAvgSpent: time.momentSpentN ? Math.round(time.momentSpentTotal / time.momentSpentN) : null,
    otherAvgSpent: time.otherSpentN ? Math.round(time.otherSpentTotal / time.otherSpentN) : null,
    comfortBlunders: time.comfortBlunders,
    underTwoMinMoments: time.underTwoMin,
    fastMoments: time.fastMoments,
  } : null;

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
    categoryTrend,
    drillStats,
    timeManagement,
  };
}

/** Parse a PGN TimeControl header like "5400+30" or "600" into { base, inc } seconds. */
export function parseTimeControl(tc) {
  const m = (tc || '').match(/^(\d+)(?:\+(\d+))?$/);
  if (!m) return null;
  return { base: Number(m[1]), inc: Number(m[2] || 0) };
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
