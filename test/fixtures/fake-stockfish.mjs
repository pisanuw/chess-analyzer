// A tiny stand-in for a UCI engine binary, so engine.test.js can exercise the
// real Engine class's protocol handling (line parsing, command queueing,
// timeout, stop) without depending on Stockfish being installed. Speaks just
// enough UCI to be useful: uci/isready handshake, a fabricated multi-line
// search reply to "go", an immediate "bestmove" on "stop", and "hang" (a
// custom, non-UCI command this engine deliberately never answers) to let a
// test drive Engine's own command timeout.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
let fen = null;

rl.on('line', line => {
  const cmd = line.trim();
  if (cmd === 'uci') {
    console.log('id name FakeSF 1.0');
    console.log('uciok');
  } else if (cmd === 'isready') {
    console.log('readyok');
  } else if (cmd.startsWith('position fen ')) {
    fen = cmd.slice('position fen '.length);
  } else if (cmd.startsWith('go ')) {
    void fen;
    // Two depths so a test can assert the deepest one wins per multipv.
    console.log('info depth 1 seldepth 1 multipv 1 score cp 15 nodes 100 pv e2e4 e7e5');
    console.log('info depth 2 seldepth 2 multipv 1 score cp 20 nodes 200 pv e2e4 e7e5 g1f3');
    console.log('info depth 2 seldepth 2 multipv 2 score cp 10 nodes 200 pv d2d4 d7d5');
    console.log('bestmove e2e4 ponder e7e5');
  } else if (cmd === 'stop') {
    console.log('bestmove e2e4');
  } else if (cmd === 'quit') {
    process.exit(0);
  }
  // 'hang' and any setoption/other command: no reply, on purpose.
});
