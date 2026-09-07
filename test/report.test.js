import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempData, makeGame, writeGame } from './helpers.js';

process.env.DATA_DIR = tempData();
const { buildReport, parseTimeControl } = await import('../server/report.js');
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

test('buildRepertoire groups lines and marks where prep ends', async () => {
  const rep = await buildRepertoire();
  assert.ok(rep.length >= 1);
  const line = rep.find(l => l.color === 'white' && l.count >= 10);
  assert.ok(line, 'identical openings group into one line');
  assert.ok(line.line.length > 0 && line.line.length <= 8);
  assert.equal(line.prepEndsPly, null); // fixture moments are middlegame, so prep never "ends"
  assert.ok(line.games[0].id);
});
