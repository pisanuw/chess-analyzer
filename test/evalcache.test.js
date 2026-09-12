import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempData } from './helpers.js';

process.env.DATA_DIR = tempData();
const { analyseGame } = await import('../server/analyze.js');
const { parseGame } = await import('../server/pgn.js');
const { evalCacheKey, getCachedEval, putCachedEval } = await import('../server/evalcache.js');

function fakeEngine() {
  return {
    name: 'fake 1',
    calls: 0,
    async analyse(fen, opts) {
      this.calls++;
      return { bestmove: 'a2a3', lines: [{ multipv: 1, depth: opts.depth, cp: 10, mate: null, pv: ['a2a3'] }] };
    },
  };
}

test('opening evals are cached across games; a deeper entry serves a shallower request, never the reverse', async () => {
  const game = { ...parseGame('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6'), playerColor: 'white' };
  const settings = { engineDepth: 10, engineMultiPv: 1, momentThreshold: 12 };

  const e1 = fakeEngine();
  await analyseGame(e1, game, settings);
  assert.equal(e1.calls, 7, '6 positions before moves plus the final one');

  const e2 = fakeEngine();
  const { moves } = await analyseGame(e2, game, settings);
  assert.equal(e2.calls, 0, 'a re-analysis of the same opening is fully cached');
  assert.equal(moves.length, 6, 'cached results still produce full move annotations');

  const e3 = fakeEngine();
  await analyseGame(e3, game, { ...settings, engineDepth: 12 });
  assert.equal(e3.calls, 7, 'a deeper request is not served by shallower entries');

  const e4 = fakeEngine();
  await analyseGame(e4, game, { ...settings, engineDepth: 8 });
  assert.equal(e4.calls, 0, 'a shallower request is served by the deeper entries');

  const e5 = fakeEngine();
  await analyseGame(e5, game, { ...settings, engineMultiPv: 2 });
  assert.equal(e5.calls, 7, 'a different MultiPV is a different key');
});

test('a shallower search never overwrites a deeper cached entry', async () => {
  const key = evalCacheKey('fake 1', 3, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  await putCachedEval(key, { depth: 20, bestmove: 'e2e4', lines: [{ multipv: 1, cp: 30, pv: ['e2e4'] }] });
  await putCachedEval(key, { depth: 12, bestmove: 'd2d4', lines: [{ multipv: 1, cp: 20, pv: ['d2d4'] }] });
  assert.equal((await getCachedEval(key, 12)).bestmove, 'e2e4', 'the deeper entry stays');
  assert.equal(await getCachedEval(key, 22), null, 'deeper than stored: a miss');
  assert.equal(evalCacheKey('sf', 3, 'a/b w - - 5 9'), 'sf|3|a/b w - -', 'the move counters are dropped from the key');
});
