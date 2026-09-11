// Scouting: a FIDE-keyed "book" dossier built instantly from an opponent's
// whole game history (recency/rating weighted), plus the deeper engine/LLM
// dossier for the recent subset once it has been analysed.
import { api, esc, toast, movePrefix, busy, formatEval } from '../api.js';
import { barChart, lineChart } from '../charts.js';
import { Board, walkSans } from '../board.js';
import { CATEGORY_LABEL } from './report.js';

const fmtLine = sans => sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}.` : '') + s).join(' ');
const lichess = sans => `https://lichess.org/analysis/pgn/${encodeURIComponent(fmtLine(sans))}`;
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export async function scoutView(root) {
  const { subjects } = await api.scoutSubjects();
  const { readonly } = await api.status().catch(() => ({}));
  // Federation for each linked opponent comes from the players map (the scout
  // subject list carries the id but not the federation).
  const { players = [] } = await api.players().catch(() => ({ players: [] }));
  const fedById = new Map(players.map(p => [p.fideId, p.federation]));
  subjects.forEach(s => { if (s.fideId) s.fed = fedById.get(s.fideId) || null; });
  if (!subjects.length) {
    root.innerHTML = `<h1>Scouting</h1><div class="empty">No opponents yet. Everyone you play appears here once your games are analysed. Import an opponent's games with "Scout an opponent"; a FIDE export (filename like <code>Name_FIDE12345_…​.pgn</code>) builds a full repertoire book from hundreds of their games at once.</div>`;
    return;
  }
  const current = decodeURIComponent(location.hash.split('/')[2] || '') || subjects[0].subject;
  root.innerHTML = `
    <div class="row" style="justify-content: space-between; align-items: baseline">
      <h1>Scouting</h1>
      <input type="search" id="subject-search" placeholder="Find opponent…" style="padding: 6px 10px; font-size: 14px">
    </div>
    <div class="row" id="subject-list" style="gap: 6px; flex-wrap: wrap; margin-bottom: 14px"></div>
    <div id="dossier"></div>`;
  const listEl = root.querySelector('#subject-list');
  const COLLAPSE_AT = 15;
  let showAll = false;
  // Prep-sheet readiness: green = a sheet exists and no newer games since; yellow
  // = a scout target (has a book, or once had a sheet) whose sheet is missing or
  // stale; blank = an incidental opponent with nothing to prep.
  const prepStatus = s => {
    const stale = s.prep && (s.analysed || 0) > (s.prep.games || 0);
    if (s.prep && !stale) return 'green';
    if ((s.bookGames || 0) > 0 || s.prep) return 'yellow';
    return '';
  };
  const btnHtml = s => {
    const n = s.bookGames || s.games;
    const st = prepStatus(s);
    const isCur = s.subject === current;
    const col = st === 'green' ? '70,196,106' : st === 'yellow' ? '224,180,0' : '';
    const style = col ? `border-left:4px solid rgb(${col})${isCur ? '' : `;background:rgba(${col},.14)`}` : '';
    const prepTip = st === 'green' ? '; prep sheet ready' : st === 'yellow' ? (s.prep ? '; prep sheet stale, regenerate' : '; prep sheet not generated') : '';
    const tip = (s.fideId ? `FIDE ${s.fideId}${s.fed ? ` (${s.fed})` : ''}, ${n} game${n === 1 ? '' : 's'}` : `no FIDE id, ${n} game${n === 1 ? '' : 's'}`) + prepTip + (s.member ? '; app member' : '');
    return `<button class="small${isCur ? ' primary' : ''}" data-subject="${esc(s.subject)}" style="${style}" title="${esc(tip)}">${esc(s.subject)}${s.fed ? ` <small class="muted">${esc(s.fed)}</small>` : ''} (${n})${s.bookGames ? ' \u{1F4D6}' : ''}${s.member ? ' \u{1F464}' : ''}</button>`;
  };
  const renderSubjects = q => {
    const needle = q.trim().toLowerCase();
    const matched = subjects.filter(s => !needle || s.subject.toLowerCase().includes(needle));
    if (!matched.length) { listEl.innerHTML = '<span class="muted">No opponents match.</span>'; return; }
    const collapsed = !needle && !showAll && matched.length > COLLAPSE_AT;
    const shown = collapsed ? matched.slice(0, COLLAPSE_AT) : matched;
    if (collapsed && !shown.some(s => s.subject === current)) { const cur = matched.find(s => s.subject === current); if (cur) shown.push(cur); }
    const toggle = collapsed ? `<button class="small" id="subj-more">Show all ${matched.length}</button>`
      : (!needle && matched.length > COLLAPSE_AT ? '<button class="small" id="subj-fewer">Show fewer</button>' : '');
    listEl.innerHTML = shown.map(btnHtml).join('') + toggle;
    listEl.querySelector('#subj-more')?.addEventListener('click', () => { showAll = true; renderSubjects(q); });
    listEl.querySelector('#subj-fewer')?.addEventListener('click', () => { showAll = false; renderSubjects(q); });
    listEl.querySelectorAll('button[data-subject]').forEach(b => b.onclick = () => { location.hash = `#/scout/${encodeURIComponent(b.dataset.subject)}`; });
  };
  renderSubjects('');
  root.querySelector('#subject-search').addEventListener('input', e => renderSubjects(e.target.value));
  const entry = subjects.find(s => s.subject === current) || { subject: current, fideId: null };
  // The clash board (created lazily) is the one Chessground instance on this page;
  // hold it so the router can tear it down on navigation and re-renders can too.
  const boardRef = { board: null };
  await renderDossier(root.querySelector('#dossier'), entry, readonly, boardRef);
  return { destroy() { boardRef.board?.destroy(); boardRef.board = null; } };
}

