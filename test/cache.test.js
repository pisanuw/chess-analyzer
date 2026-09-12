// The parsed-game cache, the index fingerprint, the memoised builders, and the
// index-backed pattern library: every aggregate reader used to parse every own
// game file per call. Also the deterministic time-pressure rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tempData, makeGame, writeGame } from './helpers.js';

process.env.DATA_DIR = tempData();
const dir = process.env.DATA_DIR;
writeGame(dir, makeGame({ id: 'c1c1c1c1c101', moments: [{ ply: 1, loss: 25 }], pattern: 'Wrong rook' }));
writeGame(dir, makeGame({ id: 'c1c1c1c1c102', moments: [{ ply: 1, loss: 35 }], pattern: 'Wrong rook', date: '2026.02.02' }));
writeGame(dir, makeGame({ id: 'c1c1c1c1c103', moments: [{ ply: 1, loss: 22 }], pattern: 'Loose piece', concept: 'x', date: '2026.03.03' }));

const { listGames, loadGames, getGameCached, indexFingerprint, saveGame, getGame } = await import('../server/store.js');
const { memo, clearMemo, memoStats } = await import('../server/memo.js');
const { buildReport } = await import('../server/report.js');
const { buildRepertoire } = await import('../server/repertoire.js');
const { knownPatterns, canonicalPattern, BATCH_MAX } = await import('../server/jobs.js');
const { timePressureOf, EXPLANATION_SCHEMA, SCOUT_EXPLANATION_SCHEMA, momentPrompt } = await import('../server/prompts.js');

test('index entries carry a file revision and the pattern and concept counts', async () => {
  const index = await listGames('kai');
  assert.equal(index.length, 3);
  assert.ok(index.every(e => /^\d+(\.\d+)?:\d+$/.test(e.fileRev)), 'mtime:size per entry');
  assert.deepEqual(index.find(e => e.id === 'c1c1c1c1c101').patterns, { 'Wrong rook': 1 });
  assert.deepEqual(index.find(e => e.id === 'c1c1c1c1c101').concepts, { concept: 1 });
});

