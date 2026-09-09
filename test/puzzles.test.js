import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempData, makeGame, writeGame } from './helpers.js';

const DATA = tempData();
process.env.DATA_DIR = DATA;
const { buildPuzzles, decisiveTactic } = await import('../server/puzzles.js');

// Override one move's lines into a decisive tactic (a clearly winning, unique
// move) for the side on move at `ply`. cp is White-perspective, so it is signed
// by the mover's colour.
function withTactic(g, ply, { mate = null } = {}) {
  const m = g.analysis.moves[ply - 1];
  const s = m.color === 'white' ? 1 : -1;
  m.bestUci = 'd2d4'; m.bestSan = 'd4';
  m.lines = mate != null
    ? [{ multipv: 1, mate, cp: s * 9990, uci: 'd2d4', san: ['d4'] }, { multipv: 2, cp: s * 50, uci: 'g1f3', san: ['Nf3'] }]
    : [{ multipv: 1, cp: s * 600, uci: 'd2d4', san: ['d4'] }, { multipv: 2, cp: s * 50, uci: 'g1f3', san: ['Nf3'] }];
  return g;
}

// Fixtures: an own game with a white tactic, a scout game with a black tactic,
// and an own game whose flagged moment is also a tactic the player missed
// (played e2e4 while d2d4 won).
writeGame(DATA, withTactic(makeGame({ id: 'aaaaaaaaaa01', color: 'white', moments: [], plies: 10, explained: false }), 9));
writeGame(DATA, withTactic(makeGame({ id: 'bbbbbbbbbb01', color: 'black', moments: [], plies: 10, explained: false, purpose: 'scout' }), 8));
writeGame(DATA, withTactic(makeGame({ id: 'cccccccccc01', color: 'white', moments: [{ ply: 9, loss: 40 }], plies: 10, explained: false }), 9));

test('decisiveTactic flags a winning, unique move; not book, quiet, or a losing one', () => {
  const mk = over => ({ ply: 12, color: 'white', bestUci: 'd2d4', uci: 'e2e4',
    lines: [{ cp: 600, uci: 'd2d4', san: ['d4'] }, { cp: 50, uci: 'g1f3', san: ['Nf3'] }], ...over });
  assert.equal(decisiveTactic(mk()), true);
  assert.equal(decisiveTactic(mk({ ply: 4 })), false);                              // book opening
  assert.equal(decisiveTactic(mk({ lines: [{ cp: 600 }, { cp: 570 }] })), false);  // no unique move
  assert.equal(decisiveTactic(mk({ lines: [{ cp: 100 }, { cp: -300 }] })), false); // not winning enough
  assert.equal(decisiveTactic(mk({ lines: [{ mate: 2 }, { cp: 50 }] })), true);    // forced mate for the mover
  assert.equal(decisiveTactic(mk({ lines: [{ mate: -2 }, { cp: 50 }] })), false);  // being mated
});

test('tactics source spans both colours and scout games', async () => {
  const { puzzles, total } = await buildPuzzles('tactics', 30, () => 0);
  const ids = puzzles.map(p => p.id);
  assert.ok(ids.includes('aaaaaaaaaa01:9'));
  assert.ok(ids.includes('bbbbbbbbbb01:8'), 'scout game tactic is included for tactics');
  assert.ok(ids.includes('cccccccccc01:9'));
  assert.equal(total, 3);
  const black = puzzles.find(p => p.id === 'bbbbbbbbbb01:8');
  assert.equal(black.sideToMove, 'black');
  assert.deepEqual(black.acceptedUci, ['d2d4']); // the unique winning move
});

test('moments and missed are own-only', async () => {
  const moments = await buildPuzzles('moments', 30, () => 0);
  const missed = await buildPuzzles('missed', 30, () => 0);
  assert.ok(moments.puzzles.some(p => p.id === 'cccccccccc01:9'), 'flagged moment is a puzzle');
  assert.ok(missed.puzzles.some(p => p.id === 'cccccccccc01:9'), 'unfound tactic is a puzzle');
  // The pure-tactic own game (no flagged moment) is not a "moment"; the played
  // move there was best-by-default in the fixture only where overridden.
  assert.ok(!moments.puzzles.some(p => p.id === 'aaaaaaaaaa01:9'));
  // Scout positions never leak into own-only sources.
  assert.ok(!moments.puzzles.some(p => p.gameId === 'bbbbbbbbbb01'));
  assert.ok(!missed.puzzles.some(p => p.gameId === 'bbbbbbbbbb01'));
});

test('limit caps the deck but total reports the full pool', async () => {
  const { puzzles, total } = await buildPuzzles('tactics', 1, () => 0);
  assert.equal(puzzles.length, 1);
  assert.equal(total, 3);
});

test('an unknown source falls back to tactics', async () => {
  const { source, total } = await buildPuzzles('bogus', 30, () => 0);
  assert.equal(source, 'tactics');
  assert.equal(total, 3);
});
