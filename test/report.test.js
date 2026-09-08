import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { tempData, makeGame, writeGame } from './helpers.js';

process.env.DATA_DIR = tempData();
const { buildReport, parseTimeControl, materialSignature } = await import('../server/report.js');
const { buildRepertoire } = await import('../server/repertoire.js');

const dir = process.env.DATA_DIR;
// 10 games: the first 5 each have a calculation mistake, the last 5 are clean.
for (let i = 1; i <= 10; i++) {
  writeGame(dir, makeGame({
    id: `aaaaaaaaaa${String(i).padStart(2, '0')}`,
    date: `2026.01.${String(i).padStart(2, '0')}`,
    moments: i <= 5 ? [{ ply: 1, loss: 25 }] : [],
    plies: 4,
  }));
}
// One game with clocks: 600+0, white blunders at ply 3 with 400s left (spent 150s).
writeGame(dir, makeGame({
  id: 'bbbbbbbbbb01', date: '2026.02.01', timeControl: '600',
  moments: [{ ply: 3, loss: 35 }], plies: 4, clocks: [550, 590, 400, 580],
}));

test('parseTimeControl', () => {
  assert.deepEqual(parseTimeControl('5400+30'), { base: 5400, inc: 30 });
  assert.deepEqual(parseTimeControl('600'), { base: 600, inc: 0 });
  assert.equal(parseTimeControl('-'), null);
  assert.equal(parseTimeControl(undefined), null);
});

test('buildReport aggregates categories, trend, and time management', async () => {
  const r = await buildReport();
  assert.equal(r.games, 11);
  assert.equal(r.byCategory.calculation.count, 6); // 5 early games + the clocked one
  assert.ok(r.focus.some(f => f.category === 'calculation'));

  // Trend: recent games are clean, so calculation must show as improving.
  assert.ok(r.categoryTrend, 'trend needs 8+ games');
  const calc = r.categoryTrend.find(t => t.category === 'calculation');
  assert.ok(calc.priorPerGame > calc.recentPerGame, 'recent should be lower than prior');
  assert.ok(calc.delta < 0);

  // Time management from the single clocked game.
  assert.ok(r.timeManagement);
  assert.equal(r.timeManagement.comfortBlunders, 1); // 400s left > 5 min at a ≥20-loss moment
  assert.equal(r.timeManagement.momentAvgSpent, 150); // 550 -> 400
  assert.equal(r.timeManagement.underTwoMinMoments, 0);

  // No drill reviews on this machine yet.
  assert.equal(r.drillStats, null);
});

test('unknown results are excluded from the score, not counted as losses', async () => {
  writeGame(dir, makeGame({ id: 'cccccccccc99', date: '2026.03.01', result: '*', moments: [] , plies: 2 }));
  const r = await buildReport();
  // 11 wins (1-0 as white) with known results; the '*' game must not dilute.
  assert.equal(r.byColor.white.scorePct, 100);
});

test('materialSignature is from the mover\'s perspective', () => {
  assert.equal(materialSignature('8/R3k3/8/P3K3/4P3/8/8/7r b - - 4 55', 'black'), 'R vs R+2P');
  assert.equal(materialSignature('8/R3k3/8/P3K3/4P3/8/8/7r w - - 4 55', 'white'), 'R+2P vs R');
});

test('endgame moments are bucketed by material in the report', async () => {
  writeGame(dir, makeGame({ id: 'dddddddddd99', date: '2026.03.02', moments: [{ ply: 1, loss: 25, phase: 'endgame' }], plies: 2 }));
  const r = await buildReport();
  assert.ok(r.endgames.length >= 1);
  assert.equal(r.endgames[0].count, 1);
  assert.ok(r.endgames[0].signature.includes(' vs '));
});

test('buildRepertoire groups lines and marks where prep ends', async () => {
  const rep = await buildRepertoire();
  assert.ok(rep.length >= 1);
  const line = rep.find(l => l.color === 'white' && l.count >= 10);
  assert.ok(line, 'identical openings group into one line');
  assert.ok(line.line.length > 0 && line.line.length <= 8);
  assert.equal(line.prepEndsPly, null); // fixture moments are middlegame, so prep never "ends"
  assert.ok(line.games[0].id);
});

/** Analysed game with real positions from SAN moves; the player is White, no mistakes. */
function openingGame(id, sans, date) {
  const chess = new Chess();
  const moves = sans.map((san, i) => {
    const fenBefore = chess.fen();
    const mv = chess.move(san);
    return {
      ply: i + 1, moveNumber: Math.floor(i / 2) + 1, color: mv.color === 'w' ? 'white' : 'black',
      san: mv.san, uci: mv.from + mv.to + (mv.promotion || ''), fenBefore, fenAfter: chess.fen(),
      clock: null, evalBefore: 0, evalAfter: 0, loss: 0, cpLoss: 0, accuracy: 95,
      judgment: 'best', phase: 'opening', isPlayer: i % 2 === 0,
      bestUci: mv.from + mv.to, bestSan: mv.san, playedRank: 1,
      lines: [{ multipv: 1, cp: 20, uci: mv.from + mv.to, san: [mv.san] }],
    };
  });
  const base = makeGame({ id, date, moments: [], plies: 2 });
  return { ...base, moves, analysis: { ...base.analysis, moves, summary: { ...base.analysis.summary, moments: [] } } };
}

test('buildRepertoire merges transpositions by position, keeping the common move order', async () => {
  // Same position after 4 plies via two move orders.
  writeGame(dir, openingGame('eeeeeeeeee01', ['d4', 'd5', 'c4', 'e6'], '2026.04.01'));
  writeGame(dir, openingGame('eeeeeeeeee02', ['d4', 'd5', 'c4', 'e6'], '2026.04.02'));
  writeGame(dir, openingGame('eeeeeeeeee03', ['c4', 'e6', 'd4', 'd5'], '2026.04.03'));
  const rep = await buildRepertoire();
  const merged = rep.find(l => l.games.some(g => g.id === 'eeeeeeeeee01'));
  assert.ok(merged, 'line exists');
  assert.equal(merged.count, 3, 'all three games share one line');
  assert.equal(merged.moveOrders, 2);
  assert.deepEqual(merged.line, ['d4', 'd5', 'c4', 'e6'], 'most common move order shown');
});
