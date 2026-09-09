import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { tempData, makeGame, writeGame } from './helpers.js';

process.env.DATA_DIR = tempData();
const { syncDrillsForGame, syncAllDrills, reviewDrill, undoReview, suspendDrill, restoreSuspended, dueDrills, recordGuess, recordFeedback, removeDrillsForGame } = await import('../server/drills.js');
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
  assert.deepEqual(core.acceptedUci, ['d2d4', 'g1f3']); // both within 3 win-% of best
});

test('acceptance band is win-probability, not fixed centipawns', async () => {
  // At equality, 50cp behind is a real concession (about 4.6 win-%): rejected.
  const tight = makeGame({ id: 'aaaaaaaaaa05', moments: [{ ply: 1, loss: 25 }] });
  tight.analysis.moves[0].lines = [
    { multipv: 1, cp: 50, uci: 'd2d4', san: ['d4'] },
    { multipv: 2, cp: 0, uci: 'g1f3', san: ['Nf3'] },
  ];
  await syncDrillsForGame(tight, settings);
  // Already winning by 4+ pawns, the same 50cp is noise (under 3 win-%): accepted.
  const winning = makeGame({ id: 'aaaaaaaaaa06', moments: [{ ply: 1, loss: 25 }] });
  winning.analysis.moves[0].lines = [
    { multipv: 1, cp: 450, uci: 'd2d4', san: ['d4'] },
    { multipv: 2, cp: 400, uci: 'g1f3', san: ['Nf3'] },
  ];
  await syncDrillsForGame(winning, settings);
  const { drills } = await getDrills();
  assert.deepEqual(drills.find(d => d.id === 'aaaaaaaaaa05:1').acceptedUci, ['d2d4']);
  assert.deepEqual(drills.find(d => d.id === 'aaaaaaaaaa06:1').acceptedUci, ['d2d4', 'g1f3']);
});

