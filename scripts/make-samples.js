// Generate sample games (weak Stockfish vs stronger Stockfish) with clock comments, for testing.
// Usage: node scripts/make-samples.js [count] > samples/sample-games.pgn
import { Chess } from 'chess.js';
import { Engine, findStockfish } from '../server/engine.js';

const count = Number(process.argv[2]) || 3;
const path = findStockfish(process.env.STOCKFISH_PATH);
if (!path) { console.error('stockfish not found'); process.exit(1); }

async function makePlayer(elo) {
  const e = await new Engine(path, { threads: 1, hash: 16 }).start();
  e.send('setoption name UCI_LimitStrength value true');
  e.send(`setoption name UCI_Elo value ${elo}`);
  await e.command('isready', l => l === 'readyok');
  return e;
}

function fmtClock(s) {
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const weak = await makePlayer(1700);
const strong = await makePlayer(2400);
const out = [];
for (let i = 0; i < count; i++) {
  const playerIsWhite = i % 2 === 0;
  const chess = new Chess();
  const clocks = { w: 5400, b: 5400 };
  const moves = [];
  while (!chess.isGameOver() && chess.history().length < 160) {
    const stm = chess.turn();
    const engine = (stm === 'w') === playerIsWhite ? weak : strong;
    const r = await engine.analyse(chess.fen(), { depth: 8, multipv: 1 });
    if (!r.bestmove) break;
    const mv = chess.move({ from: r.bestmove.slice(0, 2), to: r.bestmove.slice(2, 4), promotion: r.bestmove[4] });
    clocks[stm] -= 20 + Math.floor(Math.random() * 90);
    if (clocks[stm] < 0) clocks[stm] = 5;
    moves.push(`${stm === 'w' ? Math.ceil(chess.history().length / 2) + '. ' : ''}${mv.san} {[%clk ${fmtClock(clocks[stm])}]}`);
  }
  let result = '*';
  if (chess.isCheckmate()) result = chess.turn() === 'w' ? '0-1' : '1-0';
  else if (chess.isDraw()) result = '1/2-1/2';
  else result = '1/2-1/2';
  const white = playerIsWhite ? 'Pisan, Test' : `Opponent ${i + 1}`;
  const black = playerIsWhite ? `Opponent ${i + 1}` : 'Pisan, Test';
  out.push(`[Event "Sample Open"]
[Site "Seattle"]
[Date "2026.08.${String(10 + i).padStart(2, '0')}"]
[Round "${i + 1}"]
[White "${white}"]
[Black "${black}"]
[Result "${result}"]
[WhiteElo "${playerIsWhite ? 2000 : 2150}"]
[BlackElo "${playerIsWhite ? 2150 : 2000}"]
[TimeControl "5400+30"]

${moves.join(' ')} ${result}
`);
}
weak.stop(); strong.stop();
console.log(out.join('\n'));
