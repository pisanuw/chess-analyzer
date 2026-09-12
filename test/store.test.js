import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { tempData, makeGame, writeGame } from './helpers.js';

process.env.DATA_DIR = tempData();
const { listGames, saveGame, deleteGame, sweepTmpFiles, ensureDataIgnores, DrillConflict } = await import('../server/store.js');
const { reviewDrill, syncDrillsForGame } = await import('../server/drills.js');

test('game index cache serves cached entries and sees every kind of change', async () => {
  const dir = process.env.DATA_DIR;
  writeGame(dir, makeGame({ id: 'cace0aaaaa01' }));
  assert.equal((await listGames()).length, 1);
  assert.equal((await listGames()).length, 1); // second call hits the cache

  // Our own writes invalidate explicitly.
  await saveGame(makeGame({ id: 'cace0aaaaa01', result: '0-1' }));
  assert.equal((await listGames())[0].result, '0-1');

  // External writers (git pull in the data repo) are caught by mtime+size.
  const file = path.join(dir, 'games', 'cace0aaaaa01.json');
  const g = makeGame({ id: 'cace0aaaaa01', result: '1/2-1/2' });
  writeFileSync(file, JSON.stringify(g, null, 2) + '\n'.repeat(64)); // force a size change
  assert.equal((await listGames())[0].result, '1/2-1/2');

  await deleteGame('cace0aaaaa01');
  assert.equal((await listGames()).length, 0);
});

// --- hosted (Supabase) drill store: compare-and-swap ------------------------

/** Stub fetch: GET serves `row`, PATCH/POST answer from `script` in order. */
function stubFetch(row, script) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const call = { url: String(url), method: opts.method || 'GET', body: opts.body && JSON.parse(opts.body) };
    calls.push(call);
    // Each read serves a fresh copy, like real JSON off the wire; otherwise a
    // retry would see its own failed attempt's in-place mutations.
    if (call.method === 'GET') return { ok: true, json: async () => (row ? [{ value: structuredClone(row) }] : []) };
    const step = script.shift();
    assert.ok(step, `unexpected write: ${call.method} ${call.url}`);
    assert.equal(call.method, step.method);
    assert.match(call.url, step.url);
    return { ok: true, json: async () => step.rows };
  };
  return calls;
}

function hosted(t) {
  const realFetch = global.fetch;
  process.env.SUPABASE_URL = 'http://sb.test';
  process.env.SUPABASE_SERVICE_KEY = 'k';
  t.after(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    global.fetch = realFetch;
  });
}

const storedDrill = { id: 'g:1', gameId: 'g', ply: 1, step: 0, due: '2020-01-01T00:00:00.000Z', reviews: [], lines: [], acceptedUci: [] };

test('hosted write claims the next revision with a filter on the one it read', async t => {
  hosted(t);
  const calls = stubFetch({ drills: [structuredClone(storedDrill)], guesses: {}, rev: 5 }, [
    { method: 'PATCH', url: /value->>rev=eq\.5/, rows: [{ key: 'drills' }] },
  ]);
  const d = await reviewDrill('g:1', 'good', true);
  assert.equal(d.step, 1);
  assert.equal(calls.find(c => c.method === 'PATCH').body.value.rev, 6);
});

test('a lost race re-reads and reapplies the mutation', async t => {
  hosted(t);
  stubFetch({ drills: [structuredClone(storedDrill)], guesses: {}, rev: 5 }, [
    { method: 'PATCH', url: /value->>rev=eq\.5/, rows: [] },              // another writer won
    { method: 'PATCH', url: /value->>rev=eq\.5/, rows: [{ key: 'drills' }] }, // retry succeeds
  ]);
  const d = await reviewDrill('g:1', 'good', true);
  assert.equal(d.step, 1);
});

test('legacy row without a revision is claimed via the null filter', async t => {
  hosted(t);
  stubFetch({ drills: [structuredClone(storedDrill)], guesses: {} }, [
    { method: 'PATCH', url: /value->>rev=is\.null/, rows: [{ key: 'drills' }] },
  ]);
  await reviewDrill('g:1', 'good', true);
});

