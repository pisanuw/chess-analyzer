import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { tempData } from './helpers.js';

// Set DATA_DIR before importing server modules: extendClashLeaves writes the
// eval cache, and we do not want that landing in the real data dir.
process.env.DATA_DIR = tempData();
const { parseGame } = await import('../server/pgn.js');
const { buildKaiIndex, buildOpponentIndex, assembleClashForest, clashParams, extendClashLeaves } = await import('../server/clash.js');

const NOW = new Date('2026-09-09T00:00:00Z');
const SETTINGS = { scoutMaxAgeYears: 3, scoutHalfLifeDays: 540 };

// Build a PGN string from a SAN list so parseGame gives real moves/FENs.
function pgnOf(sans, result = '1-0') {
  let mt = '';
  for (let i = 0; i < sans.length; i++) { if (i % 2 === 0) mt += `${i / 2 + 1}. `; mt += sans[i] + ' '; }
  return `[White "W"]\n[Black "B"]\n[Result "${result}"]\n\n${mt}${result}`;
}

// A synthetic own game: parse the moves, then add the analysis fields buildKaiIndex reads.
// overrides is keyed by ply to inject a deviation (playedRank null, or loss >= 10).
function kaiGame(color, sans, { result = '1-0', overrides = {} } = {}) {
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

async function build(kaiGames, bookGames, params) {
  const { index, coverage } = await buildOpponentIndex(bookOf(bookGames), SETTINGS, { now: NOW });
  const kai = buildKaiIndex(kaiGames);
  return assembleClashForest({ oppIndex: index, coverage, kai, book: bookOf(bookGames), params });
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
  const kaiGames = [
    kaiGame('white', ['d4', 'd5']), kaiGame('white', ['d4', 'Nf6']),
    kaiGame('white', ['c4', 'e5']), kaiGame('white', ['c4', 'c5']),
    kaiGame('white', ['Nf3', 'd5']), // Nf3 count 1: below minRootGames, must be dropped
    kaiGame('black', ['e4', 'c6', 'd4', 'd5']), kaiGame('black', ['e4', 'c6', 'Nc3', 'd5']),
  ];
  const bookGames = [
    // opponent as Black meets 1.d4 and 1.c4 (feeds the white forest)
    bookGame('black', ['d4', 'Nf6']), bookGame('black', ['c4', 'e5']),
    // opponent as White opens 1.e4 (feeds the black forest root)
    bookGame('white', ['e4', 'c6']), bookGame('white', ['e4', 'e5']),
  ];
  const clash = await build(kaiGames, bookGames);

  const w = clash.forests.white;
  assert.equal(w.mover, 'kai');
  assert.equal(w.side, 'white');
  assert.deepEqual(new Set(edgeSans(w)), new Set(['d4', 'c4'])); // his menu, Nf3 (1 game) filtered

  const b = clash.forests.black;
  assert.equal(b.mover, 'opponent'); // the opponent chooses the opening when the player is Black
  assert.equal(b.side, 'white');
  assert.ok(edgeSans(b).includes('e4'));
});

test('opponent replies branch by weight with a min-count floor, and carry share/count/score', async () => {
  const kaiGames = [kaiGame('white', ['d4', 'Nf6']), kaiGame('white', ['d4', 'Nf6'])];
  // Nf6 x3 (kept), d5 x1 (below minCountOpp, dropped)
  const bookGames = [
    bookGame('black', ['d4', 'Nf6'], { result: '0-1' }),
    bookGame('black', ['d4', 'Nf6'], { result: '1/2-1/2' }),
    bookGame('black', ['d4', 'Nf6'], { result: '0-1' }),
    bookGame('black', ['d4', 'd5'], { result: '1-0' }),
  ];
  const clash = await build(kaiGames, bookGames);
  const oppNode = clash.forests.white.edges.find(e => e.san === 'd4').child; // opponent to move after 1.d4
  assert.equal(oppNode.mover, 'opponent');
  assert.deepEqual(edgeSans(oppNode), ['Nf6']); // d5 (1 game) dropped
  const nf6 = oppNode.edges[0];
  assert.equal(nf6.count, 3);
  // score is the subject's (Black) result: two wins + one draw over three games = 83%
  assert.equal(nf6.scorePct, 83);
  assert.ok(nf6.share > 0 && nf6.share <= 100);
});

