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
import { winProb, WP_ACCEPT, fmtLine } from '../public/shared.js';

const MAX_LINES = 6;       // principal lines the flashcards follow, per colour
const MAX_LINE_DRILLS = 12;
const MAX_SPARRING = 6;

const nodeHash = key => crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);

/** Flashcards for the student's own moves along the predicted lines: at every
 * student node on a principal line, "you are here against them, what do you
 * play?", answered by the continuation the student's own games show (or, at a
 * prep-end leaf the engine extended, any engine-approved move). */
export function buildLineDrills(clash, myColor, subject, fideId, max = MAX_LINE_DRILLS) {
  const root = clash?.forests?.[myColor];
  if (!root) return [];
  const lines = clashPrincipalLines(clash, 24).filter(l => l.color === myColor).slice(0, MAX_LINES);
  const drills = new Map();
  const add = (node, path, fromEngine = false) => {
    if (drills.has(node.key)) return;
    let candidates;
    if (fromEngine) {
      const best = node.engineLines[0];
      const bestWp = winProb(best.cp * (myColor === 'white' ? 1 : -1));
      candidates = node.engineLines.filter(l => bestWp - winProb(l.cp * (myColor === 'white' ? 1 : -1)) <= WP_ACCEPT).map(l => ({ uci: l.uci, san: l.san, cp: l.cp }));
    } else {
      candidates = node.edges.map(e => ({ uci: e.uci, san: e.san, cp: e.cp }));
    }
    if (!candidates.length) return;
    drills.set(node.key, {
      id: `line:${fideId || 'x'}:${nodeHash(node.key)}`,
      kind: 'line',
      subject, fideId,
      fen: node.fenBefore,
      sideToMove: myColor,
      orientation: myColor,
      ply: node.ply,
      path: [...path],
      bestUci: candidates[0].uci,
      bestSan: candidates[0].san,
      acceptedUci: candidates.map(c => c.uci),
      lines: candidates.map((c, i) => ({ multipv: i + 1, cp: c.cp ?? null, uci: c.uci, san: [c.san] })),
      source: fromEngine ? 'engine' : 'your games',
      phase: 'opening',
      label: `Prep vs ${subject}: ${path.length ? fmtLine(path) : 'move 1'}`,
    });
  };
  for (const line of lines) {
    let node = root;
    const path = [];
    for (const san of line.sans) {
      if (!node) break;
      if (node.mover === 'student' && node.edges.length) add(node, path);
      const edge = node.edges.find(e => e.san === san);
      if (!edge) break;
      path.push(san);
      node = edge.child;
    }
    if (node && node.mover === 'student' && !node.edges.length && node.engineLines?.length) add(node, path, true);
  }
  return [...drills.values()].sort((a, b) => a.ply - b.ply).slice(0, max);
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
  const punish = visitor
    ? (await visitorDrills(30, undefined, { subject, color: oppColor })).due
    : (await dueDrills(30, { subject, color: oppColor, userId: uid })).due;
  const sparring = clash ? sparringPositions(clash, myColor) : [];
  const marks = visitor ? {} : (await getDrills(uid)).prep || {};
  const deckIds = [...lines, ...punish].map(d => d.id);
  const done = deckIds.filter(id => (marks[id]?.right || 0) > 0).length;
  return {
    subject, fideId, myColor, oppColor, tc,
    sheet, report, repertoire, headToHead: h2h, book, features, clash,
    deck: { lines, punish, sparring },
    progress: { total: deckIds.length, done, marks: Object.fromEntries(deckIds.filter(id => marks[id]).map(id => [id, marks[id]])) },
  };
}
