import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Engine, findStockfish } from '../server/engine.js';

const FAKE_ENGINE = path.join(process.cwd(), 'test', 'fixtures', 'fake-stockfish.mjs');

// A fake UCI engine (test/fixtures/fake-stockfish.mjs), run as a real child
// process via node itself, so these exercise Engine's actual protocol
// handling (line parsing, command queueing, timeout, stop) rather than a
// hand-rolled stand-in of its public interface (that's what enginepool.test.js's
// fakeEngine() is, and it never touches this code at all).
function fakeEngine(extraArgs = []) {
  return new Engine(process.execPath, { args: [FAKE_ENGINE, ...extraArgs], threads: 1, hash: 16, label: 'fake' });
}

test('findStockfish resolves a configured path only if it exists, else falls through', () => {
  const missing = path.join(os.tmpdir(), 'not-a-real-stockfish-binary-xyz');
  assert.equal(findStockfish(missing), null);
  const real = path.join(os.tmpdir(), `fake-stockfish-exists-${process.pid}`);
  writeFileSync(real, '#!/bin/sh\necho ok\n');
  chmodSync(real, 0o755);
  try {
    assert.equal(findStockfish(real), real);
  } finally {
    rmSync(real, { force: true });
  }
  assert.ok(!existsSync(real));
});

test('Engine.start handshakes uci/isready and captures the engine name', async () => {
  const engine = fakeEngine();
  try {
    await engine.start(5000);
    assert.equal(engine.name, 'FakeSF 1.0');
    assert.ok(engine.proc, 'process stays running after the handshake');
  } finally {
    engine.stop();
  }
});

test('Engine.analyse parses multipv lines, keeps the deepest per line, and reports bestmove', async () => {
  const engine = fakeEngine();
  try {
    await engine.start(5000);
    const depths = [];
    const { bestmove, lines } = await engine.analyse('startpos', { depth: 2, multipv: 2, movetimeMs: 2000, onDepth: d => depths.push(d) });
    assert.equal(bestmove, 'e2e4', 'the ponder move is stripped');
    assert.deepEqual(lines.map(l => [l.multipv, l.cp, l.depth]), [[1, 20, 2], [2, 10, 2]], 'multipv 1 kept its deepest (later) score, sorted by multipv');
    assert.deepEqual(lines[0].pv, ['e2e4', 'e7e5', 'g1f3']);
    assert.deepEqual(depths, [1, 2], 'onDepth fired once per new depth on the principal line');
  } finally {
    engine.stop();
  }
});

test('Engine.analyse queues concurrent calls instead of interleaving them on the wire', async () => {
  const engine = fakeEngine();
  try {
    await engine.start(5000);
    // Both fire "at once"; if analyse() did not serialize through this.queue,
    // their position/go commands would interleave on the same stdin stream.
    const [a, b] = await Promise.all([
      engine.analyse('fen-a', { depth: 2, multipv: 1, movetimeMs: 2000 }),
      engine.analyse('fen-b', { depth: 2, multipv: 1, movetimeMs: 2000 }),
    ]);
    assert.equal(a.bestmove, 'e2e4');
    assert.equal(b.bestmove, 'e2e4');
  } finally {
    engine.stop();
  }
});

test('Engine.command times out on an unresponsive command and stop() kills the process', async () => {
  const engine = fakeEngine();
  try {
    await engine.start(5000);
    // 'hang' is not a UCI command the fake engine answers, on purpose.
    await assert.rejects(engine.command('hang', () => false, null, 150), /timeout/);
    assert.ok(engine.proc, 'a command timeout alone does not kill the process');
  } finally {
    engine.stop();
  }
  assert.equal(engine.proc, null, 'stop() clears the process');
  assert.throws(() => engine.send('quit'), /not running/);
});
