import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, winProb, scoreToCp, phaseOf, summarize, moveAccuracy } from '../server/analyze.js';
import { makeGame } from './helpers.js';

test('judgment thresholds at 3/10/20/30 win-probability loss', () => {
  assert.equal(judge(0), 'best');
  assert.equal(judge(2.9), 'best');
  assert.equal(judge(3), 'good');
  assert.equal(judge(9.9), 'good');
  assert.equal(judge(10), 'inaccuracy');
  assert.equal(judge(20), 'mistake');
  assert.equal(judge(30), 'blunder');
});

test('winProb is 50 at equality, monotonic, clamped', () => {
  assert.equal(winProb(0), 50);
  assert.ok(winProb(100) > winProb(0));
  assert.ok(winProb(-100) < winProb(0));
  assert.equal(winProb(2000), winProb(1500)); // clamped at 1500cp
  assert.ok(winProb(1500) > 99);
});

test('moveAccuracy: no loss is ~100, large loss approaches 0', () => {
  assert.ok(moveAccuracy(50, 50) > 99);
  assert.ok(moveAccuracy(90, 10) < 5);
});

test('scoreToCp maps mates near +/-10000', () => {
  assert.equal(scoreToCp({ mate: 2 }), 9998);
  assert.equal(scoreToCp({ mate: -3 }), -9997);
  assert.equal(scoreToCp({ cp: 42 }), 42);
  assert.equal(scoreToCp(null), 0);
});

test('phaseOf: start is opening, bare kings and pawns is endgame', () => {
  assert.equal(phaseOf('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 1), 'opening');
  assert.equal(phaseOf('8/4k3/8/8/4P3/4K3/8/8 w - - 0 50', 99), 'endgame');
  assert.equal(phaseOf('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 30), 'middlegame');
});

test('phaseOf: queens off with a full board is still a middlegame', () => {
  // Queens traded, but both rooks, a bishop and knight each (8 pieces), and
  // every pawn: not an endgame despite no queens.
  assert.equal(phaseOf('rnb2rk1/pppppppp/8/8/8/8/PPPPPPPP/RNB2RK1 w - - 0 20', 40), 'middlegame');
  // Same 8 pieces but only a pawn each side (low total force): a real endgame.
  assert.equal(phaseOf('rnbr2k1/5p2/8/8/8/8/5P2/RNBR2K1 w - - 0 40', 79), 'endgame');
});

test('summarize selects player moments at the threshold and computes acpl', () => {
  const g = makeGame({ moments: [{ ply: 1, loss: 25 }, { ply: 3, loss: 5 }], plies: 4 });
  const s = summarize(g.analysis.moves, 'white', 12);
  assert.deepEqual(s.moments, [1]); // ply 3 lost only 5, below threshold
  assert.equal(s.player, 'white');
  const whiteMoves = g.analysis.moves.filter(m => m.color === 'white');
  const expectedAcpl = Math.round(whiteMoves.reduce((t, m) => t + m.cpLoss, 0) / whiteMoves.length);
  assert.equal(s.white.acpl, expectedAcpl);
  assert.equal(s.white.mistakes, 1);
});

test('summarize skips moments where the player was already lost', () => {
  const g = makeGame({ moments: [{ ply: 1, loss: 25 }], plies: 2 });
  // Player (white) was already lost before the move: a further loss is not a
  // critical moment a coach would flag.
  g.analysis.moves[0].evalBefore = -900; // about -9 pawns, win prob well under 15%
  assert.deepEqual(summarize(g.analysis.moves, 'white', 12).moments, []);
  // At equality the same loss is a real moment.
  g.analysis.moves[0].evalBefore = 0;
  assert.deepEqual(summarize(g.analysis.moves, 'white', 12).moments, [1]);
});
