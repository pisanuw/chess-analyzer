// Games featuring a scouted subject: scout imports as-is, plus the player's own
// games against them, flipped so the opponent is the studied side. The flip is
// derived from stored per-move analysis (both colours are already evaluated), so
// no engine work is needed. Own games contribute engine data only: explanations
// exist for the player's moments, not the opponent's, so categories stay
// "unexplained" unless the subject's other games are imported as scout games.
import { getGameCached, listGames, listAllGames, listScoutBooks, getPlayers, getSettings } from './store.js';
import { memberByName } from './users.js';
import { summarize } from './analyze.js';
import { lookupFideId } from './players.js';
import { resultScore, pgnDateKey } from '../public/shared.js';
import { getScoutBook, getClashStore } from './store.js';
import { loadStudentGames, buildStudentIndex, assembleClashForest, walkPrediction } from './clash.js';

/** The prediction check for one own game against a booked opponent: how far
 * the game followed the opening clash the student would have seen before it,
 * as a short sentence plus the raw fields. Null when the opponent has no fresh
 * clash index (no book, or the index is stale). The forest is assembled from
 * the student's games as they are now, which includes this game once analysed:
 * a line that appears only in this one game is not "predicted", so the walk
 * ignores single-game student edges. */
export async function predictionFor(game, userId, fideId) {
  if (!fideId || !game?.playerColor || !game.moves?.length) return null;
  const book = await getScoutBook(fideId);
  const entry = book && (await getClashStore())[fideId];
  if (!entry || entry.bookImportedAt !== book.importedAt) return null;
  const others = (await loadStudentGames(userId)).filter(g => g.id !== game.id);
  const student = buildStudentIndex(others);
  const forest = assembleClashForest({ oppIndex: entry.index, coverage: entry.coverage, student, book });
  const w = walkPrediction(forest, game.moves, game.playerColor);
  if (!w) return null;
  const moveNo = w.leftAtPly ? Math.ceil(w.leftAtPly / 2) : null;
  const text = w.leftAtPly
    ? `Prediction held for ${w.matched} pl${w.matched === 1 ? 'y' : 'ies'}; at move ${moveNo} ${w.by === 'student' ? 'you' : 'they'} played ${w.san}: ${w.reason}.`
    : `Prediction held: ${w.reason}.`;
  return { ...w, moveNo, text };
}

const norm = s => (s || '').trim().toLowerCase();

/** The FIDE id a subject name resolves to: its book, its member entry, or the
 * learned players map (only when unambiguous). Null when nothing links it. */
export async function subjectFideId(subject) {
  const book = (await listScoutBooks()).find(b => norm(b.name) === norm(subject));
  if (book) return book.fideId;
  const member = await memberByName(subject);
  if (member?.fideId) return member.fideId;
  return lookupFideId(await getPlayers(), subject);
}

/** Deviations from the predicted tree that recurred across more than one game
 * against this opponent, grouped by who left it and the move (a proxy for
 * "the same position, the same surprise" without a full FEN comparison).
 * Without this, a rematch's prep sheet has no memory of a deviation the
 * opponent has already sprung more than once: it reads as new information
 * each time instead of a pattern to specifically watch for. */
function repeatedDeviations(games) {
  const byKey = new Map();
  for (const g of games) {
    const p = g.prediction;
    if (!p || p.held || !p.san || !p.by) continue;
    const key = `${p.by}:${p.san}:${p.leftAtPly}`;
    (byKey.get(key) || byKey.set(key, []).get(key)).push(g);
  }
  return [...byKey.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([key, list]) => {
      const [by, san, leftAtPly] = key.split(':');
      return { by, san, leftAtPly: Number(leftAtPly), moveNo: Math.ceil(Number(leftAtPly) / 2), count: list.length, dates: list.map(g => g.date).filter(Boolean) };
    })
    .sort((a, b) => b.count - a.count);
}

