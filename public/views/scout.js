// Scouting: a FIDE-keyed "book" dossier built instantly from an opponent's
// whole game history (recency/rating weighted), plus the deeper engine/LLM
// dossier for the recent subset once it has been analysed.
import { api, esc, toast, movePrefix } from '../api.js';
import { barChart } from '../charts.js';
import { CATEGORY_LABEL } from './report.js';

const fmtLine = sans => sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}.` : '') + s).join(' ');
const lichess = sans => `https://lichess.org/analysis/pgn/${encodeURIComponent(fmtLine(sans))}`;

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
  const renderSubjects = q => {
    const needle = q.trim().toLowerCase();
    const shown = subjects.filter(s => !needle || s.subject.toLowerCase().includes(needle));
    listEl.innerHTML = shown.map(s => {
      const n = s.bookGames || s.games;
      // Show the federation as the at-a-glance "linked" signal; full id in the
      // tooltip; the book icon only for opponents that actually have a book.
      const tip = s.fideId ? `FIDE ${s.fideId}${s.fed ? ` (${s.fed})` : ''}, ${n} game${n === 1 ? '' : 's'}` : `no FIDE id, ${n} game${n === 1 ? '' : 's'}`;
      return `<button class="small${s.subject === current ? ' primary' : ''}" data-subject="${esc(s.subject)}" title="${esc(tip)}">${esc(s.subject)}${s.fed ? ` <small class="muted">${esc(s.fed)}</small>` : ''} (${n})${s.bookGames ? ' \u{1F4D6}' : ''}</button>`;
    }).join('') || '<span class="muted">No opponents match.</span>';
    listEl.querySelectorAll('button[data-subject]').forEach(b => b.onclick = () => { location.hash = `#/scout/${encodeURIComponent(b.dataset.subject)}`; });
  };
  renderSubjects('');
  root.querySelector('#subject-search').addEventListener('input', e => renderSubjects(e.target.value));
  const entry = subjects.find(s => s.subject === current) || { subject: current, fideId: null };
  await renderDossier(root.querySelector('#dossier'), entry, readonly);
}