test('first ever write inserts without clobbering a row that appeared meanwhile', async t => {
  hosted(t);
  const game = makeGame({ id: 'ffffffffff01', moments: [{ ply: 1, loss: 25 }] });
  stubFetch(null, [
    { method: 'PATCH', url: /value->>rev=is\.null/, rows: [] }, // no row to update
    { method: 'POST', url: /chess_kv/, rows: [{ key: 'drills' }] },
  ]);
  await syncDrillsForGame(game, { drillThreshold: 20 });
});

test('persistent conflicts surface as DrillConflict after retries', async t => {
  hosted(t);
  stubFetch({ drills: [structuredClone(storedDrill)], guesses: {}, rev: 2 }, [
    { method: 'PATCH', url: /eq\.2/, rows: [] },
    { method: 'PATCH', url: /eq\.2/, rows: [] },
    { method: 'PATCH', url: /eq\.2/, rows: [] },
  ]);
  await assert.rejects(reviewDrill('g:1', 'good', true), DrillConflict);
});

test('a stalled Supabase connection times out and is retried once', async t => {
  hosted(t);
  process.env.SUPABASE_TIMEOUT_MS = '50';
  t.after(() => delete process.env.SUPABASE_TIMEOUT_MS);
  let calls = 0;
  global.fetch = (url, opts = {}) => new Promise((resolve, reject) => {
    calls++;
    if (calls === 1) { // never answers: only the abort signal ends it
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
      return;
    }
    resolve({ ok: true, json: async () => [{ value: { drills: [structuredClone(storedDrill)], guesses: {}, rev: 1 } }] });
  });
  const { getDrills } = await import('../server/store.js');
  const t0 = Date.now();
  const store = await getDrills('kai');
  assert.equal(calls, 2, 'the stalled call was abandoned and retried');
  assert.ok(Date.now() - t0 < 2000, 'the stall ended at the timeout, not the heat death of the publish');
  assert.equal(store.rev, 1);
});

test('two stalls in a row surface as an error naming the timeout', async t => {
  hosted(t);
  process.env.SUPABASE_TIMEOUT_MS = '30';
  t.after(() => delete process.env.SUPABASE_TIMEOUT_MS);
  global.fetch = (url, opts = {}) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)));
  const { kvGet } = await import('../server/store.js');
  await assert.rejects(kvGet('audit'), /timed out after 30ms/);
});

test('sweepTmpFiles removes crash leftovers; ensureDataIgnores guards the data repo', async () => {
  const dir = process.env.DATA_DIR;
  writeFileSync(path.join(dir, 'drills.json.123.4.tmp'), '{');
  writeFileSync(path.join(dir, 'games', 'aaaa.json.9.1.tmp'), '{');
  // A per-user subdirectory, not just the top level or games/: the sweep walks
  // the whole tree, not a fixed list of directories.
  mkdirSync(path.join(dir, 'users', 'kai'), { recursive: true });
  writeFileSync(path.join(dir, 'users', 'kai', 'drills.json.5.1.tmp'), '{');
  const removed = await sweepTmpFiles();
  assert.ok(removed >= 3, 'all leftovers removed, including the nested one');
  assert.ok(!existsSync(path.join(dir, 'drills.json.123.4.tmp')));
  assert.ok(!existsSync(path.join(dir, 'users', 'kai', 'drills.json.5.1.tmp')));

  // Not a git repo: no .gitignore appears.
  await ensureDataIgnores();
  assert.ok(!existsSync(path.join(dir, '.gitignore')));

  // A data repo gets the local-only entries appended exactly once, and its
  // .git tree is never descended into (large, and not this sweep's business).
  mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
  writeFileSync(path.join(dir, '.git', 'objects', 'stray.tmp'), 'not json');
  await sweepTmpFiles();
  assert.ok(existsSync(path.join(dir, '.git', 'objects', 'stray.tmp')), '.git is never swept');
  writeFileSync(path.join(dir, '.gitignore'), 'drills.json\n');
  await ensureDataIgnores();
  await ensureDataIgnores();
  const ignore = readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.match(ignore, /drills\.json/, 'existing entries kept');
  assert.equal((ignore.match(/\*\.tmp/g) || []).length, 1);
  assert.match(ignore, /evalcache\.json/);
});
