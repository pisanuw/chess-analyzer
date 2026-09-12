// Per-drill ease, stated confidence, and the explain-back note on the review
// path; the report's calibration table and "sure and wrong" list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempData, makeGame, writeGame } from './helpers.js';

process.env.DATA_DIR = tempData();
const dir = process.env.DATA_DIR;
writeGame(dir, makeGame({ id: 'e1e1e1e1e101', moments: [{ ply: 1, loss: 25 }], pattern: 'Wrong rook' }));
writeGame(dir, makeGame({ id: 'e1e1e1e1e102', moments: [{ ply: 1, loss: 35 }], pattern: 'Loose piece', date: '2026.02.02' }));

const { getDrills } = await import('../server/store.js');
const { syncAllDrills, reviewDrill, undoReview, nextEase, intervalDays, EASE_DEFAULT, EASE_MIN, EASE_MAX } = await import('../server/drills.js');
const { buildReport } = await import('../server/report.js');
const { app } = await import('../server/index.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const json = (method, path, body) => fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
const days = iso => (Date.parse(iso) - Date.now()) / 86400000;

test('ease moves with grade, speed, and confidence, within bounds', () => {
  assert.equal(nextEase(undefined, { grade: 'good', correct: true }), EASE_DEFAULT, 'a plain pass leaves ease alone');
  assert.equal(nextEase(2.5, { grade: 'easy', correct: true }), 2.65);
  assert.equal(nextEase(2.5, { grade: 'good', correct: true, ms: 3000 }), 2.55, 'a fast answer is recognition');
  assert.equal(nextEase(2.5, { grade: 'good', correct: true, ms: 45000 }), 2.45, 'a slow answer was re-derived');
  assert.equal(nextEase(2.5, { grade: 'good', correct: true, confidence: 'guess' }), 2.45, 'right by luck');
  assert.equal(nextEase(2.5, { grade: 'again', correct: false }), 2.3);
  assert.equal(nextEase(2.5, { grade: 'again', correct: false, confidence: 'sure' }), 2.2, 'sure and wrong costs more');
  assert.equal(nextEase(1.35, { grade: 'again', correct: false, confidence: 'sure' }), EASE_MIN);
  assert.equal(nextEase(3.15, { grade: 'easy', correct: true, ms: 1000 }), EASE_MAX);
  assert.equal(intervalDays(1), 3, 'the documented ladder at default ease');
  assert.equal(intervalDays(2, 3.0), 8.4);
  assert.equal(intervalDays(0, 1.3), 1, 'never under a day');
  assert.equal(intervalDays(9, 2.5), 60, 'past the top rung stays at the top');
});

test('reviews record confidence and the explain-back note; ease scales the due date; undo restores it', async () => {
  await syncAllDrills();
  const id = 'e1e1e1e1e101:1';
  const sure = await reviewDrill(id, 'good', true, false, 2000, 'kai', { confidence: 'sure' });
  assert.equal(sure.ease, 2.55, 'fast and sure');
  assert.equal(sure.step, 1);
  assert.ok(days(sure.due) > 3.0 && days(sure.due) < 3.2, `3 days scaled by 2.55/2.5: got ${days(sure.due)}`);
  assert.equal(sure.reviews.at(-1).confidence, 'sure');
  assert.equal(sure.reviews.at(-1).prevEase, null, 'the first review recorded no prior ease');

  const miss = await reviewDrill(id, 'again', false, false, 9000, 'kai', { confidence: 'sure', note: '  I missed   the back rank  ' });
  assert.equal(miss.ease, 2.25, 'sure and wrong: minus 0.3');
  assert.equal(miss.reviews.at(-1).note, 'I missed the back rank', 'whitespace collapsed');
  assert.equal(miss.reviews.at(-1).prevEase, 2.55);
  assert.equal(miss.step, 0);

  const undone = await undoReview(id, 'kai');
  assert.equal(undone.ease, 2.55, 'undo restores the ease with the ladder');
  assert.equal(undone.reviews.length, 1);
  await undoReview(id, 'kai');
  assert.equal((await getDrills('kai')).drills.find(d => d.id === id).ease, undefined, 'undoing the first review removes the ease field');

  const lucky = await reviewDrill(id, 'easy', true, false, null, 'kai', { confidence: 'guess', note: 'x'.repeat(400) });
  assert.equal(lucky.reviews.at(-1).grade, 'good', 'a lucky guess cannot be graded easy');
  assert.equal(lucky.reviews.at(-1).note.length, 300, 'notes are clipped');
  assert.equal(lucky.ease, 2.45);
  const bad = await reviewDrill(id, 'good', true, false, null, 'kai', { confidence: 'certain' });
  assert.equal(bad.reviews.at(-1).confidence, undefined, 'an unknown confidence is dropped');
});

test('the report tallies calibration per confidence level and lists sure-and-wrong reviews with their notes', async () => {
  await reviewDrill('e1e1e1e1e102:1', 'again', false, false, null, 'kai', { confidence: 'sure', note: 'thought the knight was pinned' });
  await reviewDrill('e1e1e1e1e102:1', 'good', true, false, null, 'kai', { confidence: 'likely' });
  const r = await buildReport({ userId: 'kai' });
  const c = r.drillStats.calibration;
  assert.deepEqual(Object.keys(c), ['sure', 'likely', 'guess']);
  assert.deepEqual(c.sure, { attempts: 1, correct: 0, rate: 0 }, 'the earlier sure pass was undone; only the sure miss remains');
  assert.deepEqual(c.guess, { attempts: 1, correct: 1, rate: 100 });
  assert.equal(r.drillStats.sureAndWrong.length, 1);
  assert.equal(r.drillStats.sureAndWrong[0].gameId, 'e1e1e1e1e102');
  assert.equal(r.drillStats.sureAndWrong[0].note, 'thought the knight was pinned');
  assert.equal(r.drillStats.sureAndWrong[0].pattern, 'Loose piece');
});

test('the review route passes confidence and note through', async () => {
  const r = await (await json('POST', '/api/drills/e1e1e1e1e101%3A1/review', { grade: 'good', correct: true, ms: 1500, confidence: 'likely', note: 'saw the fork' })).json();
  assert.equal(r.drill.reviews.at(-1).confidence, 'likely');
  assert.equal(r.drill.reviews.at(-1).note, 'saw the fork');
  server.close();
});