async function renderDossier(el, entry, readonly) {
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
  const refresh = () => renderDossier(el, entry, readonly);
  // The prep sheet sits high: it must be generated here on the home machine, so
  // it should be the first thing you reach for on the page.
  el.innerHTML = subjectHeader(entry)
    + (data ? prepSheetCard(subject, data.report, data.prepSheet, pending, readonly) : '')
    + (linkable ? fideLinkCard(subject) : '')
    + (book ? bookSection(book.dossier, readonly) : '')
    + `<div id="engine-dossier">${data ? '' : engineHint(book, readonly)}</div>`;

  if (data) wirePrep(el, subject, data.report, pending, refresh);
  if (linkable) wireFideLink(el, subject);
  if (book) wirePromote(el, book.dossier, subject, readonly);
  if (data) renderEngineDossier(el.querySelector('#engine-dossier'), data, subject, readonly);
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

/** The prep sheet, surfaced high on the page because it must be generated on
 * the home machine (it uses the claude CLI). Flags a stale sheet (games analysed
 * since it was made) and warns when games are still being processed. */
function prepSheetCard(subject, report, prepSheet, pending, readonly) {
  const analysedNow = report.games;
  const staleN = prepSheet ? Math.max(0, analysedNow - (prepSheet.games || 0)) : 0;
  const pendingTotal = pending.toAnalyse + pending.toExplain;
  const flag = staleN > 0 || (prepSheet && pendingTotal > 0);
  const badge = staleN ? `<span class="chip mistake">stale · ${staleN} new game${staleN === 1 ? '' : 's'}</span>`
    : (prepSheet && pendingTotal ? '<span class="chip inaccuracy">more games coming</span>' : '');
  const pendingNote = pendingTotal
    ? `<p class="muted" style="margin:6px 0"><small>⏳ ${pendingTotal} of ${esc(subject)}'s game${pendingTotal === 1 ? ' is' : 's are'} still being processed (${pending.toAnalyse} to analyse, ${pending.toExplain} to explain). ${prepSheet ? 'Regenerate once they finish for the full picture.' : `The sheet will be built from the ${analysedNow} already analysed.`}</small></p>`
    : '';
  const body = prepSheet ? `
    <p><b>Overview:</b> ${esc(prepSheet.overview)}</p>
    <p><b>Game plan:</b> ${esc(prepSheet.exploit_plan)}</p>
    <p><b>Openings:</b> ${esc(prepSheet.openings_advice)}</p>
    <p><b>Watch for:</b> ${esc(prepSheet.watch_fors)}</p>
    <p class="muted"><small>From ${prepSheet.games} game${prepSheet.games === 1 ? '' : 's'}, ${esc((prepSheet.createdAt || '').slice(0, 10))}.${staleN ? ` ${staleN} more analysed since.` : ''}</small></p>`
    : `<p class="muted">One page for the board: their weaknesses, the plan against them, and what to watch for. Built here on the home machine (uses the claude CLI), then published to the phone.</p>`;
  const button = readonly
    ? (prepSheet ? '' : '<p class="muted"><small>Prep sheets are generated on the home machine and published here.</small></p>')
    : `<button class="primary" id="gen-prep">${prepSheet ? (staleN ? `Regenerate (${staleN} new)` : 'Regenerate') : 'Generate prep sheet'}${prepSheet ? '' : ' (about a minute)'}</button>`;
  return `<div class="card" style="margin-bottom:16px${flag ? '; border-color: var(--warning)' : ''}">
    <div class="row" style="justify-content:space-between; align-items:baseline; gap:8px; flex-wrap:wrap">
      <h2 style="margin:0">Preparation sheet</h2>${badge}
    </div>
    ${body}${pendingNote}${button}
  </div>`;
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
function bookSection(d, readonly) {
  const cov = d.coverage;
  const trend = d.eloTrend.length
    ? d.eloTrend.map(e => `<span class="chip" title="${e.games} game${e.games === 1 ? '' : 's'}">${e.year}: ${e.elo}</span>`).join(' ')
    : '<span class="muted">no ratings in the file</span>';
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
    <h3 style="margin-bottom:4px">Repertoire book</h3>
    <p class="muted">Repertoire book from ${d.total} games${d.dateRange ? ` (${esc(d.dateRange.from)} to ${esc(d.dateRange.to)})` : ''}. Weighted toward recent, on-strength games: ${cov.droppedOld} game${cov.droppedOld === 1 ? '' : 's'} older than ${cov.maxAgeYears} years and ${cov.droppedElo} more than ${cov.eloBand} Elo off their current strength are set aside, because they no longer describe the player you will face.</p>
    <div class="tiles">
      <div class="tile"><div class="v">${d.currentElo ?? '–'}</div><div class="l">Current strength</div></div>
      <div class="tile"><div class="v">${d.peakElo ?? '–'}</div><div class="l">Peak in file</div></div>
      <div class="tile"><div class="v">${d.results.white.recentScorePct ?? '–'}% / ${d.results.black.recentScorePct ?? '–'}%</div><div class="l">Recent score W / B</div></div>
      <div class="tile"><div class="v">${cov.analysing}</div><div class="l">Recent games to analyse</div></div>
    </div>
    <p class="muted" style="margin:10px 0 0"><small>Rating over time: ${trend}</small></p>
    <div class="grid grid-2" style="margin-top: 16px">
      <div class="card"><h3 style="margin-top:0">As White <span class="muted">(${d.results.white.games} games, scores ${d.results.white.scorePct ?? '–'}% all-time)</span></h3>${repTable('white')}</div>
      <div class="card"><h3 style="margin-top:0">As Black <span class="muted">(${d.results.black.games} games, scores ${d.results.black.scorePct ?? '–'}% all-time)</span></h3>${repTable('black')}</div>
    </div>
    <div class="card" style="margin-top: 16px">
      <h3 style="margin-top:0">Deep preparation</h3>
      <p class="muted">Run Stockfish and the coach model on their ${cov.analysing} most recent, on-strength games to find where they go wrong: error types, clock behaviour, recurring weaknesses, and "punish" drills from the positions after their mistakes.</p>
      ${readonly
        ? '<p class="muted"><small>Analysis runs on the home machine, then publishes here.</small></p>'
        : `<button class="primary" id="promote">Analyse ${cov.analysing} recent games</button> <span id="promote-note" class="muted"></span>`}
    </div>`;
}

function engineHint(book, readonly) {
  if (readonly) return '';
  return `<div class="card" style="margin-top:16px"><p class="muted">${book ? 'No games analysed yet. Use "Analyse recent games" above to build the error dossier and punish drills.' : 'Their mistakes, error types, and punish drills appear here once their games are analysed.'}</p></div>`;
}

function wirePromote(el, dossier, subject, readonly) {
  const btn = el.querySelector('#promote');
  if (!btn) return;
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = 'Queuing…';
    try {
      const r = await api.promoteScout(dossier.fideId);
      el.querySelector('#promote-note').textContent = `${r.queued} queued${r.already ? `, ${r.already} already present` : ''}. The dossier builds as analysis finishes.`;
      btn.textContent = `Queued ${r.queued} games`;
      toast(`${r.queued} of ${subject}'s recent games queued for analysis`);
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = `Analyse ${dossier.coverage.analysing} recent games`; }
  };
}

/** The deeper dossier over the analysed subset: where they go wrong, clock,
 * repertoire prep-ends, recurring patterns, and the LLM prep sheet. */
async function renderEngineDossier(el, data, subject, readonly) {
  const { report: r, repertoire } = data;
  const j = r.totalJudged;
  const catLabel = c => CATEGORY_LABEL[c] || c;
  el.innerHTML = `
    <h2 style="margin-top: 24px">Deep dossier <span class="muted" style="font-size:14px">${r.games} analysed game${r.games === 1 ? '' : 's'}</span></h2>
    <p class="muted">Their mistakes, phrased for your preparation: aim for the phases and structures where they go wrong. Error categories and patterns come from explained scout imports; your own games against them contribute engine data.</p>
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