/** The viewer's own games against a subject, newest first, with the opening
 * line and how each went: the record a player wants at the top of a dossier.
 * Matches on the opponent's name, or on FIDE id when either side carries one. */
export async function headToHead(userId, subject, fideId = null) {
  const players = await getPlayers();
  const games = [];
  for (const e of await listGames(userId)) {
    if (e.purpose === 'scout' || !e.playerColor) continue;
    const oppName = e.playerColor === 'white' ? e.black : e.white;
    const oppId = e.playerColor === 'white' ? e.blackFideId : e.whiteFideId;
    const match = norm(oppName) === norm(subject) || (fideId && (oppId === fideId || lookupFideId(players, oppName) === fideId));
    if (!match) continue;
    const g = await getGameCached(e);
    games.push({
      gameId: e.id, date: e.date, event: e.event, color: e.playerColor, result: e.result,
      score: resultScore(e.result, e.playerColor), eco: e.eco,
      line: (g?.moves || []).slice(0, 8).map(m => m.san),
      accuracy: e.accuracy, moments: e.moments,
      analysed: e.status === 'analysed' || e.status === 'explained',
      prediction: await predictionFor(g, userId, fideId),
    });
  }
  games.sort((a, b) => pgnDateKey(b.date) - pgnDateKey(a.date));
  const scored = games.filter(g => g.score != null);
  const record = {
    games: games.length,
    wins: scored.filter(g => g.score === 1).length,
    draws: scored.filter(g => g.score === 0.5).length,
    losses: scored.filter(g => g.score === 0).length,
    scorePct: scored.length ? Math.round((scored.reduce((s, g) => s + g.score, 0) / scored.length) * 100) : null,
  };
  // How good the opening prediction has been against this opponent: how many
  // games stayed on a predicted line to move 6 or beyond, and the median depth.
  const checked = games.filter(g => g.prediction);
  const depths = checked.map(g => g.prediction.matched).sort((a, b) => a - b);
  const prediction = checked.length ? {
    games: checked.length,
    heldToMove6: checked.filter(g => g.prediction.matched >= 10).length,
    medianPlies: depths[depths.length >> 1],
    leftByThem: checked.filter(g => g.prediction.by === 'opponent' && !g.prediction.held).length,
    leftByYou: checked.filter(g => g.prediction.by === 'student' && !g.prediction.held).length,
  } : null;
  return { games, record, prediction, recurringDeviations: repeatedDeviations(games) };
}

export async function gamesForSubject(subject) {
  const settings = await getSettings();
  const out = [];
  let scoutMatched = false;
  for (const e of await listAllGames()) {
    if (e.status !== 'analysed' && e.status !== 'explained') continue;
    if (e.purpose === 'scout') {
      if (e.subject !== subject) continue;
      scoutMatched = true;
      const g = await getGameCached(e);
      if (g?.analysis && g.playerColor) out.push(g);
      continue;
    }
    if (!e.playerColor) continue;
    const oppName = e.playerColor === 'white' ? e.black : e.white;
    if (oppName !== subject) continue;
    const g = await getGameCached(e);
    if (g?.analysis) out.push(flipToOpponent(g, settings));
  }
  // A member with no scout book is scouted from their OWN games, viewed from
  // their own side (they ARE the subject, so no flip): this is how a member like
  // Kai gets the opponent-facing prep sheet the requirement asks for. Members who
  // have a book keep the book (the scout games matched above). No drills or
  // private training data ever enters this: the scout report path uses none.
  if (!scoutMatched) {
    const member = await memberByName(subject);
    if (member) {
      const seen = new Set(out.map(g => g.id));
      for (const e of await listGames(member.id)) {
        if (e.purpose !== 'own' || !e.playerColor || seen.has(e.id)) continue;
        if (e.status !== 'analysed' && e.status !== 'explained') continue;
        const g = await getGameCached(e);
        if (g?.analysis && g.playerColor) out.push(g);
      }
    }
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
