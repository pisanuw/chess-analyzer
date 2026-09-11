// Scout "book" tier: a compact, engine-free record of every game of one
// opponent, keyed by FIDE id. Hundreds of an opponent's games must not become
// hundreds of full game files (the main store caps at 500, syncs every file,
// and would bury the player's own games), so this keeps only SAN openings,
// headers, and derived stats in data/scouts/<fideId>.json. From it we derive a
// recency- and rating-weighted repertoire and pick the handful of recent games
// worth the expensive engine/LLM dossier (see promote in index.js).
import { resultScore, posKeyOf, classifyTimeControl } from '../public/shared.js';

const OPENING_PLIES = 8; // position after these plies identifies a line (matches repertoire.js)
const LINE_SAN = 10;     // SAN prefix stored per game, enough to name the variant

const START_FEN_PREFIX = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
const norm = s => (s || '').trim().toLowerCase();
const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const topKey = map => [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

/** The FIDE id a metadb export encodes in its filename, e.g.
 * "HarishNeeraj_FIDE30958130_Total_739_Games.pgn" -> "30958130". */
export function parseFideFromFilename(name) {
  const m = String(name || '').match(/fide[-_ ]?(\d{4,})/i);
  return m ? m[1] : null;
}

/** Which side the subject had in a game, by exact (normalized) name match
 * against the subject's name and any aliases. Exact, not substring: a clean
 * per-player export has one canonical spelling, and substring wrongly catches
 * e.g. "Karthikeyan, Harishkumar" when scouting "Harish, Neeraj". */
export function subjectColorIn(headers, names) {
  const set = (names || []).map(norm).filter(Boolean);
  const w = set.includes(norm(headers.White));
  const b = set.includes(norm(headers.Black));
  if (w && !b) return 'white';
  if (b && !w) return 'black';
  return null;
}

/** Parse a PGN date ("2026.7.29", padded or not) to a UTC Date, or null. */
export function pgnToDate(s) {
  const m = String(s || '').match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/) || String(s || '').match(/^(\d{4})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], (+m[2] || 1) - 1, +m[3] || 1));
}

/** Age of a PGN date in days relative to `now` (a Date), or null if undated. */
export function ageDays(dateStr, now) {
  const d = pgnToDate(dateStr);
  return d ? Math.max(0, (now - d) / 86400000) : null;
}

/** Build the compact book from parsed games (see pgn.parsePgnFile). Keeps one
 * small record per game the subject actually played; a clean per-player export
 * is entirely the subject's games, but we still filter by name so a mixed file
 * cannot smuggle in unrelated games. */
export function buildScoutBook(parsed, { fideId, name, aliases = [] }, now = new Date()) {
  const names = [name, ...aliases];
  const games = [];
  for (const g of parsed) {
    const color = subjectColorIn(g.headers, names);
    if (!color) continue;
    const startFen = g.moves[0]?.fenBefore || '';
    const fromStart = !g.headers.FEN && startFen.startsWith(START_FEN_PREFIX);
    const opening = g.moves.slice(0, OPENING_PLIES);
    const subjectElo = Number(color === 'white' ? g.headers.WhiteElo : g.headers.BlackElo) || null;
    const oppElo = Number(color === 'white' ? g.headers.BlackElo : g.headers.WhiteElo) || null;
    games.push({
      id: g.id,
      date: g.headers.Date || '',
      event: g.headers.Event || '',
      white: g.headers.White || '?',
      black: g.headers.Black || '?',
      result: g.headers.Result || '*',
      color, // the subject's colour
      subjectElo,
      oppElo,
      eco: g.headers.ECO || '',
      // Time control (header, else the event name) so a rapid-heavy export does
      // not silently skew a classical profile; the dossier can filter on it.
      timeControl: g.headers.TimeControl || '',
      tc: classifyTimeControl(g.headers.TimeControl, g.headers.Event),
      line: g.moves.slice(0, LINE_SAN).map(m => m.san),
      // Full PGN so the selected subset can be promoted into the engine/LLM
      // dossier later without keeping the original export file around.
      pgn: g.pgn,
      // Position after the opening plies (placement, turn, castling) so
      // transpositions merge; null for games that did not start from the
      // initial position (odds, setups), which are not opening prep.
      posKey: fromStart && opening.length ? posKeyOf(opening[opening.length - 1].fenAfter) : null,
      plies: g.moves.length,
    });
  }
  return { fideId: String(fideId || ''), name, aliases, games, total: games.length, importedAt: now.toISOString() };
}

