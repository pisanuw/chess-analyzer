import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memo, clearMemo, memoStats } from '../server/memo.js';

test.beforeEach(() => clearMemo());

test('memo computes once per key and serves the cached value after', async () => {
  let calls = 0;
  const compute = async () => { calls++; return 'v' + calls; };
  assert.equal(await memo('report', 'k1', compute), 'v1');
  assert.equal(await memo('report', 'k1', compute), 'v1', 'second call: cached, compute not called again');
  assert.equal(calls, 1);
  assert.equal(await memo('report', 'k2', compute), 'v2', 'a different key computes fresh');
  assert.equal(calls, 2);
});

test('namespaces are independent: the same key in two names never collides', async () => {
  await memo('report', 'k', () => 'report-value');
  await memo('repertoire', 'k', () => 'repertoire-value');
  assert.equal(await memo('report', 'k', () => 'stale'), 'report-value');
  assert.equal(await memo('repertoire', 'k', () => 'stale'), 'repertoire-value');
});

test('LRU eviction: the least-recently-used key falls out first at max', async () => {
  for (const k of ['a', 'b', 'c']) await memo('ns', k, () => k, { max: 3 });
  assert.equal(memoStats().ns, 3);
  // Touch 'a' so 'b' becomes the least-recently-used, not 'a'.
  await memo('ns', 'a', () => 'stale-a');
  await memo('ns', 'd', () => 'd', { max: 3 }); // pushes size to 4, evicts the LRU
  assert.equal(memoStats().ns, 3);
  let bRecomputed = 0;
  assert.equal(await memo('ns', 'b', () => { bRecomputed++; return 'fresh-b'; }, { max: 3 }), 'fresh-b', 'b was evicted');
  assert.equal(bRecomputed, 1);
  let aRecomputed = 0;
  assert.equal(await memo('ns', 'a', () => { aRecomputed++; return 'stale-a2'; }, { max: 3 }), 'a', 'a survived: it was touched most recently before the eviction');
  assert.equal(aRecomputed, 0);
});

test('clearMemo(name) drops one namespace; clearMemo() drops all', async () => {
  await memo('report', 'k', () => 'r');
  await memo('repertoire', 'k', () => 'p');
  clearMemo('report');
  assert.deepEqual(memoStats(), { repertoire: 1 });
  let recomputed = false;
  assert.equal(await memo('report', 'k', () => { recomputed = true; return 'r2'; }), 'r2');
  assert.ok(recomputed, "report's cache is gone after clearMemo('report')");
  clearMemo();
  assert.deepEqual(memoStats(), {});
});
