import { test } from 'node:test';
import assert from 'node:assert/strict';
import { winProb, formatEval, parseTimeControl, spentPerMove, WP_ACCEPT } from '../public/shared.js';

test('formatEval renders pawns, mates, and null', () => {
  assert.equal(formatEval(42), '+0.42');
  assert.equal(formatEval(-110), '-1.10');
  assert.equal(formatEval(0), '+0.00');
  assert.equal(formatEval(9997), '#3');
  assert.equal(formatEval(-9997), '#-3');
  assert.equal(formatEval(null), '');
});

test('winProb and WP_ACCEPT are the single shared definitions', () => {
  assert.equal(winProb(0), 50);
  assert.ok(winProb(100) > 50 && winProb(-100) < 50);
  assert.equal(WP_ACCEPT, 3);
});

test('spentPerMove derives think time from clocks and the time control', () => {
  const mv = (color, clock) => ({ color, clock });
  // 600+5: White spends 600-550+5=55s, Black 600-580+5=25s, then White 550-500+5=55s.
  const spents = spentPerMove([mv('white', 550), mv('black', 580), mv('white', 500)], '600+5');
  assert.deepEqual(spents, [55, 25, 55]);
  // No TimeControl header: the first clocked move per colour has no baseline.
  const noTc = spentPerMove([mv('white', 550), mv('black', 580), mv('white', 500)], null);
  assert.deepEqual(noTc, [null, null, 50]);
  // Missing clocks stay null and do not corrupt the running baseline.
  const gaps = spentPerMove([mv('white', 550), mv('black', null), mv('white', 500)], '600');
  assert.deepEqual(gaps, [50, null, 50]);
  assert.equal(parseTimeControl('40/7200'), null, 'multi-stage controls are not parsed');
});
