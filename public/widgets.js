// Small shared render helpers for numbers that appear on more than one page.
import { esc } from './api.js';

const pc = v => (v == null ? '–' : v + '%');
const tile = (v, l, title = '') => `<div class="tile"${title ? ` title="${esc(title)}"` : ''}><div class="v">${v}</div><div class="l">${l}</div></div>`;

/** Conversion, defence, swings, and where the eval turns, from the stored
 * win-probability curves (report.tendencies). Counts sit beside every rate. */
export function tendencyTiles(t) {
  if (!t?.games) return '';
  const turn = Object.entries(t.turnPhase || {}).filter(([k]) => k !== 'none').sort((a, b) => b[1] - a[1])[0];
  return `<div class="tiles">
    ${tile(pc(t.conversion.rate), `Converted winning positions (${t.conversion.won} of ${t.conversion.reached})`, 'Games that reached 75% win probability and were won')}
    ${tile(pc(t.hold.rate), `Saved lost positions (${t.hold.saved} of ${t.hold.reached})`, 'Games that fell to 25% win probability and were not lost')}
    ${tile(`${t.collapses} / ${t.comebacks}`, 'Collapses / comebacks', 'Swings of 40 win-probability points within 10 plies')}
    ${tile(turn && turn[1] ? turn[0] : '–', 'Where the eval usually turns', 'The phase in which the evaluation first left the balanced band')}
    ${tile(pc(t.drawRate), 'Draw rate')}
    ${tile(t.avgMoves ?? '–', 'Average game length (moves)')}
  </div>
  <p class="muted" style="margin:6px 0 0"><small>From the engine curves of ${t.games} analysed game${t.games === 1 ? '' : 's'}: no labels involved, so these are the real conversion and defence numbers.</small></p>`;
}

/** Structure habits harvested from an opponent's whole book (book features):
 * form, rating-gap and in-book scores, draws, castling, queen trades, captures. */
export function habitTiles(f) {
  if (!f?.games) return '';
  const castle = c => { const n = c.short + c.long + c.none; return n ? `${Math.round((c.short / n) * 100)}% short, ${Math.round((c.long / n) * 100)}% long` : '–'; };
  return `<div class="tiles">
    ${tile(pc(f.form.scorePct), `Form: last ${f.form.games} games`, `${f.form.recentGames} games in the last ${f.form.days} days`)}
    ${tile(`${pc(f.vsHigher.scorePct)} / ${pc(f.vsLower.scorePct)}`, `Score vs higher / lower rated (${f.vsHigher.games} / ${f.vsLower.games} games)`, 'At least 50 Elo above or below them')}
    ${tile(`${pc(f.inBook.scorePct)} / ${pc(f.outOfBook.scorePct)}`, `In their main lines / out of them (${f.inBook.games} / ${f.outOfBook.games} games)`, 'Main lines: their three most common positions after 8 plies, per colour')}
    ${tile(`${pc(f.drawRate.white)} / ${pc(f.drawRate.black)}`, 'Draw rate as White / Black')}
    ${tile(f.avgMoves ?? '–', 'Average game length (moves)')}
    ${tile(castle(f.castling.white), 'Castling as White')}
    ${tile(castle(f.castling.black), 'Castling as Black')}
    ${tile(pc(f.oppositeCastlingPct), 'Opposite-side castling')}
    ${tile(pc(f.queenTrade.pct), `Queens traded${f.queenTrade.medianMove ? `, typically by move ${f.queenTrade.medianMove}` : ''}`)}
    ${tile(f.firstCaptureMedianMove ?? '–', 'First capture (median move)')}
  </div>
  <p class="muted" style="margin:6px 0 0"><small>From the game records of ${f.games} games in the recency window, no engine: every rate carries its game count.</small></p>`;
}