test('the parsed-game cache returns the same object until the file changes, and our own writes evict it', async () => {
  const [entry] = (await listGames('kai')).filter(e => e.id === 'c1c1c1c1c101');
  const a = await getGameCached(entry);
  const b = await getGameCached(entry);
  assert.equal(a, b, 'unchanged file: one parsed object');
  assert.equal(a.id, 'c1c1c1c1c101');
  // A write through the store evicts; the next read parses the new content.
  const g = await getGame('c1c1c1c1c101');
  g.headers.Event = 'Edited';
  await saveGame(g);
  const [fresh] = (await listGames('kai')).filter(e => e.id === 'c1c1c1c1c101');
  assert.notEqual(fresh.fileRev, entry.fileRev, 'a new file version gets a new revision');
  const c = await getGameCached(fresh);
  assert.notEqual(c, a);
  assert.equal(c.headers.Event, 'Edited');
  // An external writer (git pull) changes mtime and size too, so it falls through.
  const file = path.join(dir, 'games', 'c1c1c1c1c101.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  raw.headers.Event = 'Edited again, externally';
  await fs.writeFile(file, JSON.stringify(raw, null, 2));
  const [ext] = (await listGames('kai')).filter(e => e.id === 'c1c1c1c1c101');
  assert.equal((await getGameCached(ext)).headers.Event, 'Edited again, externally');
  assert.equal(await getGameCached({ id: 'nope' }), null);
  assert.equal(await getGameCached({ id: 'dddddddddddd' }), null, 'a missing file is null, not an error');
  assert.equal((await loadGames(await listGames('kai'))).length, 3);
});

test('the fingerprint is order-independent and changes with any file version', async () => {
  const index = await listGames('kai');
  const fp = indexFingerprint(index);
  assert.equal(fp.length, 16);
  assert.equal(indexFingerprint([...index].reverse()), fp);
  assert.notEqual(indexFingerprint(index.slice(1)), fp);
  assert.notEqual(indexFingerprint(index.map(e => (e.id === 'c1c1c1c1c102' ? { ...e, fileRev: '1:1' } : e))), fp);
});

test('memo keeps the newest values per namespace and recomputes only on a new key', async () => {
  clearMemo('t');
  let calls = 0;
  const v1 = await memo('t', 'a', async () => ({ n: ++calls }), { max: 2 });
  const v2 = await memo('t', 'a', async () => ({ n: ++calls }), { max: 2 });
  assert.equal(v1, v2, 'same key: same object, no recompute');
  await memo('t', 'b', async () => ++calls, { max: 2 });
  await memo('t', 'c', async () => ++calls, { max: 2 });
  assert.equal(memoStats().t, 2, 'the oldest key fell out');
  await memo('t', 'a', async () => ++calls, { max: 2 });
  assert.equal(calls, 4, 'key a had been evicted, so it recomputed');
  clearMemo('t');
  assert.equal(memoStats().t, undefined);
});

test('the report and repertoire are memoised on the game files and recomputed after a change', async () => {
  const r1 = await buildReport({ userId: 'kai' });
  assert.equal(r1.games, 3);
  assert.equal(r1.patterns[0].pattern, 'Wrong rook');
  assert.equal(r1.patterns[0].count, 2);
  r1.patterns.length = 0; // a caller mutating its copy must not touch the memo
  const r2 = await buildReport({ userId: 'kai' });
  assert.equal(r2.patterns.length, 2, 'the memo hands out a clone');
  const rep1 = await buildRepertoire({ userId: 'kai' });
  assert.equal(rep1[0].count, 3);
  writeGame(dir, makeGame({ id: 'c1c1c1c1c104', moments: [{ ply: 1, loss: 25 }], pattern: 'Wrong rook', date: '2026.04.04' }));
  const r3 = await buildReport({ userId: 'kai' });
  assert.equal(r3.games, 4, 'a new game file is a new key');
  assert.equal(r3.patterns[0].count, 3);
  assert.equal((await buildRepertoire({ userId: 'kai' }))[0].count, 4);
  assert.equal((await buildReport({ userId: 'kai', color: 'black' })).games, 0, 'the colour cut is part of the key');
  assert.ok(memoStats().report >= 2 && memoStats().repertoire >= 2);
});

test('the pattern library comes off the index and folds spellings onto known names', async () => {
  const known = await knownPatterns({ id: 'c1c1c1c1c101', purpose: 'own', subject: null, explanations: { 1: { pattern: 'Held in memory', concept: 'c' } } });
  assert.deepEqual([...known.patterns], ['Wrong rook', 'Loose piece', 'Held in memory'], 'most frequent first; the current game from memory, the rest from the index');
  assert.ok(known.concepts.has('concept') && known.concepts.has('c'));
  assert.equal(canonicalPattern('wrong ROOK', known.patterns), 'Wrong rook');
  assert.equal(canonicalPattern('Loose  piece!', known.patterns), 'Loose piece');
  assert.equal(canonicalPattern('Brand new', known.patterns), 'Brand new');
  assert.equal(canonicalPattern(null, known.patterns), null);
  assert.equal(BATCH_MAX, 8);
  const scoutKnown = await knownPatterns({ id: 'zzzzzzzzzzzz', purpose: 'scout', subject: 'Someone' });
  assert.equal(scoutKnown.patterns.size, 0, 'libraries do not mix across purposes');
});

test('time pressure is a fact of the clock, stated in the prompt and absent from the schema', () => {
  // Base 3000 s: White spends 60 s on move 1 (no pressure) and is under two
  // minutes after move 2; a second game has White snap-moving in 5 s.
  const g = makeGame({ id: 'c1c1c1c1c1aa', moments: [{ ply: 3, loss: 25 }], clocks: [2940, 2950, 115, 2800], timeControl: '3000+0', plies: 4 });
  assert.equal(timePressureOf(g, 3), true, 'under two minutes left');
  assert.equal(timePressureOf(g, 1), false);
  const snap = makeGame({ id: 'c1c1c1c1c1ab', moments: [{ ply: 3, loss: 25 }], clocks: [3000, 3000, 2995, 2990], timeControl: '3000+0', plies: 4 });
  assert.equal(timePressureOf(snap, 3), true, 'five seconds spent on a critical move');
  assert.equal(timePressureOf(makeGame({ id: 'c1c1c1c1c1ac' }), 1), false, 'no clock data: never flagged');
  assert.match(momentPrompt(snap, 3), /Time pressure: yes \(by the clock rule/);
  assert.match(momentPrompt(g, 1), /Time pressure: no\./);
  assert.ok(!('time_pressure' in EXPLANATION_SCHEMA.properties) && !('time_pressure' in SCOUT_EXPLANATION_SCHEMA.properties));
  assert.ok(!EXPLANATION_SCHEMA.required.includes('time_pressure'));
});
