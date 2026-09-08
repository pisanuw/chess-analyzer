import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempData } from './helpers.js';

process.env.DATA_DIR = tempData();
const { analyseGame } = await import('../server/analyze.js');
const { parseGame } = await import('../server/pgn.js');

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

test('opening evals are cached across games at matching engine settings', async () => {
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
  assert.equal(e3.calls, 7, 'a different depth does not reuse cached evals');
});
