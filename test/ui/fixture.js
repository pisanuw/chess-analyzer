// Seed a temp DATA_DIR with enough analysed games for every page to render:
// the primary member's own games (with moments, clocks, and a game against a
// scouted opponent), scout games of that opponent, a second member's game, and
// an upcoming game. Used by the browser smoke suite; no engine or model needed.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempData, makeGame, writeGame } from '../helpers.js';

export function seedFixture() {
  const dir = tempData();
  for (let i = 1; i <= 6; i++) {
    const g = makeGame({
      id: `f1f1f1f1f1${String(i).padStart(2, '0')}`, color: i % 2 ? 'white' : 'black',
      date: `2026.0${Math.min(9, i)}.1${i}`, timeControl: '5400+30',
      moments: i % 2 ? [{ ply: 1, loss: 25 }] : [{ ply: 2, loss: 32, phase: 'endgame' }],
      plies: 8, clocks: [5300, 5350, 5100, 5200, 4900, 5000, 4700, 4800],
      category: i % 3 ? 'calculation' : 'tactics-allowed', pattern: i % 2 ? 'Hanging piece after exchange' : 'Passive rook',
    });
    if (i === 3) g.headers.Black = 'Karpov, A';
    // makeGame puts the start position before every move; give Black's moves a
    // position with Black to move and Black engine lines, so a Black drill's
    // board is movable (mouse and typed) like a real one.
    for (const m of g.moves) {
      if (m.color !== 'black') continue;
      m.fenBefore = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
      m.san = 'd6'; m.uci = 'd7d6'; m.bestUci = 'e7e5'; m.bestSan = 'e5';
      m.lines = [{ multipv: 1, cp: 30, uci: 'e7e5', san: ['e5', 'Nf3', 'Nc6'] }, { multipv: 2, cp: 40, uci: 'c7c5', san: ['c5'] }];
    }
    writeGame(dir, g);
  }
  writeGame(dir, makeGame({ id: 'f2f2f2f2f201', purpose: 'scout', subject: 'Karpov, A', moments: [{ ply: 1, loss: 35 }], plies: 6, category: 'endgame-technique', pattern: 'Grabs pawns under attack' }));
  writeGame(dir, makeGame({ id: 'f2f2f2f2f202', purpose: 'scout', subject: 'Karpov, A', moments: [{ ply: 1, loss: 22 }], plies: 6, date: '2026.02.02', category: 'endgame-technique', pattern: 'Grabs pawns under attack' }));
  writeGame(dir, makeGame({ id: 'f3f3f3f3f301', owner: 'nikash', moments: [{ ply: 1, loss: 25 }] }));
  const kaiDir = path.join(dir, 'users', 'kai');
  mkdirSync(kaiDir, { recursive: true });
  writeFileSync(path.join(kaiDir, 'upcoming.json'), JSON.stringify([{ id: 'up1', subject: 'Karpov, A', fideId: null, color: 'black', date: '2026-12-01', timeControl: 'all', round: '3', createdAt: '2026-09-01T00:00:00Z' }]));
  return dir;
}
