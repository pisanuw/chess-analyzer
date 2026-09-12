import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempData } from './helpers.js';

process.env.DATA_DIR = tempData();
const { poolAnalyse, singleEnginePool, remoteCommand, sshEngine, remoteHostList, shouldIncludeLocal } = await import('../server/enginepool.js');
const { analyseGame } = await import('../server/analyze.js');
const { parsePgnFile } = await import('../server/pgn.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Fake engine: records which items it ran, optional per-call delay/failure. */
function fakeEngine(label, { delay = 0, failOn = () => false } = {}) {
  return {
    label, name: `Fake ${label}`, proc: true, ran: [],
    async analyse(fen) {
      await sleep(delay);
      if (failOn(fen)) throw new Error(`${label} died`);
      this.ran.push(fen);
      return { bestmove: 'e2e4', lines: [{ multipv: 1, depth: 18, cp: 30, mate: null, pv: ['e2e4', 'e7e5'] }] };
    },
    stop() { this.proc = null; },
  };
}

function makePool(engines) {
  const pool = singleEnginePool(engines[0]);
  pool.engines = [...engines];
  pool.names = new Set(engines.map(e => e.name));
  return pool;
}

test('poolAnalyse: work is shared, every item completes exactly once', async () => {
  const a = fakeEngine('a', { delay: 5 });
  const b = fakeEngine('b', { delay: 1 });
  const pool = makePool([a, b]);
  const items = [...Array(20).keys()];
  const done = [];
  await poolAnalyse(pool, items, (e, i) => e.analyse(`fen${i}`), async i => { done.push(i); });
  assert.deepEqual([...done].sort((x, y) => x - y), items);
  assert.ok(a.ran.length > 0 && b.ran.length > 0, 'both engines did work');
  assert.ok(b.ran.length > a.ran.length, 'the faster engine took more items');
});

test('poolAnalyse: a dying engine re-queues its item on the survivors', async () => {
  const bad = fakeEngine('bad', { failOn: () => true });
  const good = fakeEngine('good', { delay: 2 });
  const pool = makePool([bad, good]);
  const done = [];
  await poolAnalyse(pool, [0, 1, 2, 3], (e, i) => e.analyse(`fen${i}`), async i => { done.push(i); });
  assert.deepEqual([...done].sort(), [0, 1, 2, 3]);
  assert.equal(pool.engines.length, 1, 'the dead engine left the pool');
  assert.equal(pool.engines[0].label, 'good');
  assert.equal(bad.proc, null, 'the dead engine was stopped');
});

test('poolAnalyse: item stranded by a late engine death is picked up in a second round', async () => {
  // good finishes the whole queue while bad is still busy dying on its only
  // item; that item must not be lost when bad returns it after the others exit.
  const bad = fakeEngine('bad', { delay: 30, failOn: () => true });
  const good = fakeEngine('good', { delay: 1 });
  const pool = makePool([bad, good]);
  const done = [];
  await poolAnalyse(pool, [0, 1, 2], (e, i) => e.analyse(`fen${i}`), async i => { done.push(i); });
  assert.deepEqual([...done].sort(), [0, 1, 2]);
});

test('poolAnalyse: throws when every engine has failed with work left', async () => {
  const pool = makePool([fakeEngine('a', { failOn: () => true }), fakeEngine('b', { failOn: () => true })]);
  await assert.rejects(
    poolAnalyse(pool, [0, 1, 2], (e, i) => e.analyse(`fen${i}`)),
    /all engines failed/);
});

test('poolAnalyse: respawns a last-resort engine before giving up', async () => {
  const dead = fakeEngine('dead', { failOn: () => true });
  const pool = makePool([dead]);
  const fresh = fakeEngine('fresh');
  pool.respawn = async () => fresh; // the fresh local engine getEnginePool would supply
  const done = [];
  await poolAnalyse(pool, [0, 1, 2], (e, i) => e.analyse(`fen${i}`), async i => { done.push(i); });
  assert.deepEqual([...done].sort((a, b) => a - b), [0, 1, 2]);
  assert.equal(fresh.ran.length, 3, 'the respawned engine finished the queue');
});

test('poolAnalyse: an onDone error (cancellation) stops dispatch and propagates', async () => {
  const a = fakeEngine('a', { delay: 1 });
  const pool = makePool([a]);
  let count = 0;
  await assert.rejects(
    poolAnalyse(pool, [0, 1, 2, 3], (e, i) => e.analyse(`fen${i}`), async () => { if (++count === 2) throw new Error('cancelled'); }),
    /cancelled/);
  assert.ok(a.ran.length <= 3, 'dispatch stopped after the cancellation');
});

test('analyseGame accepts a bare engine and a multi-engine pool with identical results', async () => {
  const pgn = `[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0`;
  const game = { ...(await parsePgnFile(pgn))[0].game, playerColor: 'white' };
  const settings = { engineDepth: 10, engineMultiPv: 1, momentThreshold: 12 };
  const single = await analyseGame(fakeEngine('solo'), game, settings, null);
  const pooled = await analyseGame(makePool([fakeEngine('x', { delay: 2 }), fakeEngine('y')]), game, settings, null);
  assert.equal(single.moves.length, 6);
  assert.equal(pooled.moves.length, 6);
  // Fake evals are constant, so every derived number must match between runs.
  assert.deepEqual(
    pooled.moves.map(m => [m.ply, m.evalBefore, m.evalAfter, m.judgment]),
    single.moves.map(m => [m.ply, m.evalBefore, m.evalAfter, m.judgment]));
  assert.equal(pooled.summary.pool, 2);
  assert.equal(single.summary.pool, undefined);
});

test('analyseGame reports progress as completed positions and honours cancellation', async () => {
  const pgn = `[White "A"]\n[Black "B"]\n\n1. d4 d5 2. c4 e6 3. Nc3 Nf6 *`;
  const game = { ...(await parsePgnFile(pgn))[0].game, playerColor: 'white' };
  const settings = { engineDepth: 10, engineMultiPv: 1 };
  const seen = [];
  await analyseGame(makePool([fakeEngine('p'), fakeEngine('q')]), game, settings, (done, total, depth) => {
    if (depth === undefined) seen.push([done, total]);
  });
  assert.equal(seen[seen.length - 1][0], seen[seen.length - 1][1], 'ends at total');
  await assert.rejects(
    analyseGame(makePool([fakeEngine('r')]), game, settings, done => { if (done > 2) throw new Error('cancelled'); }),
    /cancelled/);
});

/** Fake engine that returns no score lines on the first search of each FEN
 * (a dropped-info-lines transport blip), then real lines on the retry; or no
 * lines ever when alwaysEmpty. */
function droppyEngine(label, { alwaysEmpty = false } = {}) {
  const seen = new Map();
  return {
    label, name: `Fake ${label}`, proc: true,
    async analyse(fen) {
      const n = (seen.get(fen) || 0) + 1; seen.set(fen, n);
      if (alwaysEmpty || n === 1) return { bestmove: 'e2e4', lines: [] };
      return { bestmove: 'e2e4', lines: [{ multipv: 1, depth: 18, cp: 20, mate: null, pv: ['e2e4', 'e7e5'] }] };
    },
    stop() { this.proc = null; },
  };
}

test('analyseGame retries once when the engine returns no score lines, never storing cp 0', async () => {
  const pgn = `[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0`;
  const game = { ...(await parsePgnFile(pgn))[0].game, playerColor: 'white' };
  const { moves } = await analyseGame(droppyEngine('flaky'), game, { engineDepth: 10, engineMultiPv: 1, momentThreshold: 12 }, null);
  assert.equal(moves.length, 6);
  // The retry supplied cp 20 (which becomes +/-20 in White's perspective per
  // side to move); the bug would have stored a fabricated 0.00 everywhere.
  assert.ok(moves.every(m => Math.abs(m.evalBefore) === 20 && Math.abs(m.evalAfter) === 20), 'retried evals used, no phantom cp 0');
});

test('analyseGame fails loudly when a position yields no evaluation even on retry', async () => {
  const pgn = `[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0`;
  const game = { ...(await parsePgnFile(pgn))[0].game, playerColor: 'white' };
  await assert.rejects(
    analyseGame(droppyEngine('dead', { alwaysEmpty: true }), game, { engineDepth: 10, engineMultiPv: 1 }, null),
    /no evaluation/);
});

test('remote command falls back to a binary inside the directory; ssh engine is labelled by host', () => {
  assert.match(remoteCommand('~/stockfish'), /nice -n 19/);
  assert.match(remoteCommand('~/stockfish'), /\$0\/stockfish/);
  assert.match(remoteCommand('~/stockfish'), /stockfish\*/); // finds stockfish-linux-x86-64-universal and the like
  assert.match(remoteCommand(), /~\/stockfish/); // default path when unset
  const e = sshEngine('csslab9.uwb.edu', { remoteThreads: 4 });
  assert.equal(e.path, 'ssh');
  assert.equal(e.label, 'csslab9.uwb.edu');
  assert.equal(e.args[e.args.length - 2], 'csslab9.uwb.edu');
  assert.match(e.args[e.args.length - 1], /stockfish/);
  assert.ok(e.args.includes('BatchMode=yes'));
});

test('remoteHostList trims and drops blanks', () => {
  assert.deepEqual(remoteHostList({ remoteHosts: [' a.edu ', '', 'b.edu'] }), ['a.edu', 'b.edu']);
  assert.deepEqual(remoteHostList({}), []);
});

test('shouldIncludeLocal: local joins by default, is excluded on request, rejoins when no remote is up', () => {
  assert.equal(shouldIncludeLocal({}, 5), true, 'default: local joins');
  assert.equal(shouldIncludeLocal({ useLocalEngine: true }, 5), true);
  assert.equal(shouldIncludeLocal({ useLocalEngine: false }, 5), false, 'excluded when remotes are available');
  assert.equal(shouldIncludeLocal({ useLocalEngine: false }, 0), true, 'rejoins so analysis never stalls with no remote');
});
