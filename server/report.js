// Aggregate weakness report across all analysed games.
import { getGame, listGames, getDrills, getForeignDrillStores, DEFAULT_USER } from './store.js';
import { gamesForSubject } from './subjects.js';
import { parseTimeControl, spentPerMove } from '../public/shared.js';
import { CATEGORIES } from './prompts.js';

export { parseTimeControl };

const WEIGHT = { inaccuracy: 1, mistake: 2, blunder: 3 };

/** Weakness report for the tracked player (default), or for a scouted subject
 * (scout imports plus the player's own games against them, flipped). */
export async function buildReport({ purpose = 'own', subject = null, userId = DEFAULT_USER } = {}) {
  let games;
  if (purpose === 'scout') {
    games = await gamesForSubject(subject);
  } else {
    const index = (await listGames(userId)).filter(g => (g.status === 'analysed' || g.status === 'explained') && g.purpose === 'own');
    games = (await Promise.all(index.map(g => getGame(g.id)))).filter(g => g && g.playerColor && g.analysis);
  }

  const byCategory = Object.fromEntries([...CATEGORIES, 'unexplained'].map(c => [c, { count: 0, weight: 0, moments: [] }]));
  const byPhase = Object.fromEntries(['opening', 'middlegame', 'endgame'].map(p => [p, { moves: 0, cpl: 0, acc: 0, moments: 0, weight: 0 }]));
  const byColor = Object.fromEntries(['white', 'black'].map(c => [c, { games: 0, acc: 0, moments: 0, score: 0, scored: 0 }]));
  const endgames = new Map(); // material signature -> recurring endgame trouble spots
  const refByKey = new Map(); // "gameId:ply" -> moment ref, for feedback lookups
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
    if (score != null) { byColor[color].score += score; byColor[color].scored++; }
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
    const spents = spentPerMove(g.analysis.moves, g.headers.TimeControl);
    const momentSet = new Set(g.analysis.summary.moments);
    g.analysis.moves.forEach((m, i) => {
      const spent = spents[i];
      if (!m.isPlayer || m.clock == null) return;
      time.moves++;
      if (momentSet.has(m.ply)) {
        if (spent != null) { time.momentSpentTotal += spent; time.momentSpentN++; if (spent <= 10) time.fastMoments++; }
        if (m.clock > 300 && m.loss >= 20) time.comfortBlunders++;
        if (m.clock < 120) time.underTwoMin++;
      } else if (spent != null) { time.otherSpentTotal += spent; time.otherSpentN++; }
    });

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
      refByKey.set(`${g.id}:${ply}`, ref);
      const cat = e && byCategory[e.category] ? e.category : 'unexplained';
      byCategory[cat].count++;
      byCategory[cat].weight += w;
      byCategory[cat].moments.push(ref);
      if (m.phase === 'endgame') {
        const sig = materialSignature(m.fenBefore, m.color);
        const eg = endgames.get(sig) || { signature: sig, count: 0, weight: 0, games: new Set(), moments: [] };
        eg.count++; eg.weight += w; eg.games.add(g.id);
        if (eg.moments.length < 6) eg.moments.push(ref);
        endgames.set(sig, eg);
      }
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
    // Score over games with a known result only; '*' games are not losses.
    c.scorePct = c.scored ? +((c.score / c.scored) * 100).toFixed(0) : null;
    delete c.acc; delete c.score; delete c.scored;
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

  // Drill performance from review history: this machine's live store plus the
  // read-only mirrors other machines sync through the data repo (the same
  // player reviews on both, so the histories merge).
  const dstore = purpose === 'own' ? await getDrills() : { drills: [] };
  const foreign = purpose === 'own' ? await getForeignDrillStores() : [];
  const drillByPhase = {}, drillByCategory = {}, drillByKind = {}, patternSpeed = new Map();
  const activityDates = new Set(); // YYYY-MM-DD the player practised, for the home-screen streak
  let drillAttempts = 0, drillCorrect = 0;
  const tally = drills => {
    for (const d of drills) {
      for (const r of d.reviews || []) {
        drillAttempts++; if (r.correct) drillCorrect++;
        if (r.at) activityDates.add(String(r.at).slice(0, 10));
        const bump = (obj, k) => { if (!k) return; const o = obj[k] = obj[k] || { attempts: 0, correct: 0 }; o.attempts++; if (r.correct) o.correct++; };
        bump(drillByPhase, d.phase);
        bump(drillByCategory, d.category);
        bump(drillByKind, d.kind || 'find-best'); // threat / punish / opening / core: separate streams
        if (d.pattern && Number.isFinite(r.ms)) {
          const k = normalizeKey(d.pattern);
          const p = patternSpeed.get(k) || { pattern: d.pattern, times: [] };
          p.times.push(r.ms);
          patternSpeed.set(k, p);
        }
      }
    }
  };
  tally(dstore.drills);
  for (const f of foreign) tally(f.drills);
  // Guess-first attempts from the game view are recognition evidence too (a
  // correct first try even advances the ladder), but they live outside
  // reviews[]; fold them in so the rate and per-category strength include them.
  const drillById = new Map(dstore.drills.map(d => [d.id, d]));
  for (const [key, guesses] of Object.entries(dstore.guesses || {})) {
    const d = drillById.get(key);
    for (const gs of guesses) {
      drillAttempts++; if (gs.correct) drillCorrect++;
      if (gs.at) activityDates.add(String(gs.at).slice(0, 10));
      const bump = (obj, k) => { if (!k) return; const o = obj[k] = obj[k] || { attempts: 0, correct: 0 }; o.attempts++; if (gs.correct) o.correct++; };
      bump(drillByPhase, d?.phase); bump(drillByCategory, d?.category); bump(drillByKind, d?.kind || 'find-best');
    }
  }
  const median = xs => { const s = [...xs].sort((a, b) => a - b); const mid = s.length >> 1; return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2); };
  const speed = [...patternSpeed.values()]
    .filter(p => p.times.length >= 3)
    .map(p => ({ pattern: p.pattern, attempts: p.times.length, medianMs: median(p.times) }))
    .sort((a, b) => b.attempts - a.attempts)
    .slice(0, 10);
  const drillStats = drillAttempts ? {
    attempts: drillAttempts,
    correct: drillCorrect,
    rate: Math.round((drillCorrect / drillAttempts) * 100),
    machines: 1 + foreign.length,
    byPhase: drillByPhase,
    byCategory: drillByCategory,
    byKind: drillByKind,
    speed: speed.length ? speed : null,
  } : null;

  // Quiet-position detection: how often the player correctly recognised that
  // nothing was wrong. The discrimination half of the skill; false positives
  // (calling a fine move a mistake) are the signal to watch.
  const dc = dstore.decoys;
  const decoys = dc && dc.seen ? { seen: dc.seen, right: dc.right, falsePositiveRate: Math.round(((dc.seen - dc.right) / dc.seen) * 100) } : null;

  // Explanation feedback (per machine): counts, plus the moments flagged as
  // unhelpful so their prompts can be tuned or the moment re-explained.
  let feedback = null;
  const fbEntries = Object.entries(dstore.feedback || {});
  if (fbEntries.length) {
    feedback = { helpful: 0, unhelpful: 0, unhelpfulMoments: [] };
    for (const [key, f] of fbEntries) {
      if (f.helpful) feedback.helpful++;
      else {
        feedback.unhelpful++;
        const ref = refByKey.get(key);
        if (ref) feedback.unhelpfulMoments.push(ref);
      }
    }
  }

  const timeManagement = time.moves ? {
    movesWithClock: time.moves,
    momentAvgSpent: time.momentSpentN ? Math.round(time.momentSpentTotal / time.momentSpentN) : null,
    otherAvgSpent: time.otherSpentN ? Math.round(time.otherSpentTotal / time.otherSpentN) : null,
    comfortBlunders: time.comfortBlunders,
    underTwoMinMoments: time.underTwoMin,
    fastMoments: time.fastMoments,
  } : null;

  // Focus areas by weighted count, annotated with the per-category trend delta
  // (positive = worsening) so the study prescription can prioritise weaknesses
  // that are getting worse and ease off ones that are already improving.
  const trendByCat = new Map((categoryTrend || []).map(t => [t.category, t.delta]));
  const focus = Object.entries(byCategory)
    .filter(([k, v]) => k !== 'unexplained' && v.count > 0)
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, 3)
    .map(([k, v]) => ({ category: k, count: v.count, weight: v.weight, trend: trendByCat.has(k) ? trendByCat.get(k) : null }));

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
    decoys,
    activity: [...activityDates].sort(),
    feedback,
    timeManagement,
    // Rank by how many distinct games a signature recurs in, not raw moment
    // count: three blunders in one endgame is one trouble spot, not three.
    endgames: [...endgames.values()]
      .map(eg => ({ signature: eg.signature, count: eg.count, games: eg.games.size, weight: eg.weight, moments: eg.moments }))
      .sort((a, b) => b.games - a.games || b.weight - a.weight)
      .slice(0, 10),
  };
}

