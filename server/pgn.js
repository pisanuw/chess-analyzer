// PGN parsing: split multi-game files, extract headers, moves, and clock comments.
import { Chess } from 'chess.js';
import { createHash } from 'node:crypto';

/** Split a PGN string containing one or more games into individual game strings. */
export function splitPgn(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const games = [];
  let current = [];
  let inMoves = false;
  for (const line of lines) {
    const isHeader = /^\s*\[[A-Za-z0-9_]+\s+"/.test(line);
    if (isHeader && inMoves) {
      games.push(current.join('\n'));
      current = [];
      inMoves = false;
    }
    if (!isHeader && line.trim() !== '') inMoves = true;
    current.push(line);
  }
  if (current.some(l => l.trim() !== '')) games.push(current.join('\n'));
  return games.filter(g => /\[\w+\s+"/.test(g) || /\d+\./.test(g));
}

/** Parse "[%clk 0:05:12]" style comments into seconds. */
export function parseClock(comment) {
  if (!comment) return null;
  const m = comment.match(/\[%clk\s+(\d+):(\d\d):(\d\d)(?:\.\d+)?\]/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// Shared with the frontend; re-exported so server modules keep importing it from here.
export { parseTimeControl } from '../public/shared.js';

/**
 * Parse a single PGN game into { headers, moves[], pgn, id }.
 * Each move: { ply, moveNumber, color, san, uci, fenBefore, fenAfter, clock }.
 */
export function parseGame(pgnText) {
  const chess = new Chess();
  chess.loadPgn(pgnText, { strict: false });
  const headers = chess.getHeaders ? chess.getHeaders() : chess.header();
  const comments = new Map(chess.getComments().map(c => [c.fen, c.comment]));
  const history = chess.history({ verbose: true });
  // Clocks in order of appearance: the FEN-keyed comment map miscounts when a
  // position repeats, so prefer positional matching when every move has a clock.
  const movetext = pgnText.replace(/^\s*\[[^\]]*\]\s*$/gm, '');
  const ordered = [...movetext.matchAll(/\[%clk\s+(\d+):(\d\d):(\d\d)(?:\.\d+)?\]/g)]
    .map(m => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
  const clockAt = i => (ordered.length === history.length ? ordered[i] : parseClock(comments.get(history[i].after)));
  const moves = history.map((m, i) => ({
    ply: i + 1,
    moveNumber: Math.floor(i / 2) + 1,
    color: m.color === 'w' ? 'white' : 'black',
    san: m.san,
    uci: m.from + m.to + (m.promotion || ''),
    fenBefore: m.before,
    fenAfter: m.after,
    clock: clockAt(i),
  }));
  const id = createHash('sha1')
    .update([headers.White, headers.Black, headers.Date, headers.Round, ...moves.map(m => m.san)].join('|'))
    .digest('hex')
    .slice(0, 12);
  return { id, headers: normalizeHeaders(headers), moves, pgn: pgnText.trim() };
}

function normalizeHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) if (v && v !== '?') out[k] = v;
  return out;
}

/** Decide which color the tracked player had, by matching configured names against White/Black headers. */
export function detectPlayerColor(headers, playerNames) {
  const names = (playerNames || []).map(n => n.trim().toLowerCase()).filter(Boolean);
  if (!names.length) return null;
  const white = (headers.White || '').toLowerCase();
  const black = (headers.Black || '').toLowerCase();
  const matches = s => names.some(n => s.includes(n));
  const w = matches(white), b = matches(black);
  if (w && !b) return 'white';
  if (b && !w) return 'black';
  return null;
}

/** Parse already-split game chunks (see splitPgn). Callers that want to bound
 * the game count split first, check the length, then parse only if under the
 * cap, so a huge paste is rejected before the synchronous parse runs. */
export function parsePgnGames(chunks) {
  const results = [];
  for (const g of chunks) {
    try {
      results.push({ ok: true, game: parseGame(g) });
    } catch (err) {
      results.push({ ok: false, error: err.message, snippet: g.slice(0, 200) });
    }
  }
  return results;
}

export function parsePgnFile(text) {
  return parsePgnGames(splitPgn(text));
}