const DEFAULTS = { maxAgeYears: 3, eloBand: 200, halfLifeDays: 540, analyseCount: 30, timeControl: 'all' };

/** A book game's time-control class; books written before the field carry none. */
export const bookTc = g => g.tc || classifyTimeControl(g.timeControl, g.event);

/** Recency weight of a game by its age in days: halves every halfLifeDays, zero
 * past maxDays, a small flat weight for undated games so they still count a
 * little. The one definition the dossier and the opening clash both use, so
 * their shares reconcile. */
export function recencyWeight(age, maxDays, halfLifeDays) {
  if (age != null && age > maxDays) return 0;
  return age == null ? 0.25 : Math.pow(0.5, age / halfLifeDays);
}

/** Derive the preparation dossier from a book: the opponent's current strength,
 * a recency/rating-weighted repertoire by colour, their rating trend, and the
 * recent subset worth a full engine dossier. No engine, no LLM: this is what
 * lets a player prep against an opponent with hundreds of games instantly. */
export function scoutDossier(book, opts = {}) {
  const now = opts.now || new Date();
  const { maxAgeYears, eloBand, halfLifeDays, analyseCount, timeControl } = { ...DEFAULTS, ...opts };
  const maxDays = maxAgeYears * 365.25;

  // How the book splits by time control, before any filter, so the UI can offer
  // the classes that exist; then keep one class when asked ('all' keeps every
  // game, including ones whose control is unknown).
  const byTimeControl = { classical: 0, rapid: 0, blitz: 0, unknown: 0 };
  for (const g of book.games) byTimeControl[bookTc(g)] = (byTimeControl[bookTc(g)] || 0) + 1;
  const inClass = g => timeControl === 'all' || !timeControl || bookTc(g) === timeControl;

  // Sort by the actual parsed date, not the string: PGN dates are often not
  // zero-padded ("2026.7.29"), so a string sort would rank Sept above Oct.
  // Undated games sort last.
  const games = book.games
    .filter(inClass)
    .map(g => ({ ...g, age: ageDays(g.date, now), ts: pgnToDate(g.date)?.getTime() ?? -Infinity }))
    .sort((a, b) => b.ts - a.ts);

  // Current strength: median rating of the most recent rated games still inside
  // the age window (one odd pairing should not move it).
  const recentRated = games.filter(g => g.subjectElo && (g.age == null || g.age <= maxDays)).slice(0, 12).map(g => g.subjectElo);
  const currentElo = recentRated.length ? median(recentRated) : (games.find(g => g.subjectElo)?.subjectElo || null);

  const weightOf = g => recencyWeight(g.age, maxDays, halfLifeDays);
  const withinElo = g => !currentElo || !g.subjectElo || Math.abs(g.subjectElo - currentElo) <= eloBand;

  // Repertoire by colour, weighted, transposition-merged by posKey.
  const lines = new Map();
  const byColor = { white: blank(), black: blank() };
  for (const g of games) {
    const w = weightOf(g);
    const sc = resultScore(g.result, g.color);
    const c = byColor[g.color];
    c.count++; c.wsum += w;
    if (sc != null) { c.scoreW += sc * w; c.scoredW += w; c.score += sc; c.scored++; }
    if (!g.posKey || w <= 0) continue;
    const key = `${g.color}|${g.posKey}`;
    const l = lines.get(key) || { color: g.color, variants: new Map(), ecos: new Map(), count: 0, wsum: 0, scoreW: 0, scoredW: 0, oppEloSum: 0, oppEloN: 0, lastDate: '', lastTs: -Infinity };
    const sanLine = g.line.slice(0, OPENING_PLIES).join(' ');
    l.variants.set(sanLine, (l.variants.get(sanLine) || 0) + w);
    if (g.eco) l.ecos.set(g.eco, (l.ecos.get(g.eco) || 0) + 1);
    l.count++; l.wsum += w;
    if (sc != null) { l.scoreW += sc * w; l.scoredW += w; }
    if (g.oppElo) { l.oppEloSum += g.oppElo; l.oppEloN++; }
    if (g.ts > l.lastTs) { l.lastTs = g.ts; l.lastDate = g.date; }
    lines.set(key, l);
  }
  const repertoire = [...lines.values()]
    .map(l => ({
      color: l.color,
      line: (topKey(l.variants) || '').split(' ').filter(Boolean),
      eco: topKey(l.ecos) || '',
      count: l.count,
      weight: +l.wsum.toFixed(2),
      share: 0, // filled below, per colour
      scorePct: l.scoredW ? Math.round((l.scoreW / l.scoredW) * 100) : null,
      avgOppElo: l.oppEloN ? Math.round(l.oppEloSum / l.oppEloN) : null,
      lastDate: l.lastDate,
    }))
    .sort((a, b) => a.color.localeCompare(b.color) || b.weight - a.weight);
  for (const color of ['white', 'black']) {
    const total = repertoire.filter(r => r.color === color).reduce((s, r) => s + r.weight, 0);
    repertoire.filter(r => r.color === color).forEach(r => { r.share = total ? Math.round((r.weight / total) * 100) : 0; });
  }

  // Rating trend: median subject rating per calendar year, oldest first.
  const byYear = new Map();
  for (const g of games) {
    const d = pgnToDate(g.date);
    if (!d || !g.subjectElo) continue;
    const y = d.getUTCFullYear();
    (byYear.get(y) || byYear.set(y, []).get(y)).push(g.subjectElo);
  }
  const eloTrend = [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([year, elos]) => ({ year, elo: median(elos), games: elos.length }));

  // Analysis set: the recent, on-strength games worth a full dossier.
  const eligible = games.filter(g => (g.age == null || g.age <= maxDays) && withinElo(g));
  const analysisSet = eligible.slice(0, analyseCount).map(g => g.id);
  const droppedOld = games.filter(g => g.age != null && g.age > maxDays).length;
  const droppedElo = games.filter(g => (g.age == null || g.age <= maxDays) && !withinElo(g)).length;

  const dated = games.map(g => g.date).filter(Boolean).sort();
  const allElos = games.map(g => g.subjectElo).filter(Boolean);
  return {
    fideId: book.fideId,
    name: book.name,
    total: games.length,
    currentElo,
    peakElo: allElos.length ? Math.max(...allElos) : null,
    dateRange: dated.length ? { from: dated[0], to: dated[dated.length - 1] } : null,
    results: {
      white: summarizeColor(byColor.white),
      black: summarizeColor(byColor.black),
    },
    repertoire,
    eloTrend,
    analysisSet,
    coverage: { total: games.length, eligible: eligible.length, analysing: analysisSet.length, droppedOld, droppedElo, maxAgeYears, eloBand, currentElo, timeControl: timeControl || 'all', byTimeControl, bookTotal: book.games.length },
  };
}

const blank = () => ({ count: 0, wsum: 0, scoreW: 0, scoredW: 0, score: 0, scored: 0 });
const summarizeColor = c => ({
  games: c.count,
  scorePct: c.scored ? Math.round((c.score / c.scored) * 100) : null,        // raw, all games
  recentScorePct: c.scoredW ? Math.round((c.scoreW / c.scoredW) * 100) : null, // recency-weighted
});