const CATEGORY_TITLES = {
  'tactics-allowed': 'Overlooked opponent tactics',
  'tactics-missed': 'Missed own tactics',
  calculation: 'Miscalculation',
  positional: 'Positional play',
  opening: 'Opening knowledge',
  'endgame-technique': 'Endgame technique',
  conversion: 'Converting wins',
  defence: 'Defence',
};

/** One-page pre-tournament card in markdown: the distilled habits, not the full
 * report. What a player can actually hold in mind at the board. */
export function buildPrepCard(report, notes, settings) {
  const out = [];
  const name = (settings.playerNames || [])[0] || 'the player';
  out.push(`# Pre-tournament card: ${name}`);
  out.push('');
  out.push(`From ${report.games} analysed game${report.games === 1 ? '' : 's'}, average accuracy ${report.overallAccuracy ?? '?'}%. Generated ${new Date().toISOString().slice(0, 10)}.`);
  if (report.focus.length) {
    out.push('', '## Focus areas');
    report.focus.forEach((f, i) => out.push(`${i + 1}. ${CATEGORY_TITLES[f.category] || f.category}: ${f.count} moment${f.count === 1 ? '' : 's'} (weight ${f.weight})`));
  }
  const topNotes = Object.values(notes).sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 4);
  if (topNotes.length) {
    out.push('', '## Rules to hold onto');
    for (const n of topNotes) {
      out.push(`- **${n.pattern}** (${n.count}x): ${n.rule} Watch for: ${n.triggers} Habit: ${n.advice}`);
    }
  }
  const t = report.timeManagement;
  if (t) {
    out.push('', '## Clock');
    out.push(`- Mistakes with over 5 minutes left: ${t.comfortBlunders}. Moments under 2 minutes: ${t.underTwoMinMoments}. Failed snap-moves: ${t.fastMoments}.`);
    if (t.momentAvgSpent != null && t.otherAvgSpent != null) out.push(`- Average think on error moves: ${t.momentAvgSpent}s, on the rest: ${t.otherAvgSpent}s.`);
  }
  if (report.concepts.length) {
    out.push('', '## Study list');
    out.push(report.concepts.slice(0, 5).map(c => c.concept).join(', ') + '.');
  }
  out.push('');
  return out.join('\n');
}

/** Compact material signature from the mover's perspective, e.g. "R+3P vs R+2P". */
export function materialSignature(fen, moverColor) {
  const board = fen.split(' ')[0];
  const side = chars => {
    const counts = {};
    for (const c of chars) counts[c.toUpperCase()] = (counts[c.toUpperCase()] || 0) + 1;
    const pieces = ['Q', 'R', 'B', 'N'].flatMap(p => Array(counts[p] || 0).fill(p)).join('');
    return (pieces || 'K') + (counts.P ? `+${counts.P}P` : '');
  };
  const white = side(board.replace(/[^QRBNP]/g, ''));
  const black = side(board.replace(/[^qrbnp]/g, ''));
  return moverColor === 'white' ? `${white} vs ${black}` : `${black} vs ${white}`;
}

export function resultScore(result, color) {
  if (result === '1-0') return color === 'white' ? 1 : 0;
  if (result === '0-1') return color === 'black' ? 1 : 0;
  if (result === '1/2-1/2') return 0.5;
  return null;
}

function normalizeKey(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
