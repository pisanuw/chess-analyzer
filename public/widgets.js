// Small shared render helpers for numbers and cards that appear on more than one
// page (the Players dossier and the Prepare page).
import { esc } from './api.js';
import { fmtLine, lichessUrl } from './shared.js';

/** The reading panel for a generated prep sheet: a headline, a fixed-row profile
 * table (the same rows for every opponent), a numbered plan, an openings table,
 * and cue bullets, each with its evidence chips (hover for the fact, click to
 * open the game); an item that cites nothing is flagged. Sheets made before the
 * structured format are free text and fall back to legacyPrepBody. */
export function prepSheetBody(sheet) {
  const asList = v => Array.isArray(v) ? v : (v ? [v] : []);
  const isStructured = sheet.headline || sheet.profile || Array.isArray(sheet.openings);
  if (!isStructured) return legacyPrepBody(sheet);
  const p = sheet.profile || {};
  const rows = [
    ['Style', p.style], ['Strongest phase', p.strongest_phase], ['Weakest phase', p.weakest_phase],
    ['Main errors', p.main_errors], ['Time trouble', p.time_trouble],
  ].filter(([, v]) => v);
  const plan = asList(sheet.exploit_plan), openings = asList(sheet.openings), watch = asList(sheet.watch_fors);
  const ev = sheet.evidence || {};
  const chips = item => {
    if (typeof item === 'string') return '';
    const ids = item.evidence || [];
    if (!ids.length) return ' <span class="chip warn" title="The coach model cited no evidence for this: treat it as an opinion">unsupported</span>';
    return ' ' + ids.map(id => ev[id]
      ? (ev[id].link ? `<a class="chip ev" href="${esc(ev[id].link)}" title="${esc(ev[id].text)}">${esc(id)}</a>` : `<span class="chip ev" title="${esc(ev[id].text)}">${esc(id)}</span>`)
      : '').join('');
  };
  const text = (item, key) => esc(typeof item === 'string' ? item : item[key]);
  return `<div class="prep-sheet">
    ${sheet.headline ? `<p class="prep-headline">${esc(sheet.headline)}</p>` : ''}
    ${rows.length ? `<h3>Profile</h3><table class="prep-table"><tbody>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${plan.length ? `<h3>Game plan</h3><ol>${plan.map(s => `<li>${text(s, 'step')}${chips(s)}</li>`).join('')}</ol>` : ''}
    ${openings.length ? `<h3>Openings</h3><table class="prep-table"><thead><tr><th>When</th><th>You play</th><th>Why</th></tr></thead><tbody>${openings.map(o => `<tr><td>${esc(o.when)}</td><td>${esc(o.play)}</td><td>${esc(o.why)}${chips(o)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${watch.length ? `<h3>Watch for</h3><ul>${watch.map(w => `<li>${text(w, 'cue')}${chips(w)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

/** Older free-text sheets (overview / exploit_plan / openings_advice as prose). */
export function legacyPrepBody(sheet) {
  const watch = Array.isArray(sheet.watch_fors)
    ? `<ul>${sheet.watch_fors.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`
    : `<p>${esc(sheet.watch_fors)}</p>`;
  return `<div class="prep-sheet">
    <h3>Overview</h3><p>${esc(sheet.overview)}</p>
    <h3>Game plan</h3><p>${esc(sheet.exploit_plan)}</p>
    <h3>Openings</h3><p>${esc(sheet.openings_advice)}</p>
    <h3>Watch for</h3>${watch}
  </div>`;
}

/** Your own record against this opponent: the first thing a player wants to
 * see, above everything derived from the opponent's other games. */
export function headToHeadCard(h2h, open = true) {
  if (!h2h?.games?.length) return '';
  const r = h2h.record;
  const rows = h2h.games.slice(0, 10).map(g => `<tr>
    <td><a href="#/game/${g.gameId}">${esc(g.date || '?')}</a></td>
    <td><span class="chip ${g.color}">${g.color}</span></td>
    <td>${esc(g.result)}</td>
    <td>${esc(fmtLine(g.line))}${g.line.length ? ` <a href="${lichessUrl(g.line)}" target="_blank" rel="noopener" title="Open on lichess">↗</a>` : ''}${g.prediction ? ` <span class="chip" title="${esc(g.prediction.text)}">${g.prediction.leftAtPly ? `predicted to move ${Math.ceil(g.prediction.leftAtPly / 2)}` : 'off the predicted lines'}</span>` : ''}</td>
    <td class="num">${g.accuracy != null ? g.accuracy + '%' : '–'}</td>
    <td class="num">${g.moments ?? '–'}</td>
    <td><small class="muted">${esc(g.event || '')}</small></td>
  </tr>`).join('');
  return `<details class="acc"${open ? ' open' : ''}><summary><span class="acc-title">Head to head</span> <span class="muted" style="font-size:13px">${r.games} game${r.games === 1 ? '' : 's'}: ${r.wins}W ${r.draws}D ${r.losses}L${r.scorePct != null ? `, ${r.scorePct}%` : ''}</span></summary>
    <div class="acc-body">
      <table><thead><tr><th>Date</th><th>You</th><th>Result</th><th>Opening</th><th class="num">Accuracy</th><th class="num">Moments</th><th>Event</th></tr></thead><tbody>${rows}</tbody></table>
      ${h2h.games.length > 10 ? `<p class="muted"><small>Showing the latest 10 of ${h2h.games.length}.</small></p>` : ''}
    </div></details>`;
}

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
