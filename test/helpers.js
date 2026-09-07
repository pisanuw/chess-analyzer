// Shared fixtures. Each test file sets process.env.DATA_DIR to a temp dir
// BEFORE dynamically importing server modules (store.js reads it at import).
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function tempData() {
  const dir = mkdtempSync(path.join(tmpdir(), 'chess-analyzer-test-'));
  mkdirSync(path.join(dir, 'games'), { recursive: true });
  return dir;
}

export function writeGame(dataDir, game) {
  writeFileSync(path.join(dataDir, 'games', game.id + '.json'), JSON.stringify(game, null, 2));
}

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Minimal analysed game. Moment plies must be odd when color is white (player moves). */
export function makeGame({ id = 'aaaaaaaaaaaa', color = 'white', moments = [{ ply: 1, loss: 25 }], category = 'calculation', pattern = 'Test pattern', date = '2026.01.01', result = '1-0', clocks = null, timeControl = null, explained = true, plies = null } = {}) {
  const maxPly = plies ?? Math.max(2, ...moments.map(m => m.ply), 1);
  const moves = [];
  for (let ply = 1; ply <= maxPly; ply++) {
    const mom = moments.find(m => m.ply === ply);
    const mcolor = ply % 2 ? 'white' : 'black';
    moves.push({
      ply, moveNumber: Math.ceil(ply / 2), color: mcolor, san: 'e4', uci: 'e2e4',
      fenBefore: START, fenAfter: START,
      clock: clocks ? (clocks[ply - 1] ?? null) : null,
      evalBefore: 0, evalAfter: mom ? -100 : 0,
      loss: mom ? mom.loss : 0,
      cpLoss: mom ? mom.loss * 10 : 0,
      accuracy: mom ? 60 : 95,
      judgment: mom ? (mom.loss >= 30 ? 'blunder' : mom.loss >= 20 ? 'mistake' : 'inaccuracy') : 'best',
      phase: mom?.phase || 'middlegame',
      isPlayer: mcolor === color,
      bestUci: 'd2d4', bestSan: 'd4', playedRank: mom ? null : 1,
      lines: [
        { multipv: 1, cp: 50, uci: 'd2d4', san: ['d4', 'd5', 'c4'] },
        { multipv: 2, cp: 30, uci: 'g1f3', san: ['Nf3'] },
      ],
    });
  }
  const colorStats = { moves: 10, acpl: 20, accuracy: 90, inaccuracies: 0, mistakes: 1, blunders: 0, byPhase: {} };
  return {
    id,
    headers: {
      White: color === 'white' ? 'Kai Pisan' : 'Opponent',
      Black: color === 'black' ? 'Kai Pisan' : 'Opponent',
      Date: date, Result: result,
      ...(timeControl ? { TimeControl: timeControl } : {}),
    },
    moves, pgn: '', playerColor: color,
    status: explained ? 'explained' : 'analysed',
    importedAt: '2026-01-01T00:00:00.000Z',
    analysis: {
      moves,
      analysedAt: '2026-01-01T00:00:00.000Z',
      summary: { moments: moments.map(m => m.ply), player: color, white: { ...colorStats }, black: { ...colorStats } },
    },
    explanations: explained
      ? Object.fromEntries(moments.map(m => [m.ply, { pattern, category, time_pressure: false, explanation: 'why it fails', key_question: 'what is the threat', concept: 'concept' }]))
      : {},
  };
}
