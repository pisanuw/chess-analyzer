import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempData, makeGame, writeGame } from './helpers.js';

process.env.DATA_DIR = tempData();
const { syncDrillsForGame, syncAllDrills, reviewDrill, dueDrills, recordGuess, removeDrillsForGame } = await import('../server/drills.js');
const { getDrills } = await import('../server/store.js');

const settings = { drillThreshold: 20, momentThreshold: 12 };

test('sync creates tiered drills and copies category/pattern', async () => {
  const game = makeGame({ id: 'aaaaaaaaaa01', moments: [{ ply: 1, loss: 25 }, { ply: 3, loss: 14 }] });
  await syncDrillsForGame(game, settings);
  const { drills } = await getDrills();
  const core = drills.find(d => d.id === 'aaaaaaaaaa01:1');
  const sharpen = drills.find(d => d.id === 'aaaaaaaaaa01:3');
  assert.equal(core.tier, 'core');
  assert.equal(sharpen.tier, 'sharpen');
  assert.equal(core.category, 'calculation');
  assert.equal(core.pattern, 'Test pattern');
  assert.deepEqual(core.acceptedUci, ['d2d4', 'g1f3']); // both within 30cp of best
});

test('re-sync preserves review state', async () => {
  const game = makeGame({ id: 'aaaaaaaaaa01', moments: [{ ply: 1, loss: 25 }, { ply: 3, loss: 14 }] });
  await reviewDrill('aaaaaaaaaa01:1', 'good', true);
  await syncDrillsForGame(game, settings);
  const { drills } = await getDrills();
  const d = drills.find(x => x.id === 'aaaaaaaaaa01:1');
  assert.equal(d.reviews.length, 1);
  assert.equal(d.step, 1);
});

test('failed review stays due today; pass advances the ladder', async () => {
  const failed = await reviewDrill('aaaaaaaaaa01:1', 'again', false);
  assert.equal(failed.step, 0);
  assert.ok(Date.parse(failed.due) <= Date.now(), 'failed drill must be due now');
  const passed = await reviewDrill('aaaaaaaaaa01:1', 'good', true);
  assert.equal(passed.step, 1);
  const days = (Date.parse(passed.due) - Date.now()) / 86400000;
  assert.ok(days > 2.9 && days < 3.1, `expected ~3 days, got ${days}`);
});

test('dueDrills lists core before sharpen', async () => {
  await reviewDrill('aaaaaaaaaa01:1', 'again', false); // make the core drill due now
  const { due } = await dueDrills();
  const tiers = due.map(d => d.tier);
  assert.deepEqual([...tiers].sort((a, b) => (a === 'sharpen') - (b === 'sharpen')), tiers, 'core drills must come first');
  assert.ok(due.some(d => d.tier === 'core') && due.some(d => d.tier === 'sharpen'));
});

test('correct first-try guess starts the drill at step 2', async () => {
  const game = makeGame({ id: 'aaaaaaaaaa02', moments: [{ ply: 1, loss: 30 }] });
  const r = await recordGuess(game, 1, 'd2d4', true, settings);
  assert.equal(r.seeded, true);
  assert.equal(r.step, 2);
  const days = (Date.parse(r.due) - Date.now()) / 86400000;
  assert.ok(days > 6.9 && days < 7.1, `expected ~7 days, got ${days}`);
});

test('a missed guess seeds a drill; later guesses do not boost', async () => {
  const game = makeGame({ id: 'aaaaaaaaaa03', moments: [{ ply: 1, loss: 15 }] });
  const r1 = await recordGuess(game, 1, 'a2a3', false, settings);
  assert.equal(r1.seeded, true);
  assert.equal(r1.step, 0);
  const r2 = await recordGuess(game, 1, 'd2d4', true, settings); // not first try
  assert.equal(r2.step, 0);
});

test('syncAllDrills derives from disk and prunes orphans', async () => {
  const dir = process.env.DATA_DIR;
  writeGame(dir, makeGame({ id: 'aaaaaaaaaa04', moments: [{ ply: 1, loss: 22 }] }));
  await removeDrillsForGame('aaaaaaaaaa01'); // game 01 was never written to disk
  await syncAllDrills();
  const { drills } = await getDrills();
  assert.ok(drills.some(d => d.gameId === 'aaaaaaaaaa04'), 'derives drills from game files');
  assert.ok(!drills.some(d => d.gameId === 'aaaaaaaaaa02'), 'prunes drills whose game file is gone');
});

test('syncAllDrills prunes drills for plies that are no longer moments', async () => {
  const dir = process.env.DATA_DIR;
  // Same game, but the moment moved from ply 1 to ply 3 (e.g. after a colour fix).
  writeGame(dir, makeGame({ id: 'aaaaaaaaaa04', moments: [{ ply: 3, loss: 22 }], plies: 4 }));
  await syncAllDrills();
  const { drills } = await getDrills();
  assert.ok(!drills.some(d => d.id === 'aaaaaaaaaa04:1'), 'stale ply drill removed');
  assert.ok(drills.some(d => d.id === 'aaaaaaaaaa04:3'), 'current moment drill present');
});