test('prep-ends: opponent never faced this position (nodata) vs the player has no continuation (kaiPrepEnds)', async () => {
  // The player plays 1.b3 (his game), but the opponent has never faced 1.b3.
  const kaiGames = [kaiGame('white', ['b3', 'e5']), kaiGame('white', ['b3', 'd5'])];
  const bookGames = [bookGame('black', ['e4', 'c5']), bookGame('black', ['e4', 'e5'])]; // only ever met 1.e4
  const clash = await build(kaiGames, bookGames);
  const oppNode = clash.forests.white.edges.find(e => e.san === 'b3').child;
  assert.equal(oppNode.oppPrepEnds, true);
  assert.equal(oppNode.oppPrepEndsReason, 'nodata');
  assert.equal(oppNode.edges.length, 0);

  // Now give the opponent a reply the player has never met, so the player's line ends.
  const kai2 = [kaiGame('white', ['d4', 'Nf6']), kaiGame('white', ['d4', 'Nf6'])]; // only knows d4 Nf6
  const book2 = [bookGame('black', ['d4', 'g6']), bookGame('black', ['d4', 'g6'])]; // opp plays g6, not Nf6
  const clash2 = await build(kai2, book2);
  const afterD4 = clash2.forests.white.edges.find(e => e.san === 'd4').child; // opponent node
  const g6 = afterD4.edges.find(e => e.san === 'g6');
  assert.ok(g6, 'opponent reply g6 is present');
  assert.equal(g6.child.mover, 'kai');
  assert.equal(g6.child.kaiPrepEnds, true); // the player has no game continuing after 1.d4 g6
});

test('colour handling when the player is Black: opponent move 1, then the player replies from his own games', async () => {
  const kaiGames = [
    kaiGame('black', ['e4', 'c6', 'd4', 'd5']), kaiGame('black', ['e4', 'c6', 'Nc3', 'd5']),
  ];
  const bookGames = [
    bookGame('white', ['e4', 'c6', 'd4']), bookGame('white', ['e4', 'c6', 'd4']), // opp as White: 1.e4 then 2.d4
  ];
  const clash = await build(kaiGames, bookGames);
  const b = clash.forests.black;
  const e4 = b.edges.find(e => e.san === 'e4');
  assert.ok(e4, 'opponent opens 1.e4');
  const kaiReply = e4.child; // player (Black) to move
  assert.equal(kaiReply.mover, 'kai');
  assert.equal(kaiReply.side, 'black');
  assert.ok(edgeSans(kaiReply).includes('c6')); // his Caro-Kann reply
});

test('transposition merge: the same position reached by two move orders is not expanded twice', async () => {
  // Two crossing move orders (d4/c4 vs c4/d4) reach the identical position; the
  // second occurrence must reference-link rather than re-expand.
  const kaiGames = [
    kaiGame('white', ['d4', 'Nf6', 'c4', 'e6']), kaiGame('white', ['d4', 'Nf6', 'c4', 'e6']),
    kaiGame('white', ['c4', 'Nf6', 'd4', 'e6']), kaiGame('white', ['c4', 'Nf6', 'd4', 'e6']),
  ];
  const bookGames = [
    bookGame('black', ['d4', 'Nf6']), bookGame('black', ['d4', 'Nf6']),
    bookGame('black', ['c4', 'Nf6']), bookGame('black', ['c4', 'Nf6']),
  ];
  const clash = await build(kaiGames, bookGames);
  const transposed = allNodes(clash.forests.white).filter(n => n.transposesTo);
  assert.ok(transposed.length >= 1, 'at least one node transposes into an earlier one');
});

