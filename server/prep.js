// "Prepare for a game": one payload for one opponent, in the colour the student
// will have. Composes what already exists (the prep sheet, the colour-cut
// dossier, the book and its habits, the opening clash for that colour, the
// head-to-head record) and derives a prep deck from it: flashcards for the
// student's own moves along the predicted lines, the opponent's punish drills in
// that colour, and the predicted positions to spar from. Everything here is
// data- or engine-grounded; no model call.
import crypto from 'node:crypto';
import { getScoutBook, getClashStore, getClashNotes, getPrepSheets, getDrills } from './store.js';
import { buildReport } from './report.js';
import { buildRepertoire } from './repertoire.js';
import { subjectFideId, headToHead } from './subjects.js';
import { scoutDossier } from './scoutbook.js';
import { loadStudentGames, buildStudentIndex, assembleClashForest, clashPrincipalLines, endReasonOf, clashNoteKey } from './clash.js';
import { dueDrills, visitorDrills } from './drills.js';
import { readSheet } from './prepsheet.js';
import { dossierOpts } from './http.js';
import { acceptedLines } from './ease.js';
import { fmtLine } from '../public/shared.js';

const MAX_LINES = 6;       // principal lines the flashcards follow, per colour
const MAX_LINE_DRILLS = 12;
const MAX_SPARRING = 6;
const MAX_EARLY_SPARRING = 3;
const EARLY_PLY = 6; // "immediately" for sparring purposes: within their first few replies

const nodeHash = key => crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);

/** The student nodes along the principal lines for one colour, each with the
 * path that reaches it: the positions a prep card can ask about. A prep-end
 * leaf the engine extended counts too (`fromEngine`). */
function lineNodes(clash, myColor) {
  const root = clash?.forests?.[myColor];
  if (!root) return [];
  const lines = clashPrincipalLines(clash, 24).filter(l => l.color === myColor).slice(0, MAX_LINES);
  const seen = new Set();
  const out = [];
  const visit = (node, path, fromEngine = false) => {
    if (seen.has(node.key)) return;
    seen.add(node.key);
    out.push({ node, path: [...path], fromEngine });
  };
  for (const line of lines) {
    let node = root;
    const path = [];
    for (const san of line.sans) {
      if (!node) break;
      if (node.mover === 'student' && node.edges.length) visit(node, path);
      const edge = node.edges.find(e => e.san === san);
      if (!edge) break;
      path.push(san);
      node = edge.child;
    }
    if (node && node.mover === 'student' && !node.edges.length && node.engineLines?.length) visit(node, path, true);
  }
  return out;
}

/** Engine-approved candidates from White-POV lines, best first, for the mover. */
function approvedCandidates(lines, myColor) {
  const sign = myColor === 'white' ? 1 : -1;
  const accepted = new Set(acceptedLines(lines, sign));
  return lines.filter(l => accepted.has(l.uci)).map(l => ({ uci: l.uci, san: Array.isArray(l.san) ? l.san[0] : l.san, cp: l.cp }));
}

/** Flashcards for the student's own moves along the predicted lines: at every
 * student node on a principal line, "you are here against them, what do you
 * play?", answered by the continuation the student's own games show, or, at a
 * prep-end leaf the engine extended, any engine-approved move.
 *
 * A student move flagged as a deviation (it left the engine's lines or lost
 * ground in the student's own games) is never the answer key: the card would
 * rehearse the mistake. Such a node becomes a "repair" card answered by the
 * engine lines the student's own analysis stored at that position (`ownLines`);
 * with no stored lines the node is skipped and listed by buildLineRepairs. */
export function buildLineDrills(clash, myColor, subject, fideId, max = MAX_LINE_DRILLS) {
  const drills = [];
  for (const { node, path, fromEngine } of lineNodes(clash, myColor)) {
    let candidates, source = 'your games', repair = null;
    if (fromEngine) {
      candidates = approvedCandidates(node.engineLines, myColor);
      source = 'engine';
    } else {
      const sound = node.edges.filter(e => !e.deviation);
      if (sound.length) candidates = sound.map(e => ({ uci: e.uci, san: e.san, cp: e.cp }));
      else if (node.ownLines?.length) {
        candidates = approvedCandidates(node.ownLines, myColor);
        source = 'engine';
        repair = { san: node.edges[0].san, uci: node.edges[0].uci, cp: node.edges[0].cp ?? null };
      } else continue;
    }
    if (!candidates.length) continue;
    drills.push({
      id: `line:${fideId || 'x'}:${nodeHash(node.key)}`,
      kind: 'line',
      subject, fideId,
      fen: node.fenBefore,
      sideToMove: myColor,
      orientation: myColor,
      ply: node.ply,
      path,
      bestUci: candidates[0].uci,
      bestSan: candidates[0].san,
      acceptedUci: candidates.map(c => c.uci),
      lines: candidates.map((c, i) => ({ multipv: i + 1, cp: c.cp ?? null, uci: c.uci, san: [c.san] })),
      source,
      ...(repair ? { repair } : {}),
      phase: 'opening',
      label: `Prep vs ${subject}: ${path.length ? fmtLine(path) : 'move 1'}`,
    });
  }
  return drills.sort((a, b) => a.ply - b.ply).slice(0, max);
}

/** Student nodes on the predicted lines where every own continuation is a
 * flagged deviation and no engine lines are stored, so no card can be made:
 * the lines the student should repair (re-analyse, or study on the board). */
