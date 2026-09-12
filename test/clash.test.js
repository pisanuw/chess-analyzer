import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { tempData } from './helpers.js';

// Set DATA_DIR before importing server modules: extendClashLeaves writes the
// eval cache, and we do not want that landing in the real data dir.
process.env.DATA_DIR = tempData();
const { parseGame } = await import('../server/pgn.js');
const { buildStudentIndex, buildOpponentIndex, assembleClashForest, clashParams, extendClashLeaves, clashPrincipalLines, ensureClashIndex } = await import('../server/clash.js');
const { saveScoutBook } = await import('../server/store.js');

const NOW = new Date('2026-09-09T00:00:00Z');
const SETTINGS = { scoutMaxAgeYears: 3, scoutHalfLifeDays: 540 };

// Build a PGN string from a SAN list so parseGame gives real moves/FENs.
function pgnOf(sans, result = '1-0') {
  let mt = '';
  for (let i = 0; i < sans.length; i++) { if (i % 2 === 0) mt += `${i / 2 + 1}. `; mt += sans[i] + ' '; }
  return `[White "W"]\n[Black "B"]\n[Result "${result}"]\n\n${mt}${result}`;
}

// A synthetic own game: parse the moves, then add the analysis fields buildStudentIndex reads.
// overrides is keyed by ply to inject a deviation (playedRank null, or loss >= 10).
function studentGame(color, sans, { result = '1-0', overrides = {} } = {}) {
  const { moves } = parseGame(pgnOf(sans, result));
  const aug = moves.map(m => ({ ...m, evalAfter: 10, accuracy: 95, loss: 0, playedRank: 1, phase: 'opening', ...(overrides[m.ply] || {}) }));
  return { playerColor: color, headers: { Result: result }, analysis: { moves: aug } };
}

// A book game: color is the subject's colour; posKey just needs to be truthy
// (buildOpponentIndex recomputes real posKeys from the parsed FENs).
function bookGame(color, sans, { date = '2025.06.01', result = '1-0', oppElo = 2000 } = {}) {
  return { color, date, result, oppElo, posKey: 'std', pgn: pgnOf(sans, result) };
}

function bookOf(games) {
  return { fideId: '12345', name: 'Test Opp', importedAt: '2026-01-01T00:00:00Z', games };
}

async function build(studentGames, bookGames, params) {
  const { index, coverage } = await buildOpponentIndex(bookOf(bookGames), SETTINGS, { now: NOW });
  const student = buildStudentIndex(studentGames);
  return assembleClashForest({ oppIndex: index, coverage, student, book: bookOf(bookGames), params });
}

// Walk the forest collecting every node (following edges' children).
function allNodes(node, out = []) {
  if (!node) return out;
  out.push(node);
  for (const e of node.edges || []) allNodes(e.child, out);
  return out;
}
const edgeSans = node => (node?.edges || []).map(e => e.san);

test('white forest roots at the player (his opening menu); black forest roots at the opponent', async () => {
  const studentGames = [
    studentGame('white', ['d4', 'd5']), studentGame('white', ['d4', 'Nf6']),
    studentGame('white', ['c4', 'e5']), studentGame('white', ['c4', 'c5']),
    studentGame('white', ['Nf3', 'd5']), // Nf3 count 1: below minRootGames, must be dropped
    studentGame('black', ['e4', 'c6', 'd4', 'd5']), studentGame('black', ['e4', 'c6', 'Nc3', 'd5']),
  ];
  const bookGames = [
    // opponent as Black meets 1.d4 and 1.c4 (feeds the white forest)
    bookGame('black', ['d4', 'Nf6']), bookGame('black', ['c4', 'e5']),
    // opponent as White opens 1.e4 (feeds the black forest root)
    bookGame('white', ['e4', 'c6']), bookGame('white', ['e4', 'e5']),
  ];
  const clash = await build(studentGames, bookGames);

  const w = clash.forests.white;
  assert.equal(w.mover, 'student');
  assert.equal(w.side, 'white');
  assert.deepEqual(new Set(edgeSans(w)), new Set(['d4', 'c4'])); // his menu, Nf3 (1 game) filtered

  const b = clash.forests.black;
  assert.equal(b.mover, 'opponent'); // the opponent chooses the opening when the player is Black
  assert.equal(b.side, 'white');
  assert.ok(edgeSans(b).includes('e4'));
});