test('a deviation in the player\'s own games is flagged on the edge', async () => {
  const kaiGames = [
    // On his 2nd move (ply 3) he leaves theory: playedRank null.
    kaiGame('white', ['d4', 'd5', 'Nc3'], { overrides: { 3: { playedRank: null } } }),
    kaiGame('white', ['d4', 'd5', 'Nc3'], { overrides: { 3: { playedRank: null } } }),
  ];
  const bookGames = [bookGame('black', ['d4', 'd5']), bookGame('black', ['d4', 'd5'])];
  const clash = await build(kaiGames, bookGames);
  const afterD5 = clash.forests.white.edges.find(e => e.san === 'd4').child.edges.find(e => e.san === 'd5').child; // player to move
  const nc3 = afterD5.edges.find(e => e.san === 'Nc3');
  assert.ok(nc3, 'the player continues with Nc3');
  assert.equal(nc3.deviation, true);
});

test('evals are stored White-POV, matching the source analysis', async () => {
  // Sanity: the cp on a player edge is the evalAfter we fed in (White POV).
  const kaiGames = [kaiGame('white', ['e4', 'e5'], { overrides: { 1: { evalAfter: 25 } } }), kaiGame('white', ['e4', 'c5'], { overrides: { 1: { evalAfter: 25 } } })];
  const bookGames = [bookGame('black', ['e4', 'e5']), bookGame('black', ['e4', 'c5'])];
  const clash = await build(kaiGames, bookGames);
  const e4 = clash.forests.white.edges.find(e => e.san === 'e4');
  assert.equal(e4.cp, 25);
});

test('clashParams clamps caller input to sane ranges', () => {
  assert.equal(clashParams({ maxPly: 999 }).maxPly, 24);
  assert.equal(clashParams({ maxPly: 1 }).maxPly, 4);
  assert.equal(clashParams({ oppBranch: 99 }).oppBranch, 5);
  assert.equal(clashParams({ minShareOpp: 20 }).minShareOpp, 0.2);
  assert.equal(clashParams({}).maxPly, 20); // default
});

test('the FENs used for the board are real and legal (chess.js accepts each edge)', async () => {
  const kaiGames = [kaiGame('white', ['d4', 'd5']), kaiGame('white', ['d4', 'Nf6'])];
  const bookGames = [bookGame('black', ['d4', 'Nf6']), bookGame('black', ['d4', 'd5'])];
  const clash = await build(kaiGames, bookGames);
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

test('engine extension fills prep-end leaves with White-POV evals (candidate moves from the engine)', async () => {
  const kaiGames = [
    kaiGame('white', ['d4', 'Nf6']), kaiGame('white', ['d4', 'Nf6']), // knows d4 Nf6
    kaiGame('white', ['b3', 'e5']), kaiGame('white', ['b3', 'd5']),    // and 1.b3
  ];
  const bookGames = [
    bookGame('black', ['d4', 'g6']), bookGame('black', ['d4', 'g6']), // opp meets 1.d4 with g6 (the player has no games here)
    // opponent never faced 1.b3
    bookGame('black', ['e4', 'c5']), bookGame('black', ['e4', 'e5']),
  ];
  const { index, coverage } = await buildOpponentIndex(bookOf(bookGames), SETTINGS, { now: NOW });
  const kai = buildKaiIndex(kaiGames);
  const clash = assembleClashForest({ oppIndex: index, coverage, kai, book: bookOf(bookGames) });

  await extendClashLeaves(clash, index, { engineDepth: 10, engineMultiPv: 3 }, fakePool());
  assert.equal(clash.engineExtended, true);

  const nodes = allNodes(clash.forests.white);
  // Your-move leaf (White to move after 1.d4 g6): best line cp 30, White POV = +30.
  const kaiLeaf = nodes.find(n => n.kaiPrepEnds && n.engineBest);
  assert.ok(kaiLeaf, 'the kaiPrepEnds leaf got an engine suggestion');
  assert.equal(kaiLeaf.side, 'white');
  assert.equal(kaiLeaf.engineBest.cp, 30);
  assert.ok(kaiLeaf.engineLines.length >= 1 && kaiLeaf.engineLines[0].childFen);

  // Opponent-to-move leaf (Black to move after 1.b3): 30 from Black's view is -30 for White.
  const oppLeaf = nodes.find(n => n.oppPrepEnds && n.oppPrepEndsReason === 'nodata' && n.engineBest);
  assert.ok(oppLeaf, 'the oppPrepEnds leaf got an engine suggestion');
  assert.equal(oppLeaf.side, 'black');
  assert.equal(oppLeaf.engineBest.cp, -30);
});
