import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGame, splitPgn, parseClock, detectPlayerColor, parsePgnFile } from '../server/pgn.js';

const PGN = `[White "Pisan, Kai"]
[Black "Karpov, Anatoly"]
[Date "2026.01.15"]
[Result "1-0"]
[TimeControl "5400+30"]

1. e4 {[%clk 1:29:30]} e5 {[%clk 1:29:45]} 2. Nf3 {[%clk 1:28:02]} Nc6 1-0`;

test('parseGame extracts moves, headers, clocks, and a stable 12-hex id', () => {
  const g = parseGame(PGN);
  assert.equal(g.moves.length, 4);
  assert.equal(g.headers.White, 'Pisan, Kai');
  assert.equal(g.moves[0].san, 'e4');
  assert.equal(g.moves[0].uci, 'e2e4');
  assert.equal(g.moves[0].clock, 5370); // 1:29:30
  assert.equal(g.moves[2].clock, 5282);
  assert.equal(g.moves[3].clock, null);
  assert.match(g.id, /^[a-f0-9]{12}$/);
  assert.equal(parseGame(PGN).id, g.id); // deterministic
});

test('splitPgn separates multiple games', () => {
  const two = PGN + '\n\n' + PGN.replace('Kai', 'Ada');
  assert.equal(splitPgn(two).length, 2);
  assert.equal(parsePgnFile(two).length, 2);
});

test('parseClock handles H:MM:SS and rejects junk', () => {
  assert.equal(parseClock('[%clk 0:05:12]'), 312);
  assert.equal(parseClock('[%clk 1:00:00.9]'), 3600);
  assert.equal(parseClock('no clock here'), null);
  assert.equal(parseClock(null), null);
});

test('detectPlayerColor: substring match, case-insensitive, ambiguous is null', () => {
  const h = { White: 'Pisan, Kai', Black: 'Karpov, Anatoly' };
  assert.equal(detectPlayerColor(h, ['pisan']), 'white');
  assert.equal(detectPlayerColor(h, ['Karpov']), 'black');
  assert.equal(detectPlayerColor(h, ['nobody']), null);
  assert.equal(detectPlayerColor({ White: 'Pisan, Kai', Black: 'Pisan, Yusuf' }, ['Pisan']), null); // both match
  assert.equal(detectPlayerColor(h, []), null);
});