test('opponent replies branch by weight with a min-count floor, and carry share/count/score', async () => {
  const studentGames = [studentGame('white', ['d4', 'Nf6']), studentGame('white', ['d4', 'Nf6'])];
  // Nf6 x3 (kept), d5 x1 (below minCountOpp, dropped)
  const bookGames = [
    bookGame('black', ['d4', 'Nf6'], { result: '0-1' }),
    bookGame('black', ['d4', 'Nf6'], { result: '1/2-1/2' }),
    bookGame('black', ['d4', 'Nf6'], { result: '0-1' }),
    bookGame('black', ['d4', 'd5'], { result: '1-0' }),
  ];
  const clash = await build(studentGames, bookGames);
  const oppNode = clash.forests.white.edges.find(e => e.san === 'd4').child; // opponent to move after 1.d4
  assert.equal(oppNode.mover, 'opponent');
  assert.deepEqual(edgeSans(oppNode), ['Nf6']); // d5 (1 game) dropped
  const nf6 = oppNode.edges[0];
  assert.equal(nf6.count, 3);
  // score is the subject's (Black) result: two wins + one draw over three games = 83%
  assert.equal(nf6.scorePct, 83);
  assert.ok(nf6.share > 0 && nf6.share <= 100);
});

test('prep-ends: opponent never faced this position (nodata) vs the player has no continuation (studentPrepEnds)', async () => {
  // The player plays 1.b3 (his game), but the opponent has never faced 1.b3.
  const studentGames = [studentGame('white', ['b3', 'e5']), studentGame('white', ['b3', 'd5'])];
  const bookGames = [bookGame('black', ['e4', 'c5']), bookGame('black', ['e4', 'e5'])]; // only ever met 1.e4
  const clash = await build(studentGames, bookGames);
  const oppNode = clash.forests.white.edges.find(e => e.san === 'b3').child;
  assert.equal(oppNode.oppPrepEnds, true);
  assert.equal(oppNode.oppPrepEndsReason, 'nodata');
  assert.equal(oppNode.edges.length, 0);

  // Now give the opponent a reply the player has never met, so the player's line ends.
  const student2 = [studentGame('white', ['d4', 'Nf6']), studentGame('white', ['d4', 'Nf6'])]; // only knows d4 Nf6
  const book2 = [bookGame('black', ['d4', 'g6']), bookGame('black', ['d4', 'g6'])]; // opp plays g6, not Nf6
  const clash2 = await build(student2, book2);
  const afterD4 = clash2.forests.white.edges.find(e => e.san === 'd4').child; // opponent node
  const g6 = afterD4.edges.find(e => e.san === 'g6');
  assert.ok(g6, 'opponent reply g6 is present');
  assert.equal(g6.child.mover, 'student');
  assert.equal(g6.child.studentPrepEnds, true); // the player has no game continuing after 1.d4 g6
});

test('colour handling when the player is Black: opponent move 1, then the player replies from his own games', async () => {
  const studentGames = [
    studentGame('black', ['e4', 'c6', 'd4', 'd5']), studentGame('black', ['e4', 'c6', 'Nc3', 'd5']),
  ];
  const bookGames = [
    bookGame('white', ['e4', 'c6', 'd4']), bookGame('white', ['e4', 'c6', 'd4']), // opp as White: 1.e4 then 2.d4
  ];
  const clash = await build(studentGames, bookGames);
  const b = clash.forests.black;
  const e4 = b.edges.find(e => e.san === 'e4');
  assert.ok(e4, 'opponent opens 1.e4');
  const studentReply = e4.child; // player (Black) to move
  assert.equal(studentReply.mover, 'student');
  assert.equal(studentReply.side, 'black');
  assert.ok(edgeSans(studentReply).includes('c6')); // his Caro-Kann reply
});