export function buildLineRepairs(clash, myColor) {
  const out = [];
  for (const { node, path, fromEngine } of lineNodes(clash, myColor)) {
    if (fromEngine || node.ownLines?.length || node.edges.some(e => !e.deviation)) continue;
    out.push({ fen: node.fenBefore, path, sanLine: fmtLine(path), ply: node.ply, played: node.edges.map(e => e.san) });
  }
  return out;
}

/** The predicted positions where a prediction runs out, deepest first: the
 * middlegames the student is likeliest to reach, to play out against the engine
 * at the opponent's strength. */
export function sparringPositions(clash, myColor, max = MAX_SPARRING) {
  const root = clash?.forests?.[myColor];
  if (!root) return [];
  const out = [];
  const walk = (node, path) => {
    if (!node || node.transposesTo) return;
    if (!node.edges.length) {
      if (path.length >= 4) out.push({ fen: node.fenBefore, path, sanLine: fmtLine(path), side: node.side, ply: node.ply, reason: endReasonOf(node) });
      return;
    }
    for (const e of node.edges) walk(e.child, [...path, e.san]);
  };
  walk(root, []);
  return out.sort((a, b) => b.ply - a.ply).slice(0, max);
}

/** Shallow "if they deviate immediately" positions: an early branch point
 * where the opponent has more than one real reply, so their second (or
 * later) most common try gets rehearsed too, not only their main line (which
 * the line flashcards already cover) and not only the deep, tree-exhausted
 * middlegames sparringPositions finds. The likeliest early surprise against a
 * player the student has not faced before is not a resource shortage ten
 * moves in; it is move two or three going somewhere unexpected. */
export function earlyDeviationPositions(clash, myColor, max = MAX_EARLY_SPARRING) {
  const root = clash?.forests?.[myColor];
  if (!root) return [];
  const out = [];
  const walk = (node, path) => {
    if (!node || node.transposesTo || node.ply >= EARLY_PLY) return;
    if (node.mover === 'opponent' && node.edges.length >= 2) {
      // The first (most-weighted) edge is already the line the flashcards and
      // deep sparring follow; the rest is the real, data-backed surprise.
      for (const e of node.edges.slice(1)) {
        const nextPath = [...path, e.san];
        out.push({
          fen: e.fenAfter, path: nextPath, sanLine: fmtLine(nextPath), side: myColor, ply: node.ply + 1,
          reason: `a real but less common try here${e.share != null ? ` (${e.share}% of their games)` : ''}, not their main line`,
        });
      }
    }
    for (const e of node.edges) walk(e.child, [...path, e.san]);
  };
  walk(root, []);
  return out.sort((a, b) => a.ply - b.ply).slice(0, max);
}

const dedupByFen = positions => { const seen = new Set(); return positions.filter(p => (seen.has(p.fen) ? false : (seen.add(p.fen), true))); };

/** Everything the Prepare page needs for one opponent in one colour. */
export async function buildPrep({ uid, subject, myColor, tc = 'all', settings, visitor = false }) {
  const oppColor = myColor === 'white' ? 'black' : 'white';
  const fideId = await subjectFideId(subject);
  const [report, repertoire] = await Promise.all([
    buildReport({ purpose: 'scout', subject, color: oppColor }),
    buildRepertoire({ purpose: 'scout', subject, color: oppColor }),
  ]);
  const sheet = readSheet(await getPrepSheets(), uid, subject);
  const h2h = visitor ? { games: [], record: { games: 0, wins: 0, draws: 0, losses: 0, scorePct: null } } : await headToHead(uid, subject, fideId);
  let book = null, features = null, clash = null;
  const raw = fideId ? await getScoutBook(fideId) : null;
  if (raw) {
    const d = scoutDossier(raw, dossierOpts(settings, tc));
    book = { currentElo: d.currentElo, peakElo: d.peakElo, results: d.results, eloTrend: d.eloTrend, coverage: d.coverage, repertoire: d.repertoire.filter(l => l.color === oppColor) };
    const entry = (await getClashStore())[fideId];
    if (entry && entry.bookImportedAt === raw.importedAt) {
      features = entry.features || null;
      const student = buildStudentIndex(await loadStudentGames(uid));
      clash = assembleClashForest({ oppIndex: entry.index, coverage: entry.coverage, student, book: raw });
      clash.forests = { white: myColor === 'white' ? clash.forests.white : null, black: myColor === 'black' ? clash.forests.black : null };
      clash.narration = (await getClashNotes())[clashNoteKey(fideId, uid)] || null;
    }
  }
  const lines = clash ? buildLineDrills(clash, myColor, subject, fideId) : [];
  const repairs = clash ? buildLineRepairs(clash, myColor) : [];
  const punish = visitor
    ? (await visitorDrills(30, undefined, { subject, color: oppColor })).due
    : (await dueDrills(30, { subject, color: oppColor, userId: uid })).due;
  const sparring = clash ? dedupByFen([...earlyDeviationPositions(clash, myColor), ...sparringPositions(clash, myColor)]) : [];
  const marks = visitor ? {} : (await getDrills(uid)).prep || {};
  const deckIds = [...lines, ...punish].map(d => d.id);
  const done = deckIds.filter(id => (marks[id]?.right || 0) > 0).length;
  return {
    subject, fideId, myColor, oppColor, tc,
    sheet, report, repertoire, headToHead: h2h, book, features, clash,
    deck: { lines, punish, sparring, repairs },
    progress: { total: deckIds.length, done, marks: Object.fromEntries(deckIds.filter(id => marks[id]).map(id => [id, marks[id]])) },
  };
}