async function renderDossier(el, entry, readonly, boardRef = { board: null }) {
  boardRef.board?.destroy(); boardRef.board = null; // re-render replaces the DOM; drop the old board first
  const subject = entry.subject;
  // Book dossier (instant, whole history) and engine dossier (analysed subset)
  // are independent: a freshly imported opponent has a book but no engine data.
  // The games list drives the "still processing" / "stale" prep-sheet flags.
  const [book, data, gamesRes] = await Promise.all([
    entry.fideId ? api.scoutBook(entry.fideId).catch(() => null) : Promise.resolve(null),
    api.scout(subject).catch(() => null),
    api.games().catch(() => ({ games: [] })),
  ]);
  if (!book && !data) {
    el.innerHTML = `<div class="empty">Nothing to show yet for ${esc(subject)}. Their games may still be in the analysis queue.</div>`;
    return;
  }
  const pending = subjectGameStats(gamesRes.games, subject, entry.fideId);
  const linkable = !entry.fideId && !readonly;
  const refresh = () => renderDossier(el, entry, readonly, boardRef);
  // The prep sheet sits high: it must be generated here on the home machine, so
  // it should be the first thing you reach for on the page.
  // Each big section is a collapsible accordion so the page shows just the
  // headers. The prep sheet (the at-the-board summary) is open by default; the
  // rest start collapsed and render their charts/tree the first time they open
  // (a chart drawn inside a hidden section would size to zero width).
  const dossierAcc = data
    ? `<details class="acc" id="dossier-acc"><summary><span class="acc-title">Deep dossier</span> <span class="muted" style="font-size:13px">${data.report.games} analysed game${data.report.games === 1 ? '' : 's'}</span></summary><div class="acc-body" id="engine-dossier"></div></details>`
    : `<div id="engine-dossier">${book ? engineHint(book, readonly) : ''}</div>`;
  el.innerHTML = subjectHeader(entry)
    + (data ? prepSheetCard(subject, data.report, data.prepSheet, pending, readonly, data.prepSheetVersion) : '')
    + (linkable ? fideLinkCard(subject) : '')
    + (book ? bookSection(book.dossier, readonly, book.promote) : '')
    + (book ? clashCard() : '')
    + dossierAcc;

  if (data) wirePrep(el, subject, data.report, pending, refresh);
  if (linkable) wireFideLink(el, subject);
  if (book) {
    wirePromote(el, book.dossier, subject, book.promote, refresh);
    onFirstOpen(el.querySelector('#book-acc'), () => renderRatingTrend(el.querySelector('#elo-trend'), book.dossier.eloTrend));
    onFirstOpen(el.querySelector('#clash-card'), () => wireClash(el, entry.fideId, boardRef, readonly));
  }
  if (data) onFirstOpen(el.querySelector('#dossier-acc'), () => renderEngineDossier(el.querySelector('#engine-dossier'), data, subject, readonly));
}

/** Run `fn` the first time a <details> is opened (or now, if already open). Lets
 * a collapsed section defer rendering charts, the board, or the clash fetch. */
function onFirstOpen(details, fn) {
  if (!details) return;
  if (details.open) return void fn();
  const handler = () => { if (details.open) { details.removeEventListener('toggle', handler); fn(); } };
  details.addEventListener('toggle', handler);
}

/** Rating over time as a simple line graph. The y-range is padded around the
 * player's own min/max (elo, not 0), snapped to 50s, so the trend fills the
 * plot instead of hugging one edge. Hovering a point shows the game count. */
function renderRatingTrend(container, eloTrend) {
  if (!container || !eloTrend?.length) return;
  const points = eloTrend.map(e => ({ x: String(e.year), y: e.elo, sub: `${e.games} game${e.games === 1 ? '' : 's'}` }));
  const elos = eloTrend.map(e => e.elo);
  const lo = Math.min(...elos), hi = Math.max(...elos);
  const pad = Math.max(30, Math.round((hi - lo) * 0.15));
  const yMin = Math.floor((lo - pad) / 50) * 50;
  const yMax = Math.ceil((hi + pad) / 50) * 50;
  lineChart(container, points, { yMin, yMax, format: v => String(Math.round(v)) });
}

/** Games of this subject still moving through the pipeline (so the prep sheet
 * can warn it is being built from an incomplete set): scouted games plus the
 * player's own games against them. */
function subjectGameStats(games, subject, fideId) {
  const rel = (games || []).filter(g =>
    (g.purpose === 'scout' && (g.subject === subject || (fideId && g.subjectId === fideId)))
    || (g.purpose !== 'scout' && g.playerColor && (g.playerColor === 'white' ? g.black : g.white) === subject));
  return {
    total: rel.length,
    toAnalyse: rel.filter(g => g.status === 'imported' || g.status === 'analysing').length,
    toExplain: rel.filter(g => g.status === 'analysed' && (g.moments || 0) > (g.explained || 0)).length,
  };
}

/** The reading panel for a generated sheet. The sheet is read at the board, so
 * it is broken into a headline, a fixed-row profile table (same rows for every
 * opponent, so players compare at a glance), a numbered plan, an openings table,
 * and cue bullets, all in a calm high-legibility panel. Sheets made before the
 * structured format are free-text (overview / openings_advice), so fall back. */