test('transposition merge: the same position reached by two move orders is not expanded twice', async () => {
  // Two crossing move orders (d4/c4 vs c4/d4) reach the identical position; the
  // second occurrence must reference-link rather than re-expand.
  const studentGames = [
    studentGame('white', ['d4', 'Nf6', 'c4', 'e6']), studentGame('white', ['d4', 'Nf6', 'c4', 'e6']),
    studentGame('white', ['c4', 'Nf6', 'd4', 'e6']), studentGame('white', ['c4', 'Nf6', 'd4', 'e6']),
  ];
  const bookGames = [
    bookGame('black', ['d4', 'Nf6']), bookGame('black', ['d4', 'Nf6']),
    bookGame('black', ['c4', 'Nf6']), bookGame('black', ['c4', 'Nf6']),
  ];
  const clash = await build(studentGames, bookGames);
  const transposed = allNodes(clash.forests.white).filter(n => n.transposesTo);
  assert.ok(transposed.length >= 1, 'at least one node transposes into an earlier one');
});

test('a deviation in the player\'s own games is flagged on the edge', async () => {
  const studentGames = [
    // On his 2nd move (ply 3) he leaves theory: playedRank null.
    studentGame('white', ['d4', 'd5', 'Nc3'], { overrides: { 3: { playedRank: null } } }),
    studentGame('white', ['d4', 'd5', 'Nc3'], { overrides: { 3: { playedRank: null } } }),
  ];
  const bookGames = [bookGame('black', ['d4', 'd5']), bookGame('black', ['d4', 'd5'])];
  const clash = await build(studentGames, bookGames);
  const afterD5 = clash.forests.white.edges.find(e => e.san === 'd4').child.edges.find(e => e.san === 'd5').child; // player to move
  const nc3 = afterD5.edges.find(e => e.san === 'Nc3');
  assert.ok(nc3, 'the player continues with Nc3');
  assert.equal(nc3.deviation, true);
});

test('evals are stored White-POV, matching the source analysis', async () => {
  // Sanity: the cp on a player edge is the evalAfter we fed in (White POV).
  const studentGames = [studentGame('white', ['e4', 'e5'], { overrides: { 1: { evalAfter: 25 } } }), studentGame('white', ['e4', 'c5'], { overrides: { 1: { evalAfter: 25 } } })];
  const bookGames = [bookGame('black', ['e4', 'e5']), bookGame('black', ['e4', 'c5'])];
  const clash = await build(studentGames, bookGames);
  const e4 = clash.forests.white.edges.find(e => e.san === 'e4');
  assert.equal(e4.cp, 25);
});

test('ensureClashIndex builds once, reuses when fresh, and returns null with no book', async () => {
  await saveScoutBook({
    fideId: '55501', name: 'Idx Opp', aliases: [], importedAt: '2026-02-02T00:00:00Z', total: 2,
    games: [bookGame('black', ['d4', 'Nf6']), bookGame('black', ['d4', 'Nf6'])],
  });
  const first = await ensureClashIndex('55501', { now: NOW });
  assert.ok(first?.index?.black && Object.keys(first.index.black).length >= 1);
  assert.equal(first.bookImportedAt, '2026-02-02T00:00:00Z');
  const second = await ensureClashIndex('55501', { now: NOW });
  assert.equal(second.builtAt, first.builtAt, 'a fresh index is reused, not rebuilt');
  assert.equal(await ensureClashIndex('99999', { now: NOW }), null);
});

