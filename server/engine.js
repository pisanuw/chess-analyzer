// Minimal UCI wrapper around a Stockfish binary. One process, one search at a time.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';

const CANDIDATE_PATHS = [
  process.env.STOCKFISH_PATH,
  '/opt/homebrew/bin/stockfish',
  '/usr/local/bin/stockfish',
  '/usr/bin/stockfish',
  '/usr/games/stockfish',
  'stockfish',
].filter(Boolean);

export function findStockfish(configured) {
  const candidates = configured ? [configured, ...CANDIDATE_PATHS] : CANDIDATE_PATHS;
  for (const p of candidates) {
    if (p === 'stockfish' || existsSync(p)) return p;
  }
  return null;
}

export class Engine {
  constructor(path, { threads, hash = 256 } = {}) {
    this.path = path;
    this.threads = threads || Math.max(1, os.cpus().length - 1);
    this.hash = hash;
    this.proc = null;
    this.buffer = '';
    this.listeners = [];
    this.queue = Promise.resolve();
    this.name = null;
  }

  async start() {
    this.proc = spawn(this.path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', chunk => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) for (const l of this.listeners) l(line);
      }
    });
    this.proc.on('exit', () => { this.proc = null; });
    await this.command('uci', line => line === 'uciok', line => {
      const m = line.match(/^id name (.+)$/);
      if (m) this.name = m[1];
    });
    this.send(`setoption name Threads value ${this.threads}`);
    this.send(`setoption name Hash value ${this.hash}`);
    await this.command('isready', line => line === 'readyok');
    return this;
  }

  send(cmd) {
    if (!this.proc) throw new Error('engine not running');
    this.proc.stdin.write(cmd + '\n');
  }

  /** Send a command and resolve when `done(line)` is true. Collects lines through `onLine`. */
  command(cmd, done, onLine, timeoutMs = 600000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`engine timeout on: ${cmd}`)); }, timeoutMs);
      const listener = line => {
        if (onLine) onLine(line);
        if (done(line)) { cleanup(); resolve(line); }
      };
      const cleanup = () => { clearTimeout(timer); this.listeners = this.listeners.filter(l => l !== listener); };
      this.listeners.push(listener);
      this.send(cmd);
    });
  }

  /**
   * Analyse one position. Returns { lines: [{ multipv, cp, mate, pv: [uci...] }], bestmove }.
   * Scores are from the side-to-move perspective (UCI convention).
   */
  analyse(fen, { depth = 18, multipv = 3, movetimeMs = 120000 } = {}) {
    const run = async () => {
      this.send(`setoption name MultiPV value ${multipv}`);
      this.send(`position fen ${fen}`);
      const lines = new Map();
      const onInfo = line => {
        if (!line.startsWith('info') || !line.includes(' pv ') || !line.includes(' score ')) return;
        const mpv = Number((line.match(/ multipv (\d+)/) || [])[1] || 1);
        const d = Number((line.match(/ depth (\d+)/) || [])[1] || 0);
        const cpM = line.match(/ score cp (-?\d+)/);
        const mateM = line.match(/ score mate (-?\d+)/);
        const pv = line.split(' pv ')[1].trim().split(/\s+/);
        const prev = lines.get(mpv);
        if (prev && prev.depth > d) return; // keep deepest
        lines.set(mpv, { multipv: mpv, depth: d, cp: cpM ? Number(cpM[1]) : null, mate: mateM ? Number(mateM[1]) : null, pv });
      };
      // movetime caps pathological positions where reaching the depth takes forever;
      // the command timeout is only a backstop for an unresponsive engine.
      let best;
      try {
        best = await this.command(`go depth ${depth} movetime ${movetimeMs}`, l => l.startsWith('bestmove'), onInfo, movetimeMs + 30000);
      } catch (err) {
        // Interrupt the search so the process is idle for the next position, and
        // salvage the depth reached so far. A search left running would swallow
        // the next job's commands and hand it this position's bestmove.
        try {
          best = await this.command('stop', l => l.startsWith('bestmove'), onInfo, 10000);
        } catch {
          this.stop(); // engine is unresponsive; next job spawns a fresh one
          throw err;
        }
      }
      const bestmove = best.split(/\s+/)[1];
      return { bestmove: bestmove === '(none)' ? null : bestmove, lines: [...lines.values()].sort((a, b) => a.multipv - b.multipv) };
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  stop() {
    if (this.proc) { try { this.send('quit'); } catch {} this.proc.kill(); this.proc = null; }
  }
}

let shared = null;
export async function getEngine(settings) {
  const path = findStockfish(settings.enginePath);
  if (!path) throw new Error('Stockfish not found. Install it (brew install stockfish) or set the engine path in Settings.');
  if (shared && shared.proc && shared.path === path && shared.threads === (settings.engineThreads || shared.threads)) return shared;
  if (shared) shared.stop();
  shared = await new Engine(path, { threads: settings.engineThreads, hash: settings.engineHash }).start();
  return shared;
}
