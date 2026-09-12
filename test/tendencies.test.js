import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curveTendencies, curveFor } from '../server/tendencies.js';
import { classifyTimeControl } from '../public/shared.js';

// A game from a win-probability series (from the player's side, one value per
// ply), alternating colours from White, all moves in one phase unless given.
function gameFromCurve(playerColor, wps, result, phases = null) {
  const moves = wps.map((wp, i) => {
    const color = i % 2 === 0 ? 'white' : 'black';
    return { ply: i + 1, color, wpAfter: color === playerColor ? wp : 100 - wp, phase: phases?.[i] || 'middlegame' };
  });
  return { playerColor, headers: { Result: result }, analysis: { moves } };
}

test('curveFor reads the stored mover-perspective wpAfter from one side', () => {
  const g = gameFromCurve('white', [60, 55, 70], '1-0');
  assert.deepEqual(curveFor(g.analysis.moves, 'white'), [60, 55, 70]);
  assert.deepEqual(curveFor(g.analysis.moves, 'black'), [40, 45, 30]);
});

test('conversion and hold rates, collapses and comebacks, and where the eval turns', () => {
  const games = [
    // Reached 80 and won: converted. Turned in the opening (ply 2 is opening).
    gameFromCurve('white', [55, 80, 85, 90], '1-0', ['opening', 'opening', 'middlegame', 'middlegame']),
    // Reached 80 then collapsed to 20 within 10 plies and lost: a collapse, not converted.
    gameFromCurve('white', [50, 78, 60, 40, 20, 15], '0-1'),
    // Fell to 20, came back to 75 and drew: a comeback, and a held position.
    gameFromCurve('black', [50, 20, 30, 50, 75, 60], '1/2-1/2'),
    // Balanced draw: nothing reached, no turn.
    gameFromCurve('white', [50, 52, 48, 50], '1/2-1/2'),
  ];
  const t = curveTendencies(games);
  assert.equal(t.games, 4);
  assert.equal(t.conversion.reached, 3, 'the comeback game also touched 75');
  assert.equal(t.conversion.won, 1);
  assert.equal(t.conversion.rate, 33);
  assert.equal(t.hold.reached, 2, 'the collapse and the comeback games were both lost at some point');
  assert.equal(t.hold.saved, 1, 'only the comeback game was saved');
  assert.equal(t.hold.rate, 50);
  assert.equal(t.collapses, 1);
  assert.equal(t.comebacks, 1);
  assert.equal(t.turnPhase.opening, 1);
  assert.equal(t.turnPhase.middlegame, 2);
  assert.equal(t.turnPhase.none, 1);
  assert.equal(t.drawRate, 50);
  assert.equal(t.avgMoves, 3, 'plies 4, 6, 6, 4 average 5, about 3 moves');
});

test('games without analysis or colour are skipped; an empty set is all nulls', () => {
  const t = curveTendencies([{ playerColor: null, analysis: null }]);
  assert.equal(t.games, 0);
  assert.equal(t.conversion.rate, null);
  assert.equal(t.avgMoves, null);
});

test('classifyTimeControl uses the header bands, then the event name', () => {
  assert.equal(classifyTimeControl('5400+30'), 'classical');
  assert.equal(classifyTimeControl('3600'), 'classical');
  assert.equal(classifyTimeControl('900+10'), 'rapid');
  assert.equal(classifyTimeControl('180+2'), 'blitz');
  assert.equal(classifyTimeControl('', 'City Rapid Open'), 'rapid');
  assert.equal(classifyTimeControl(undefined, 'Weekend Blitz'), 'blitz');
  assert.equal(classifyTimeControl(null, 'Spring Open'), 'unknown');
});