test('the opponent index harvests structure habits from the whole game', async () => {
  const bookGames = [
    // Subject as White: castles short, opponent castles long (opposite sides), queens traded, wins vs a higher-rated player.
    { color: 'white', date: '2026.06.01', result: '1-0', subjectElo: 2000, oppElo: 2100, posKey: 'A', pgn: pgnOf(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'd6', 'd3', 'Bg4', 'h3', 'Bxf3', 'Qxf3', 'Qf6', 'Qxf6', 'Nxf6', 'Nc3', 'O-O-O'], '1-0') },
    // Subject as White again in the same line, draws vs a level player, never castles.
    { color: 'white', date: '2026.05.01', result: '1/2-1/2', subjectElo: 2000, oppElo: 2010, posKey: 'A', pgn: pgnOf(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'd3', 'd6'], '1/2-1/2') },
    // Subject as Black, a sideline position (out of book), loses to a lower-rated player.
    { color: 'black', date: '2026.04.01', result: '1-0', subjectElo: 2000, oppElo: 1900, posKey: 'B', pgn: pgnOf(['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7', 'e3', 'O-O'], '1-0') },
  ];
  const { features } = await buildOpponentIndex(bookOf(bookGames), SETTINGS, { now: NOW });
  assert.equal(features.games, 3);
  assert.equal(features.castling.white.short, 1);
  assert.equal(features.castling.white.none, 1);
  assert.equal(features.castling.black.short, 1);
  assert.equal(features.oppositeCastlingPct, 33, 'one of three games had opposite-side castling');
  assert.equal(features.queenTrade.pct, 33);
  assert.equal(features.queenTrade.medianMove, 8, 'queens came off on move 8 in that game');
  assert.equal(features.firstCaptureMedianMove, 6);
  assert.equal(features.drawRate.white, 50);
  assert.equal(features.vsHigher.scorePct, 100);
  assert.equal(features.vsLower.scorePct, 0);
  assert.equal(features.vsLevel.games, 1);
  assert.equal(features.inBook.games, 3, 'with three games every 8-ply position is a top line');
  assert.equal(features.form.games, 3);
  assert.equal(features.form.scorePct, 50);
  assert.ok(features.avgMoves >= 4);
});