function prepSheetBody(sheet) {
  const asList = v => Array.isArray(v) ? v : (v ? [v] : []);
  const isStructured = sheet.headline || sheet.profile || Array.isArray(sheet.openings);
  if (!isStructured) return legacyPrepBody(sheet);
  const p = sheet.profile || {};
  const rows = [
    ['Style', p.style], ['Strongest phase', p.strongest_phase], ['Weakest phase', p.weakest_phase],
    ['Main errors', p.main_errors], ['Time trouble', p.time_trouble],
  ].filter(([, v]) => v);
  const plan = asList(sheet.exploit_plan), openings = asList(sheet.openings), watch = asList(sheet.watch_fors);
  return `<div class="prep-sheet">
    ${sheet.headline ? `<p class="prep-headline">${esc(sheet.headline)}</p>` : ''}
    ${rows.length ? `<h3>Profile</h3><table class="prep-table"><tbody>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${plan.length ? `<h3>Game plan</h3><ol>${plan.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
    ${openings.length ? `<h3>Openings</h3><table class="prep-table"><thead><tr><th>When</th><th>You play</th><th>Why</th></tr></thead><tbody>${openings.map(o => `<tr><td>${esc(o.when)}</td><td>${esc(o.play)}</td><td>${esc(o.why)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${watch.length ? `<h3>Watch for</h3><ul>${watch.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

/** Older free-text sheets (overview / exploit_plan / openings_advice as prose). */
function legacyPrepBody(sheet) {
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

/** The prep sheet, surfaced high on the page because it must be generated on
 * the home machine (it uses the claude CLI). Flags a stale sheet (games analysed
 * since it was made) and warns when games are still being processed. */
function prepSheetCard(subject, report, prepSheet, pending, readonly, currentVersion) {
  const analysedNow = report.games;
  const staleN = prepSheet ? Math.max(0, analysedNow - (prepSheet.games || 0)) : 0;
  const pendingTotal = pending.toAnalyse + pending.toExplain;
  // The sheet's format/wording changed since it was made: worth regenerating
  // even with no new games. currentVersion is null on the mirror (no regen there).
  const outdated = !!(prepSheet && currentVersion && prepSheet.version !== currentVersion);
  const flag = staleN > 0 || outdated || (prepSheet && pendingTotal > 0);
  const badge = staleN ? `<span class="chip mistake">stale · ${staleN} new game${staleN === 1 ? '' : 's'}</span>`
    : outdated ? '<span class="chip cat">new format available</span>'
    : (prepSheet && pendingTotal ? '<span class="chip inaccuracy">more games coming</span>' : '');
  const pendingNote = pendingTotal
    ? `<p class="muted" style="margin:6px 0"><small>⏳ ${pendingTotal} of ${esc(subject)}'s game${pendingTotal === 1 ? ' is' : 's are'} still being processed (${pending.toAnalyse} to analyse, ${pending.toExplain} to explain). ${prepSheet ? 'Regenerate once they finish for the full picture.' : `The sheet will be built from the ${analysedNow} already analysed.`}</small></p>`
    : '';
  const meta = prepSheet ? `<p class="muted"><small>From ${prepSheet.games} game${prepSheet.games === 1 ? '' : 's'}, ${esc((prepSheet.createdAt || '').slice(0, 10))}.${staleN ? ` ${staleN} more analysed since.` : ''}</small></p>` : '';
  const body = prepSheet
    ? prepSheetBody(prepSheet) + meta
    : `<p class="muted">One page for the board: their weaknesses, the plan against them, and what to watch for. Built here on the home machine (uses the claude CLI), then published to the phone.</p>`;
  // Disabled only when regenerating would produce the same thing: no new games
  // AND the same format. New games or a format change re-enable it.
  const upToDate = prepSheet && staleN === 0 && !outdated;
  const regenLabel = staleN ? `Regenerate (${staleN} new)` : outdated ? 'Regenerate (new format)' : 'Regenerate';
  const button = readonly
    ? (prepSheet ? '' : '<p class="muted"><small>Prep sheets are generated on the home machine and published here.</small></p>')
    : `<button class="primary" id="gen-prep"${upToDate ? ' disabled title="No games analysed and no format change since this sheet was generated"' : ''}>${prepSheet ? regenLabel : 'Generate prep sheet (about a minute)'}</button>${upToDate && pendingTotal === 0 ? ' <small class="muted">Up to date with all analysed games.</small>' : ''}`;
  return `<details class="acc" open${flag ? ' style="border-color: var(--warning)"' : ''}>
    <summary><span class="acc-title">Preparation sheet</span>${badge}</summary>
    <div class="acc-body">${body}${pendingNote}${button}</div>
  </details>`;
}

function wirePrep(el, subject, report, pending, refresh) {
  const btn = el.querySelector('#gen-prep');
  if (!btn) return;
  const pendingTotal = pending.toAnalyse + pending.toExplain;
  btn.onclick = async () => {
    if (pendingTotal > 0 && !confirm(`Generate the prep sheet now from ${report.games} analysed game${report.games === 1 ? '' : 's'}? ${pendingTotal} of ${subject}'s game${pendingTotal === 1 ? ' is' : 's are'} still processing; you can regenerate after they finish.`)) return;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Generating… (about a minute)';
    try { await api.prepSheet(subject); toast('Prep sheet generated'); await refresh(); }
    catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = label; }
  };
}

/** Name, FIDE id (linked to the official profile), and federation, shown for
 * every opponent whether or not they have a book or analysed games. */
function subjectHeader(entry) {
  const id = entry.fideId;
  const idHtml = id
    ? `FIDE <a href="https://ratings.fide.com/profile/${esc(id)}" target="_blank" rel="noopener">${esc(id)}</a>${entry.fed ? ` · ${esc(entry.fed)}` : ''}`
    : '<span class="muted">no FIDE id linked</span>';
  const aliases = (entry.aliases || []).filter(a => a !== entry.subject);
  return `<div class="row" style="justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:8px">
      <h2 style="margin:0">${esc(entry.subject)}</h2>
      <div style="font-size:14px">${idHtml}</div>
    </div>${aliases.length ? `<p class="muted" style="margin:2px 0 10px"><small>also seen as: ${aliases.map(esc).join(', ')}</small></p>` : '<div style="margin-bottom:10px"></div>'}`;
}

/** Link a name-only opponent to their FIDE id via the official rating site. */
function fideLinkCard(subject) {
  return `<div class="card" id="fide-link" style="margin-bottom:16px; border-color: var(--warning)">
    <h3 style="margin-top:0">No FIDE id linked</h3>
    <p class="muted">Link ${esc(subject)} to a FIDE id so their games, your games against them, and any scouting book merge into one opponent. This is the only time the app queries FIDE (ratings.fide.com), and only on your click.</p>
    <div class="row" style="gap:6px">
      <input type="search" id="fide-q" value="${esc(subject)}" style="padding:6px 10px; min-width:220px; font-size:14px">
      <button class="small" id="fide-go">Search FIDE</button>
    </div>
    <div id="fide-results" style="margin-top:10px"></div>
  </div>`;
}

function wireFideLink(el, subject) {
  const go = el.querySelector('#fide-go');
  const out = el.querySelector('#fide-results');
  const run = async () => {
    const q = el.querySelector('#fide-q').value.trim();
    if (q.length < 2) return toast('Enter at least two characters', true);
    go.disabled = true; out.innerHTML = '<span class="muted">Searching FIDE…</span>';
    try {
      const { count, candidates } = await api.fideSearch(q);
      if (!candidates.length) { out.innerHTML = '<span class="muted">No matches on FIDE. Try the surname alone.</span>'; return; }
      out.innerHTML = `<p class="muted"><small>${count} match${count === 1 ? '' : 'es'}${count > candidates.length ? `, showing the first ${candidates.length}` : ''}. Pick the right player:</small></p>
        <table><thead><tr><th>Name</th><th>Title</th><th>Fed</th><th class="num">Std</th><th>FIDE id</th><th></th></tr></thead>
        <tbody>${candidates.map(c => `<tr>
          <td><b>${esc(c.name)}</b></td><td>${esc(c.title || '')}</td><td>${esc(c.federation || '')}</td>
          <td class="num">${c.rating ?? '–'}</td>
          <td><small class="muted">${esc(c.fideId)}</small> <a href="https://ratings.fide.com/profile/${esc(c.fideId)}" target="_blank" rel="noopener" title="Open FIDE profile">↗</a></td>
          <td><button class="small primary" data-id="${esc(c.fideId)}" data-name="${esc(c.name)}" data-fed="${esc(c.federation || '')}">Link</button></td>
        </tr>`).join('')}</tbody></table>`;
      out.querySelectorAll('button[data-id]').forEach(b => b.onclick = async () => {
        b.disabled = true;
        try {
          await api.linkPlayer({ fideId: b.dataset.id, name: subject, fideName: b.dataset.name, federation: b.dataset.fed });
          toast(`Linked ${subject} to FIDE ${b.dataset.id}`);
          location.reload(); // re-derive the subject list so the merge takes effect
        } catch (err) { toast(err.message, true); b.disabled = false; }
      });
    } catch (err) { out.innerHTML = `<span class="muted">FIDE search failed: ${esc(err.message)}</span>`; }
    finally { go.disabled = false; }
  };
  go.onclick = run;
  el.querySelector('#fide-q').addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
}

/** The book tier: what they play, weighted to recent, on-strength games. */
function bookSection(d, readonly, promote) {
  const cov = d.coverage;
  // Rating over time is a small line graph (filled in after insertion by
  // renderRatingTrend); a row of "year: elo" chips was hard to read as a trend.
  const trendBlock = d.eloTrend.length
    ? '<div id="elo-trend" class="chart" style="margin-top:4px"></div>'
    : '<p class="muted" style="margin:6px 0 0"><small>No ratings in the file.</small></p>';
  const repTable = color => {
    const rows = d.repertoire.filter(r => r.color === color);
    if (!rows.length) return `<div class="empty">No ${color} games in range.</div>`;
    return `<table><thead><tr><th class="num">Share</th><th>Main line</th><th>ECO</th><th class="num">Games</th><th class="num">Scores</th><th class="num">vs ~Elo</th><th>Last</th></tr></thead>
      <tbody>${rows.slice(0, 10).map(r => `<tr>
        <td class="num"><b>${r.share}%</b></td>
        <td>${esc(fmtLine(r.line))} <a href="${lichess(r.line)}" target="_blank" rel="noopener" title="Open on lichess">↗</a></td>
        <td>${esc(r.eco)}</td>
        <td class="num">${r.count}</td>
        <td class="num">${r.scorePct != null ? r.scorePct + '%' : '–'}</td>
        <td class="num">${r.avgOppElo ?? '–'}</td>
        <td><small>${esc(r.lastDate)}</small></td>
      </tr>`).join('')}</tbody></table>`;
  };
  return `
    <details class="acc" id="book-acc"><summary><span class="acc-title">Repertoire book</span> <span class="muted" style="font-size:13px">${d.total} games</span></summary>
    <div class="acc-body">
    <p class="muted">Repertoire book from ${d.total} games${d.dateRange ? ` (${esc(d.dateRange.from)} to ${esc(d.dateRange.to)})` : ''}. Weighted toward recent, on-strength games: ${cov.droppedOld} game${cov.droppedOld === 1 ? '' : 's'} older than ${cov.maxAgeYears} years and ${cov.droppedElo} more than ${cov.eloBand} Elo off their current strength are set aside, because they no longer describe the player you will face.</p>
    <div class="tiles">
      <div class="tile"><div class="v">${d.currentElo ?? '–'}</div><div class="l">Current strength</div></div>
      <div class="tile"><div class="v">${d.peakElo ?? '–'}</div><div class="l">Peak in file</div></div>
      <div class="tile"><div class="v">${d.results.white.recentScorePct ?? '–'}% / ${d.results.black.recentScorePct ?? '–'}%</div><div class="l">Recent score W / B</div></div>
      <div class="tile"><div class="v">${cov.analysing}</div><div class="l">Recent games to analyse</div></div>
    </div>
    <h3 style="margin:16px 0 0">Rating over time</h3>
    ${trendBlock}
    <div class="grid grid-2" style="margin-top: 16px">
      <div class="card"><h3 style="margin-top:0">As White <span class="muted">(${d.results.white.games} games, scores ${d.results.white.scorePct ?? '–'}% all-time)</span></h3>${repTable('white')}</div>
      <div class="card"><h3 style="margin-top:0">As Black <span class="muted">(${d.results.black.games} games, scores ${d.results.black.scorePct ?? '–'}% all-time)</span></h3>${repTable('black')}</div>
    </div>
    <div class="card" style="margin-top: 16px">
      <h3 style="margin-top:0">Deep preparation</h3>
      <p class="muted">Run Stockfish and the coach model on their ${cov.analysing} most recent, on-strength games to find where they go wrong: error types, clock behaviour, recurring weaknesses, and "punish" drills from the positions after their mistakes.</p>
      ${deepPrepAction(cov, readonly, promote)}
    </div>
    </div></details>`;
}

/** The promote control: a button only when there is something new to queue.
 * Once every recent game is imported or analysed, promoting would queue nothing
 * (the confusing "0 queued, N already present"), so show status instead. */
function deepPrepAction(cov, readonly, promote) {
  if (readonly) return '<p class="muted"><small>Analysis runs on the home machine, then publishes here.</small></p>';
  const pm = promote || { total: cov.analysing, present: 0, analysed: 0, queueable: cov.analysing };
  if (pm.queueable > 0) {
    const note = pm.present ? ` <span class="muted"><small>${pm.present} of ${pm.total} already imported.</small></span>` : '';
    return `<button class="primary" id="promote">Analyse ${pm.queueable} recent game${pm.queueable === 1 ? '' : 's'}</button> <span id="promote-note" class="muted"></span>${note}`;
  }
  const processing = pm.present - pm.analysed;
  const msg = pm.analysed >= pm.total
    ? `All ${pm.total} recent games are analysed. The dossier below is up to date.`
    : processing > 0
      ? `${pm.analysed} of ${pm.total} recent games analysed, ${processing} still processing.`
      : `Nothing new to analyse (${pm.present} of ${pm.total} recent games imported, ${pm.analysed} analysed).`;
  return `<p class="muted" style="margin:0"><small>${msg}</small></p>`;
}

function engineHint(book, readonly) {
  if (readonly) return '';
  return `<div class="card" style="margin-top:16px"><p class="muted">${book ? 'No games analysed yet. Use "Analyse recent games" above to build the error dossier and punish drills.' : 'Their mistakes, error types, and punish drills appear here once their games are analysed.'}</p></div>`;
}

function wirePromote(el, dossier, subject, promote, refresh) {
  const btn = el.querySelector('#promote');
  if (!btn) return;
  const label = btn.textContent;
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = 'Queuing…';
    try {
      const r = await api.promoteScout(dossier.fideId);
      toast(`${r.queued} of ${subject}'s recent games queued for analysis`);
      await refresh(); // re-renders with fresh promote status (now processing, so the button is gone)
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = label; }
  };
}

// --- opening clash: predicted lines vs the player's own openings ---------------

/** The card shell. The tree loads itself on open (indexes are pre-built at
 * startup, so this is normally instant); no button. */
function clashCard() {
  return `<details class="acc" id="clash-card">
    <summary><span class="acc-title">Opening clash: what they play against you</span></summary>
    <div class="acc-body" id="clash-body"><p class="muted">Loading opening clash…</p></div>
  </details>`;
}

function wireClash(el, fideId, boardRef, readonly) {
  const body = el.querySelector('#clash-body');
  if (!body || !fideId) return;
  loadClash(fideId, body, boardRef, { fideId, readonly });
}

async function loadClash(fideId, body, boardRef, ctx) {
  try {
    const r = await api.scoutClash(fideId);
    if (r.unavailable) return unavailableClash(body);
    if (r.building) return pollClash(fideId, body, boardRef, ctx);
    renderClashForest(r.clash, body, boardRef, ctx);
  } catch (err) { body.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
}

function unavailableClash(body) {
  body.innerHTML = '<div class="empty">The opening clash is prepared on the home machine; it will appear here after the next publish.</div>';
}

/** Poll the job queue while the opponent index builds, then render. */
async function pollClash(fideId, body, boardRef, ctx) {
  body.innerHTML = '<p class="muted">Building the clash tree (parsing the opponent’s games)…</p>';
  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const { jobs = [] } = await api.jobs().catch(() => ({ jobs: [] }));
    const job = jobs.find(j => j.gameId === 'clash:' + fideId && j.kind === 'clash');
    if (job && job.total) body.innerHTML = `<p class="muted">Building the clash tree: parsed ${job.progress} of ${job.total} games…</p>`;
    if (job && job.status === 'failed') { body.innerHTML = `<div class="empty">Could not build the clash tree: ${esc(job.error || 'unknown error')}</div>`; return; }
    if (!job || job.status === 'done' || job.status === 'cancelled') {
      const r = await api.scoutClash(fideId);
      if (r.building) continue; // re-queued; keep waiting
      if (r.unavailable) return unavailableClash(body);
      return renderClashForest(r.clash, body, boardRef, ctx);
    }
  }
  body.innerHTML = '<div class="empty">The clash build is taking longer than expected. Reload the page to check.</div>';
}

/** A per-node marker for where a prediction runs out (coverage, not just depth). */
function clashFlag(node) {
  if (node.transposesTo) return '<span class="chip" title="Same position reached by a move order already shown">transposes</span>';
  if (node.kaiPrepEnds) return '<span class="chip warn" title="You have no games continuing here: your prepared line ends">your line ends</span>';
  if (node.oppPrepEnds) return node.oppPrepEndsReason === 'nodata'
    ? '<span class="chip warn" title="This opponent has never reached this position">not faced</span>'
    : '<span class="chip warn" title="The opponent reached this but in too few games to trust a prediction">book thins out</span>';
  if (node.truncated) return '<span class="chip" title="Reached the depth limit; the line may continue">depth limit</span>';
  return '';
}

function clashEdgeStats(node, e) {
  if (node.mover === 'opponent') {
    const bits = [`${e.share}%`, `${e.count}g`];
    if (e.scorePct != null) bits.push(`scores ${e.scorePct}%`);
    if (e.avgOppElo) bits.push(`vs ~${e.avgOppElo}`);
    return `<small class="muted">${bits.join(' · ')}</small>`;
  }
  const bits = [`${e.count}g`];
  if (e.cp != null) bits.push(formatEval(e.cp));
  if (e.accuracy != null) bits.push(`${e.accuracy}%`);
  let s = `<small class="muted">${bits.join(' · ')}</small>`;
  if (e.deviation) s += ' <span class="chip warn" title="In your games this is where you left theory or lost ground">deviation</span>';
  return s;
}

/** Recursive nested list. Each edge is one move; its child holds the reply tree.
 * data-path carries the whole SAN line to this move (so the board and the move
 * list under it show the sequence played); data-orient flips to the player's side. */
function renderClashEdges(node, orient, path = []) {
  if (!node.edges.length) return '';
  return `<ul class="clash-tree">${node.edges.map(e => {
    const label = `${movePrefix({ moveNumber: Math.floor(node.ply / 2) + 1, color: node.side })} ${esc(e.san)}`;
    const who = node.mover === 'kai' ? 'Your move' : 'Their reply';
    const line = [...path, e.san];
    return `<li><span class="clash-move ${node.mover}" data-path="${esc(line.join(' '))}" data-orient="${orient}" title="${who}">${label}</span> ${clashEdgeStats(node, e)} ${clashFlag(e.child)}${clashLeafEngine(e.child, orient, line)}${renderClashEdges(e.child, orient, line)}</li>`;
  }).join('')}</ul>`;
}

/** Engine suggestion attached to a prep-end leaf (phase 3). For your-move leaves
 * it is what to play with no book to guide you; for opponent leaves it is the
 * likely engine move to expect. A move that transposes into a structure the
 * opponent scores badly in is flagged. `path` is the line up to the leaf. */
function clashLeafEngine(node, orient, path = []) {
  if (!node.engineBest) return '';
  const who = node.mover === 'kai' ? 'engine suggests' : 'likely engine reply';
  const lines = node.engineLines?.length ? node.engineLines : [node.engineBest];
  const items = lines.map(l => {
    const steer = l.oppScorePct != null
      ? ` <span class="chip warn" title="Transposes into a position they have reached ${l.oppCount} time${l.oppCount === 1 ? '' : 's'}, scoring ${l.oppScorePct}%">they score ${l.oppScorePct}% here (${l.oppCount}g)</span>`
      : '';
    return `<li><span class="clash-move engine" data-path="${esc([...path, l.san].join(' '))}" data-orient="${orient}">${esc(l.san)}</span> <small class="muted">${formatEval(l.cp)}</small>${steer}</li>`;
  }).join('');
  return `<div class="clash-engine"><small class="muted">${who}:</small><ul class="clash-tree">${items}</ul></div>`;
}

function renderClashForest(clash, container, boardRef = { board: null }, ctx = {}) {
  boardRef.board?.destroy(); boardRef.board = null; // a fresh build replaces the board div
  const forest = color => {
    const root = clash.forests[color];
    if (!root) return '';
    const n = clash.kaiColorCounts[color] || 0;
    const body = root.edges.length ? renderClashEdges(root, color) : '<div class="muted">Not enough of your games in this colour.</div>';
    return `<div class="card" style="margin-top:12px"><h3 style="margin-top:0">You as ${color} <span class="muted" style="font-size:13px">(${n} of your game${n === 1 ? '' : 's'})</span></h3>${body}</div>`;
  };
  // Home-machine controls: extend prep-end leaves with the engine (once), and an
  // optional coach narration of the key lines.
  const extendCtl = ctx.readonly
    ? ''
    : clash.engineExtended
      ? `<span class="muted"><small>Engine lines added at prep-end leaves.${clash.engineExtendTruncated ? ' Only the earliest leaves were extended.' : ''}</small></span>`
      : `<button class="small" id="clash-extend" title="Run Stockfish on the positions where a prediction runs out and show the best move">Extend prep-end leaves with engine</button>`;
  const narrateCtl = ctx.readonly
    ? ''
    : `<button class="small" id="clash-narrate" title="Ask the coach model for one grounded note per predicted line">${clash.narration ? 'Regenerate explanation' : 'Explain the key lines'}</button>`;
  container.innerHTML = `
    <p class="muted">Your openings (bold) crossed with ${esc(clash.name)}'s games, showing their most likely replies weighted toward recent, on-strength games. Percentages are how often they chose that reply; "Ng" is the game count behind it. Click any move to follow the line on the board. Badges: <span class="chip warn">not faced</span> they never reached the position, <span class="chip warn">book thins out</span> too few games to trust, <span class="chip warn">your line ends</span> you have no games continuing.</p>
    <div class="row" style="gap:10px;align-items:center;margin-bottom:6px">${extendCtl}${narrateCtl}</div>
    ${clashNarration(clash)}
    <div class="grid grid-2">
      <div class="clash-board-col">
        <div class="board-wrap"><div id="clash-board"></div></div>
        <div id="clash-line" class="clash-line muted">Click any move to follow the line here.</div>
      </div>
      <div id="clash-forests">${forest('white')}${forest('black')}</div>
    </div>
    <p class="muted"><small>${clash.nodeCount} positions${clash.truncated ? ', capped for size' : ''}, from ${clash.coverage.bookGamesParsed} of the opponent's games.</small></p>`;

  const board = new Board(container.querySelector('#clash-board'), { orientation: 'white' });
  board.set(START_FEN);
  boardRef.board = board;
  const lineEl = container.querySelector('#clash-line');
  let current = null; // the line currently on the board: { sans, orient }

  // Show a line up to `ply` (default its end): set the board and render the moves
  // played beneath it, each clickable to step along the same line.
  const showLine = (sans, orient, ply = null) => {
    const seq = walkSans(START_FEN, sans);
    const at = ply == null ? seq.length - 1 : Math.max(-1, Math.min(ply, seq.length - 1));
    board.orient(orient);
    if (at < 0) board.set(START_FEN); else board.set(seq[at].fen, { lastMove: seq[at].uci });
    lineEl.classList.remove('muted');
    lineEl.innerHTML = seq.map((m, i) =>
      `${i % 2 === 0 ? `<span class="clash-num">${i / 2 + 1}.</span>` : ''}<span class="clash-ply${i === at ? ' sel' : ''}" data-ply="${i}">${esc(m.san)}</span>`).join(' ');
  };

  // One delegated listener per region: a tree move sets the whole line; a move in
  // the list below steps the board along that same line.
  const forests = container.querySelector('#clash-forests');
  forests.addEventListener('click', e => {
    const mv = e.target.closest('.clash-move');
    if (!mv || !mv.dataset.path) return;
    forests.querySelectorAll('.clash-move.sel').forEach(n => n.classList.remove('sel'));
    mv.classList.add('sel');
    current = { sans: mv.dataset.path.split(' ').filter(Boolean), orient: mv.dataset.orient };
    showLine(current.sans, current.orient);
  });
  lineEl.addEventListener('click', e => {
    const p = e.target.closest('.clash-ply');
    if (p && current) showLine(current.sans, current.orient, Number(p.dataset.ply));
  });

  const extendBtn = container.querySelector('#clash-extend');
  if (extendBtn) extendBtn.onclick = () => busy(extendBtn, async () => {
    extendBtn.textContent = 'Running Stockfish…';
    try {
      const r = await api.scoutClash(ctx.fideId, { extend: true });
      if (r.clash?.engineWarning) toast(r.clash.engineWarning, true);
      renderClashForest(r.clash, container, boardRef, ctx);
    } catch (err) { toast(err.message, true); extendBtn.textContent = 'Extend prep-end leaves with engine'; }
  });

  const narrateBtn = container.querySelector('#clash-narrate');
  if (narrateBtn) narrateBtn.onclick = () => busy(narrateBtn, async () => {
    narrateBtn.textContent = 'Asking the coach…';
    try {
      const r = await api.narrateClash(ctx.fideId);
      clash.narration = r.narration;
      renderClashForest(clash, container, boardRef, ctx); // preserves engine lines already on the tree
    } catch (err) { toast(err.message, true); narrateBtn.textContent = clash.narration ? 'Regenerate explanation' : 'Explain the key lines'; }
  });
}

/** The optional coach narration: a headline and one grounded note per predicted
 * line. The moves come from the tree; the model only wrote the prose. */
function clashNarration(clash) {
  const n = clash.narration;
  if (!n) return '';
  const items = n.lines.filter(l => l.note).map(l => `<li><code>${esc(l.sanLine)}</code> ${esc(l.note)}</li>`).join('');
  return `<div class="card" style="margin:6px 0 12px">
    <p style="margin:0 0 6px"><b>${esc(n.headline)}</b></p>
    <ul style="margin:0;padding-left:20px">${items}</ul>
    <p class="muted" style="margin:8px 0 0"><small>Coach model notes, grounded in the lines above${n.model ? ` (${esc(n.model)})` : ''}.</small></p>
  </div>`;
}

/** The deeper dossier over the analysed subset: where they go wrong, clock,
 * repertoire prep-ends, recurring patterns, and the LLM prep sheet. */
async function renderEngineDossier(el, data, subject, readonly) {
  const { report: r, repertoire } = data;
  const j = r.totalJudged;
  const catLabel = c => CATEGORY_LABEL[c] || c;
  el.innerHTML = `
    <p class="muted" style="margin-top:0">Their mistakes, phrased for your preparation: aim for the phases and structures where they go wrong. Error categories and patterns come from explained scout imports; your own games against them contribute engine data.</p>
    <div class="tiles">
      <div class="tile"><div class="v">${r.overallAccuracy ?? '–'}%</div><div class="l">Their average accuracy</div></div>
      <div class="tile"><div class="v">${(r.totalMoments / r.games).toFixed(1)}</div><div class="l">Their mistakes per game</div></div>
      <div class="tile"><div class="v">${j.blunder} / ${j.mistake} / ${j.inaccuracy}</div><div class="l">Blunders / mistakes / inaccuracies</div></div>
      <div class="tile"><div class="v">${r.timeManagement ? r.timeManagement.underTwoMinMoments : '–'}</div><div class="l">Their errors under 2 minutes</div></div>
    </div>
    ${r.focus.length ? `<h3>Where they go wrong</h3><div class="grid grid-3">${r.focus.map((f, i) => `
      <div class="card"><div class="muted">#${i + 1}</div><b>${esc(catLabel(f.category))}</b><div class="muted">${f.count} moment${f.count === 1 ? '' : 's'}, weighted ${f.weight}</div></div>`).join('')}</div>` : ''}
    <div class="grid grid-2" style="margin-top: 20px">
      <div class="card">
        <h3 style="margin-top:0">Their errors by type</h3>
        <div id="scout-cat"></div>
        <div id="scout-cat-list" style="margin-top:10px"></div>
      </div>
      <div class="card">
        <h3 style="margin-top:0">Their errors by phase</h3>
        <table><thead><tr><th>Phase</th><th class="num">Moves</th><th class="num">Accuracy</th><th class="num">Moments / 100 moves</th></tr></thead>
        <tbody>${['opening', 'middlegame', 'endgame'].map(ph => { const p = r.byPhase[ph]; return `<tr><td>${ph}</td><td class="num">${p.moves}</td><td class="num">${p.accuracy ?? '–'}${p.accuracy != null ? '%' : ''}</td><td class="num">${p.momentsPer100 ?? '–'}</td></tr>`; }).join('')}</tbody></table>
        ${r.timeManagement ? `<h3>Their clock</h3>
        <p class="muted"><small>Mistakes with over 5 minutes left: ${r.timeManagement.comfortBlunders}. Errors under 2 minutes: ${r.timeManagement.underTwoMinMoments}. Snap-moves that failed: ${r.timeManagement.fastMoments}.</small></p>` : ''}
      </div>
    </div>
    <div class="card" style="margin-top: 20px">
      <h3 style="margin-top:0">Prep-ends in the analysed games</h3>
      ${repertoire.length ? `<table><thead><tr><th>As</th><th>Line</th><th>ECO</th><th class="num">Games</th><th class="num">Their score</th><th class="num">Prep ends</th><th>Games</th></tr></thead>
      <tbody>${repertoire.map(l => `<tr>
        <td><span class="chip ${l.color}">${l.color}</span></td>
        <td>${esc(fmtLine(l.line))} <a href="${lichess(l.line)}" target="_blank" rel="noopener" title="Open on lichess">↗</a>${l.moveOrders > 1 ? ` <span class="chip" title="Reached by ${l.moveOrders} move orders">${l.moveOrders} orders</span>` : ''}</td>
        <td>${esc(l.eco)}</td>
        <td class="num">${l.count}</td>
        <td class="num">${l.scorePct != null ? l.scorePct + '%' : '–'}</td>
        <td class="num">${l.prepEndsPly ? 'move ' + Math.ceil(l.prepEndsPly / 2) : '–'}</td>
        <td>${l.games.slice(0, 4).map(g => `<a href="#/game/${g.id}${g.deviationPly ? '/' + g.deviationPly : ''}" title="${esc(g.label)}">${esc(g.date || g.result)}</a>`).join(' ')}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">Appears once their games are analysed.</div>'}
    </div>
    ${r.patterns.length ? `<div class="card" style="margin-top: 20px">
      <h3 style="margin-top:0">Their recurring patterns</h3>
      <table><thead><tr><th>Pattern</th><th class="num">Count</th><th>Where</th></tr></thead><tbody>
        ${r.patterns.slice(0, 15).map(p => `<tr><td>${esc(p.pattern)}</td><td class="num">${p.count}</td>
          <td>${p.moments.slice(0, 6).map(m => `<a href="#/game/${m.gameId}/${m.ply}" title="${esc(m.label)}">${movePrefix(m)}${esc(m.san)}</a>`).join(' ')}</td></tr>`).join('')}
      </tbody></table>
    </div>` : ''}`;

  const cats = Object.entries(r.byCategory).filter(([, v]) => v.count > 0).sort((a, b) => b[1].weight - a[1].weight)
    .map(([k, v]) => ({ key: k, label: catLabel(k), value: v.weight, sub: `${v.count} moment${v.count === 1 ? '' : 's'}`, dim: k === 'unexplained', moments: v.moments }));
  barChart(el.querySelector('#scout-cat'), cats, {
    onClick: it => {
      el.querySelector('#scout-cat-list').innerHTML = `<b>${esc(it.label)}</b><ul style="margin:6px 0; padding-left: 18px">${it.moments.map(m => `<li><a href="#/game/${m.gameId}/${m.ply}">${movePrefix(m)}${esc(m.san)}</a> <span class="chip ${m.judgment}">${m.judgment}</span> <small>${esc(m.label)}</small></li>`).join('')}</ul>`;
    },
  });
}