test('a forced mate accepts only other mating moves, not merely winning ones', async () => {
  const g = makeGame({ id: 'aaaaaaaaaa20', moments: [{ ply: 1, loss: 25 }] });
  g.analysis.moves[0].lines = [
    { multipv: 1, cp: 9995, mate: 3, uci: 'd2d4', san: ['d4'] },    // forced mate
    { multipv: 2, cp: 900, mate: null, uci: 'g1f3', san: ['Nf3'] }, // winning, but not a mate
  ];
  await syncDrillsForGame(g, settings);
  const d = (await getDrills()).drills.find(x => x.id === 'aaaaaaaaaa20:1');
  assert.deepEqual(d.acceptedUci, ['d2d4'], 'only the mating move is accepted when mate is available');
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

test('tactics-allowed moments get a see-the-threat twin drill', async () => {
  const game = makeGame({ id: 'aaaaaaaaaa07', moments: [{ ply: 1, loss: 25 }], category: 'tactics-allowed' });
  await syncDrillsForGame(game, settings);
  const { drills } = await getDrills();
  const threat = drills.find(d => d.id === 'aaaaaaaaaa07:1:threat');
  assert.ok(threat, 'threat drill exists alongside the core drill');
  assert.equal(threat.kind, 'threat');
  assert.equal(threat.sideToMove, 'black'); // the opponent moves: find what the mistake allowed
  assert.equal(threat.orientation, 'white'); // but seen from the player's side of the board
  assert.equal(threat.fen, game.analysis.moves[0].fenAfter);
  assert.ok(drills.find(d => d.id === 'aaaaaaaaaa07:1'), 'core drill still exists');

  // Re-explained under another category: the threat drill no longer applies.
  game.explanations[1].category = 'calculation';
  await syncDrillsForGame(game, settings);
  const after = await getDrills();
  assert.ok(!after.drills.find(d => d.id === 'aaaaaaaaaa07:1:threat'), 'stale threat drill removed');
});

test('lightning round serves a pattern regardless of due; practice grades leave the ladder alone', async () => {
  const game = makeGame({ id: 'aaaaaaaaaa08', moments: [{ ply: 1, loss: 25 }], pattern: 'Hanging piece after exchange' });
  await syncDrillsForGame(game, settings);
  await reviewDrill('aaaaaaaaaa08:1', 'good', true); // step 1: due in 3 days
  const { due } = await dueDrills();
  assert.ok(!due.some(d => d.id === 'aaaaaaaaaa08:1'), 'not in the normal due queue');
  const round = await dueDrills(50, { pattern: 'hanging PIECE, after exchange!' }); // normalized match
  assert.ok(round.due.some(d => d.id === 'aaaaaaaaaa08:1'), 'the lightning round includes it anyway');
  const passed = await reviewDrill('aaaaaaaaaa08:1', 'good', true, true);
  assert.equal(passed.step, 1, 'a practice pass does not advance the ladder');
  assert.equal(passed.reviews.at(-1).practice, true);
  const missed = await reviewDrill('aaaaaaaaaa08:1', 'again', false, true);
  assert.equal(missed.step, 0, 'a practice miss still resets: a miss is real evidence');
});

test('reviews record think time and ladder position; undo restores both', async () => {
  const game = makeGame({ id: 'aaaaaaaaaa09', moments: [{ ply: 1, loss: 25 }] });
  await syncDrillsForGame(game, settings);
  const passed = await reviewDrill('aaaaaaaaaa09:1', 'good', true, false, 4200);
  assert.equal(passed.step, 1);
  const r = passed.reviews.at(-1);
  assert.equal(r.ms, 4200);
  assert.equal(r.prevStep, 0);
  const undone = await undoReview('aaaaaaaaaa09:1');
  assert.equal(undone.step, 0, 'ladder position restored');
  assert.equal(undone.reviews.length, 0, 'review removed');
  await assert.rejects(undoReview('aaaaaaaaaa09:1'), /no review to undo/);
});

test('suspended drills leave every queue until restored', async () => {
  const game = makeGame({ id: 'aaaaaaaaaa10', moments: [{ ply: 1, loss: 25 }], pattern: 'Suspendable' });
  await syncDrillsForGame(game, settings);
  await suspendDrill('aaaaaaaaaa10:1');
  const normal = await dueDrills(50);
  assert.ok(!normal.due.some(d => d.id === 'aaaaaaaaaa10:1'), 'not in the due queue');
  assert.ok(normal.suspendedCount >= 1);
  const round = await dueDrills(50, { pattern: 'Suspendable' });
  assert.ok(!round.due.some(d => d.id === 'aaaaaaaaaa10:1'), 'not in practice rounds either');
  await syncDrillsForGame(game, settings); // re-sync must keep the flag
  assert.ok((await getDrills()).drills.find(d => d.id === 'aaaaaaaaaa10:1').suspended);
  assert.ok(await restoreSuspended() >= 1);
  const after = await dueDrills(50);
  assert.ok(after.due.some(d => d.id === 'aaaaaaaaaa10:1'), 'restored drill is due now');
});

test('category rounds serve every drill of an error type regardless of due date', async () => {
  const game = makeGame({ id: 'aaaaaaaaaa11', moments: [{ ply: 1, loss: 25 }], category: 'endgame-technique' });
  await syncDrillsForGame(game, settings);
  await reviewDrill('aaaaaaaaaa11:1', 'good', true); // step 1: no longer due
  const round = await dueDrills(50, { category: 'endgame-technique' });
  assert.ok(round.due.some(d => d.id === 'aaaaaaaaaa11:1'));
  assert.equal(round.category, 'endgame-technique');
});

test('an opening deviation below the moment threshold becomes an opening drill', async () => {
  const game = makeGame({ id: 'aaaaaaaaaa12', moments: [], plies: 6 });
  const dev = game.analysis.moves[4]; // ply 5, player move
  dev.phase = 'opening'; dev.playedRank = null; dev.loss = 6; dev.judgment = 'good';
  await syncDrillsForGame(game, settings);
  const od = (await getDrills()).drills.find(d => d.id === 'aaaaaaaaaa12:5:opening');
  assert.ok(od, 'opening drill created');
  assert.equal(od.kind, 'opening');
  assert.equal(od.tier, 'opening');

  // The deviation healed (re-analysis found the move fine): the drill goes away.
  dev.playedRank = 1; dev.loss = 0;
  await syncDrillsForGame(game, settings);
  assert.ok(!(await getDrills()).drills.find(d => d.id === 'aaaaaaaaaa12:5:opening'), 'stale opening drill pruned');

  // A cheap off-list deviation (lost under 5 points) is noise, not a drill.
  dev.playedRank = null; dev.loss = 2;
  await syncDrillsForGame(game, settings);
  assert.ok(!(await getDrills()).drills.find(d => d.id === 'aaaaaaaaaa12:5:opening'));
});

test('session queues mix in ephemeral decoys from quiet positions', async () => {
  const dir = process.env.DATA_DIR;
  const game = makeGame({ id: 'aaaaaaaaaa13', moments: [{ ply: 1, loss: 25 }], plies: 14 });
  const q = game.analysis.moves[12]; // ply 13, player move, handled correctly
  q.judgment = 'best'; q.loss = 0;
  q.lines = [
    { multipv: 1, cp: 60, uci: 'd2d4', san: ['d4'] },
    { multipv: 2, cp: -80, uci: 'a2a3', san: ['a3'] }, // a real way to go wrong
  ];
  writeGame(dir, game); // decoys are built from the game files
  const r = await dueDrills(50, { session: true, rand: () => 0 });
  const decoy = r.due.find(d => d.kind === 'decoy');
  assert.ok(decoy, 'a decoy is mixed into the session');
  assert.ok(decoy.ephemeral);
  assert.ok(decoy.acceptedUci.includes(decoy.playedUci), 'his actual fine move is an accepted answer');
  assert.notEqual(r.due[0].kind, 'decoy', 'the session opens with a real drill');
  assert.ok(!(await getDrills()).drills.some(d => d.kind === 'decoy'), 'decoys are never persisted');
  const badge = await dueDrills(50); // no session flag: the badge poll stays cheap and decoy-free
  assert.ok(!badge.due.some(d => d.kind === 'decoy'));
});

test('drill saves mirror to a per-machine file for the data repo', async () => {
  const files = readdirSync(process.env.DATA_DIR);
  assert.ok(files.some(f => /^drills-.+\.json$/.test(f)), 'mirror file exists next to drills.json');
});

test('explanation feedback is stored per moment', async () => {
  await recordFeedback('aaaaaaaaaa08', 1, false);
  const store = await getDrills();
  assert.equal(store.feedback['aaaaaaaaaa08:1'].helpful, false);
  await recordFeedback('aaaaaaaaaa08', 1, true); // changed their mind
  assert.equal((await getDrills()).feedback['aaaaaaaaaa08:1'].helpful, true);
});