// A deterministic 20-ply legal game (always the first move chess.js offers)
// so pgn.js's parser has real FENs to walk, with a %clk comment on every move
// counting down 10 minutes a move, White's side.
function clockGameSans() {
  const chess = new Chess();
  const sans = [];
  for (let i = 0; i < 20; i++) {
    const moves = chess.moves();
    if (!moves.length) break;
    chess.move(moves[0]);
    sans.push(moves[0]);
  }
  return sans;
}
const fmtClk = sec => `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
function clockPgnOf(sans, startSec, secPerMove) {
  let mt = '';
  for (let i = 0; i < sans.length; i++) {
    if (i % 2 === 0) mt += `${i / 2 + 1}. `;
    const clk = Math.max(0, startSec - Math.floor(i / 2) * secPerMove);
    mt += `${sans[i]} {[%clk ${fmtClk(clk)}]} `;
  }
  return `[White "W"]\n[Black "B"]\n[Result "1-0"]\n\n${mt}1-0`;
}

test('the opponent index derives a median-clock-by-move pacing curve from their own games', async () => {
  const sans = clockGameSans();
  // 5 games (the minimum sample), subject as White, burning 90s a move: by
  // move 10 they have used 900s from a notional starting clock.
  const bookGames = Array.from({ length: 5 }, () => ({
    color: 'white', date: '2026.06.01', result: '1-0', posKey: 'std', pgn: clockPgnOf(sans, 3600, 90),
  }));
  const { features } = await buildOpponentIndex(bookOf(bookGames), SETTINGS, { now: NOW });
  assert.ok(features.clockByMove.length >= 1, 'at least one checkpoint has enough samples');
  const at10 = features.clockByMove.find(c => c.move === 10);
  assert.ok(at10, 'move 10 (5 own moves in) is reached with clocks');
  assert.equal(at10.medianSeconds, 3600 - 9 * 90, 'median clock after their 10th move (9 full moves elapsed)');
  assert.equal(at10.games, 5);
  // Too few games with clock data: below MIN_CLOCK_SAMPLES, so no checkpoint.
  const { features: thin } = await buildOpponentIndex(bookOf(bookGames.slice(0, 2)), SETTINGS, { now: NOW });
  assert.equal(thin.clockByMove.length, 0, 'a thin sample is not reported as a tendency');
});

test('walkPrediction reports where a real game left the predicted tree and by whom', async () => {
  const { walkPrediction } = await import('../server/clash.js');
  const studentGames = [studentGame('white', ['d4', 'Nf6', 'c4', 'g6']), studentGame('white', ['d4', 'Nf6', 'c4', 'g6'])];
  const bookGames = [bookGame('black', ['d4', 'Nf6', 'c4', 'g6']), bookGame('black', ['d4', 'Nf6', 'c4', 'g6']), bookGame('black', ['d4', 'd5'])];
  const clash = await build(studentGames, bookGames);
  const moves = sans => parseGame(pgnOf(sans)).moves;
  // The opponent answers 1.d4 with 1...d5: the tree predicted Nf6 (2 games) and d5 was pruned (1 game).
  const theirs = walkPrediction(clash, moves(['d4', 'd5', 'c4', 'e6']), 'white');
  assert.equal(theirs.matched, 1);
  assert.equal(theirs.leftAtPly, 2);
  assert.equal(theirs.by, 'opponent');
  assert.equal(theirs.held, false);
  assert.match(theirs.reason, /did not predict \(Nf6 expected\)/);
  // The student deviates from their own line with 2.Nf3.
  const mine = walkPrediction(clash, moves(['d4', 'Nf6', 'Nf3', 'g6']), 'white');
  assert.equal(mine.leftAtPly, 3);
  assert.equal(mine.by, 'student');
  assert.equal(mine.held, false);
  // The game follows the whole predicted line and then runs past its end: the prediction held.
  const followed = walkPrediction(clash, moves(['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7']), 'white');
  assert.equal(followed.matched, 4);
  assert.equal(followed.held, true);
  assert.equal(walkPrediction(clash, moves(['e4']), 'black'), null, 'no forest for a colour with no student games');
});

test('loadStudentGames is scoped to the member whose openings the clash crosses', async () => {
  const { writeGame, makeGame } = await import('./helpers.js');
  const { loadStudentGames } = await import('../server/clash.js');
  writeGame(process.env.DATA_DIR, makeGame({ id: 'c1a5c1a5c1a5', owner: 'kai' }));
  writeGame(process.env.DATA_DIR, makeGame({ id: 'c1a5c1a5c1a6', owner: 'nikash' }));
  writeGame(process.env.DATA_DIR, makeGame({ id: 'c1a5c1a5c1a7', owner: 'nikash' }));
  assert.equal((await loadStudentGames('kai')).length, 1);
  assert.equal((await loadStudentGames('nikash')).length, 2);
});

test('clashParams clamps caller input to sane ranges', () => {
  assert.equal(clashParams({ maxPly: 999 }).maxPly, 24);
  assert.equal(clashParams({ maxPly: 1 }).maxPly, 4);
  assert.equal(clashParams({ oppBranch: 99 }).oppBranch, 5);
  assert.equal(clashParams({ minShareOpp: 20 }).minShareOpp, 0.2);
  assert.equal(clashParams({}).maxPly, 20); // default
});

test('the FENs used for the board are real and legal (chess.js accepts each edge)', async () => {
  const studentGames = [studentGame('white', ['d4', 'd5']), studentGame('white', ['d4', 'Nf6'])];
  const bookGames = [bookGame('black', ['d4', 'Nf6']), bookGame('black', ['d4', 'd5'])];
  const clash = await build(studentGames, bookGames);
  for (const n of allNodes(clash.forests.white)) {
    for (const e of n.edges) {
      assert.doesNotThrow(() => new Chess(e.fenAfter), `edge FEN should be legal: ${e.fenAfter}`);
    }
  }
});

// A stand-in engine: it returns the position's first few legal moves with
// descending centipawns (side-to-move perspective), so extendClashLeaves has
// something deterministic to convert and attach.
function fakePool() {
  const engine = {
    name: 'fake 1',
    async analyse(fen, { multipv }) {
      const moves = new Chess(fen).moves({ verbose: true }).slice(0, multipv);
      const lines = moves.map((m, i) => ({ multipv: i + 1, depth: 10, cp: 30 - i * 10, mate: null, pv: [m.from + m.to + (m.promotion || '')] }));
      return { bestmove: lines[0]?.pv[0] || null, lines };
    },
  };
  return { engines: [engine], names: new Set(['fake 1']), drop() {} };
}

test('clashPrincipalLines flattens the forest into ranked SAN lines for narration', async () => {
  const studentGames = [
    studentGame('white', ['d4', 'Nf6']), studentGame('white', ['d4', 'Nf6']),
    studentGame('white', ['b3', 'e5']), studentGame('white', ['b3', 'd5']),
  ];
  const bookGames = [
    bookGame('black', ['d4', 'g6']), bookGame('black', ['d4', 'g6']),
    bookGame('black', ['e4', 'c5']), bookGame('black', ['e4', 'e5']), // opponent never faced 1.b3
  ];
  const clash = await build(studentGames, bookGames);
  const lines = clashPrincipalLines(clash, 12);
  assert.ok(lines.length >= 2);
  assert.ok(lines.every(l => typeof l.sanLine === 'string' && Number.isInteger(l.idx)));
  assert.ok(lines.some(l => l.sanLine.startsWith('1.d4')));
  assert.ok(lines.some(l => l.endReason.includes('never faced')), 'the 1.b3 line ends because the opponent never faced it');
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i - 1].likelihood >= lines[i].likelihood, 'sorted by likelihood');
});

test('engine extension fills prep-end leaves with White-POV evals (candidate moves from the engine)', async () => {
  const studentGames = [
    studentGame('white', ['d4', 'Nf6']), studentGame('white', ['d4', 'Nf6']), // knows d4 Nf6
    studentGame('white', ['b3', 'e5']), studentGame('white', ['b3', 'd5']),    // and 1.b3
  ];
  const bookGames = [
    bookGame('black', ['d4', 'g6']), bookGame('black', ['d4', 'g6']), // opp meets 1.d4 with g6 (the player has no games here)
    // opponent never faced 1.b3
    bookGame('black', ['e4', 'c5']), bookGame('black', ['e4', 'e5']),
  ];
  const { index, coverage } = await buildOpponentIndex(bookOf(bookGames), SETTINGS, { now: NOW });
  const student = buildStudentIndex(studentGames);
  const clash = assembleClashForest({ oppIndex: index, coverage, student, book: bookOf(bookGames) });

  await extendClashLeaves(clash, index, { engineDepth: 10, engineMultiPv: 3 }, fakePool());
  assert.equal(clash.engineExtended, true);

  const nodes = allNodes(clash.forests.white);
  // Your-move leaf (White to move after 1.d4 g6): best line cp 30, White POV = +30.
  const studentLeaf = nodes.find(n => n.studentPrepEnds && n.engineBest);
  assert.ok(studentLeaf, 'the studentPrepEnds leaf got an engine suggestion');
  assert.equal(studentLeaf.side, 'white');
  assert.equal(studentLeaf.engineBest.cp, 30);
  assert.ok(studentLeaf.engineLines.length >= 1 && studentLeaf.engineLines[0].childFen);

  // Opponent-to-move leaf (Black to move after 1.b3): 30 from Black's view is -30 for White.
  const oppLeaf = nodes.find(n => n.oppPrepEnds && n.oppPrepEndsReason === 'nodata' && n.engineBest);
  assert.ok(oppLeaf, 'the oppPrepEnds leaf got an engine suggestion');
  assert.equal(oppLeaf.side, 'black');
  assert.equal(oppLeaf.engineBest.cp, -30);
});
