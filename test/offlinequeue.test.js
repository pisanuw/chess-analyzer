// The offline review queue in public/api.js: grades made with no connection
// are stored per user and replayed in order on reconnect. Run under node with
// minimal browser stand-ins; each outcome in `script` drives one fetch call.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
// A 401 makes req() fire showLogin(), which probes the DOM; a truthy element
// makes it return immediately.
globalThis.document = { getElementById: () => ({}) };

let calls = [];  // every fetch attempt: { url, body }
let script = []; // outcome per call: 'ok' | 'offline' | an HTTP status; empty = ok
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url, body: opts.body ? JSON.parse(opts.body) : undefined });
  const outcome = script.length ? script.shift() : 'ok';
  if (outcome === 'offline') throw new TypeError('fetch failed');
  if (outcome !== 'ok') return { ok: false, status: outcome, json: async () => ({ error: 'nope' }) };
  return { ok: true, status: 200, json: async () => ({ drill: { id: 'stub' } }) };
};

const { api, session, flushReviews } = await import('../public/api.js');
session.user = { id: 'kai', role: 'member' };

const queue = (user = 'kai') => JSON.parse(store.get(`reviewQueue:${user}`) || '[]');

test('a grade made offline is queued with its review time, not thrown', async () => {
  script = ['offline'];
  const res = await api.reviewDrill('g1:1', 'good', true, false, 1200, { confidence: 'sure' });
  assert.equal(res.queued, true);
  const q = queue();
  assert.equal(q.length, 1);
  assert.equal(q[0].id, 'g1:1');
  assert.equal(q[0].grade, 'good');
  assert.equal(q[0].ms, 1200);
  assert.equal(q[0].confidence, 'sure');
  assert.ok(Date.parse(q[0].at) <= Date.now(), 'carries the real review time');
});

test('a second offline grade probes the head once, then joins the back', async () => {
  calls = [];
  script = ['offline'];
  await api.reviewDrill('g2:1', 'again', false, false, null, {});
  assert.equal(calls.length, 1, 'only the queued head is probed; the new grade gets no doomed request');
  assert.deepEqual(queue().map(e => e.id), ['g1:1', 'g2:1']);
});

test('replay is oldest first; an entry the server refuses is dropped, not jammed', async () => {
  calls = [];
  const at = queue()[1].at;
  script = [404]; // g1's drill was deleted while offline; g2 then succeeds
  const { synced, pending } = await flushReviews();
  assert.equal(synced, 1);
  assert.equal(pending, 0);
  assert.deepEqual(calls.map(c => c.url), ['/api/drills/g1%3A1/review', '/api/drills/g2%3A1/review']);
  assert.equal(calls[1].body.at, at, 'the replayed body carries the queued review time');
  assert.equal(queue().length, 0);
});

test('a flush interrupted by more offline keeps the remainder in order', async () => {
  script = ['offline', 'offline'];
  await api.reviewDrill('g3:1', 'good', true, false, null, {});
  await api.reviewDrill('g4:1', 'good', true, false, null, {});
  script = ['ok', 'offline'];
  const { synced, pending } = await flushReviews();
  assert.equal(synced, 1);
  assert.equal(pending, 1);
  assert.deepEqual(queue().map(e => e.id), ['g4:1']);
});

test('an expired session stops the flush and keeps the queue', async () => {
  script = [401];
  const { synced, pending } = await flushReviews();
  assert.equal(synced, 0);
  assert.equal(pending, 1);
  assert.deepEqual(queue().map(e => e.id), ['g4:1']);
  script = [];
  assert.equal((await flushReviews()).pending, 0, 'signs back in, queue drains');
});

test('an online grade with an empty queue posts directly, nothing stored', async () => {
  calls = [];
  script = [];
  await api.reviewDrill('g5:1', 'easy', true, false, null, {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/drills/g5%3A1/review');
  assert.equal(calls[0].body.at, undefined, 'a live grade needs no backdating');
  assert.equal(queue().length, 0);
});

test('undo removes the newest queued review for that drill without a server call', async () => {
  // The same drill twice: missed offline, it comes back in the same session.
  script = ['offline', 'offline'];
  await api.reviewDrill('g6:1', 'again', false, false, null, {});
  await api.reviewDrill('g6:1', 'good', true, false, null, {});
  calls = [];
  await api.undoDrill('g6:1');
  assert.equal(calls.length, 0);
  assert.equal(queue().length, 1);
  assert.equal(queue()[0].grade, 'again', 'the newest of the two went, the older stayed');
  await api.undoDrill('g6:1');
  assert.equal(queue().length, 0);
  script = ['ok'];
  await api.undoDrill('g6:1'); // nothing queued: a normal server undo
  assert.equal(calls.at(-1).url, '/api/drills/g6%3A1/undo');
});

test('the queue is per user: one member cannot replay into another ladder', async () => {
  script = ['offline'];
  await api.reviewDrill('g7:1', 'good', true, false, null, {});
  assert.equal(queue('kai').length, 1);
  session.user = { id: 'nikash', role: 'member' };
  assert.equal((await flushReviews()).pending, 0, 'nikash sees no queue');
  script = ['offline'];
  await api.reviewDrill('g8:1', 'good', true, false, null, {});
  assert.deepEqual(queue('nikash').map(e => e.id), ['g8:1']);
  assert.deepEqual(queue('kai').map(e => e.id), ['g7:1'], 'kai queue untouched');
});
