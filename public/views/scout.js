// Scouting: per-opponent dossier built from their analysed games.
import { api, esc, toast } from '../api.js';
import { barChart } from '../charts.js';
import { CATEGORY_LABEL } from './report.js';

export async function scoutView(root) {
  const { subjects } = await api.scoutSubjects();
  if (!subjects.length) {
    root.innerHTML = `<h1>Scouting</h1><div class="empty">No opponents yet. Everyone you play appears here once your games are analysed; import an opponent's other games with "Scout an opponent" for a deeper dossier.</div>`;
    return;
  }
  const current = decodeURIComponent(location.hash.split('/')[2] || '') || subjects[0].subject;
  root.innerHTML = `
    <h1>Scouting</h1>
    <div class="row" style="gap: 6px; flex-wrap: wrap; margin-bottom: 14px">
      ${subjects.map(s => `<button class="small${s.subject === current ? ' primary' : ''}" data-subject="${esc(s.subject)}">${esc(s.subject)} (${s.analysed}/${s.games})</button>`).join('')}
    </div>
    <div id="dossier"></div>`;
  root.querySelectorAll('button[data-subject]').forEach(b => b.onclick = () => { location.hash = `#/scout/${encodeURIComponent(b.dataset.subject)}`; });
  await renderDossier(root.querySelector('#dossier'), current);
}

async function renderDossier(el, subject) {
  let data;
  try { data = await api.scout(subject); } catch (err) {
    el.innerHTML = `<div class="empty">${esc(err.message)}. Games may still be in the analysis queue.</div>`;
    return;
  }
  const { report: r, repertoire, prepSheet } = data;
  const j = r.totalJudged;
  const catLabel = c => CATEGORY_LABEL[c] || c;
  const fmtLine = sans => sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}.` : '') + s).join(' ');
  el.innerHTML = `
    <p class="muted">${r.games} analysed game${r.games === 1 ? '' : 's'} of ${esc(subject)}, including your own games against them. Their mistakes, phrased for your preparation: aim for the phases and structures where they go wrong. Error categories and patterns come from explained scout imports; your own games contribute engine data.</p>
    <div class="tiles">
      <div class="tile"><div class="v">${r.overallAccuracy ?? '–'}%</div><div class="l">Their average accuracy</div></div>
      <div class="tile"><div class="v">${(r.totalMoments / r.games).toFixed(1)}</div><div class="l">Their mistakes per game</div></div>
      <div class="tile"><div class="v">${j.blunder} / ${j.mistake} / ${j.inaccuracy}</div><div class="l">Blunders / mistakes / inaccuracies</div></div>
      <div class="tile"><div class="v">${r.timeManagement ? r.timeManagement.underTwoMinMoments : '–'}</div><div class="l">Their errors under 2 minutes</div></div>
    </div>
    ${r.focus.length ? `<h2>Where they go wrong</h2><div class="grid grid-3">${r.focus.map((f, i) => `
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
        <p class="muted"><small>Mistakes with over 5 minutes left: ${r.timeManagement.comfortBlunders}. Errors under 2 minutes: ${r.timeManagement.underTwoMinMoments}. Snap-moves that failed: ${r.timeManagement.fastMoments}. Push positions where they must think; they crack ${r.timeManagement.underTwoMinMoments > r.timeManagement.comfortBlunders ? 'in time trouble' : 'even with time'}.</small></p>` : ''}
      </div>
    </div>
    <div class="card" style="margin-top: 20px">
      <h3 style="margin-top:0">Their repertoire and where their prep ends</h3>
      ${repertoire.length ? `<table><thead><tr><th>As</th><th>Line</th><th>ECO</th><th class="num">Games</th><th class="num">Their score</th><th class="num">Prep ends</th><th>Games</th></tr></thead>
      <tbody>${repertoire.map(l => `<tr>
        <td><span class="chip ${l.color}">${l.color}</span></td>
        <td>${esc(fmtLine(l.line))}</td>
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
          <td>${p.moments.slice(0, 6).map(m => `<a href="#/game/${m.gameId}/${m.ply}" title="${esc(m.label)}">${m.moveNumber}${m.color === 'white' ? '.' : '...'}${esc(m.san)}</a>`).join(' ')}</td></tr>`).join('')}
      </tbody></table>
    </div>` : ''}
    <div class="card" style="margin-top: 20px">
      <h3 style="margin-top:0">Preparation sheet</h3>
      ${prepSheet ? `
        <p><b>Overview:</b> ${esc(prepSheet.overview)}</p>
        <p><b>Game plan:</b> ${esc(prepSheet.exploit_plan)}</p>
        <p><b>Openings:</b> ${esc(prepSheet.openings_advice)}</p>
        <p><b>Watch for:</b> ${esc(prepSheet.watch_fors)}</p>
        <p class="muted"><small>From ${prepSheet.games} game${prepSheet.games === 1 ? '' : 's'}, ${esc((prepSheet.createdAt || '').slice(0, 10))}.</small></p>` : `
        <p class="muted">One page: their weaknesses, the game plan against them, and what to watch for.</p>`}
      <button class="small" id="gen-prep">${prepSheet ? 'Regenerate' : 'Generate'} prep sheet (about a minute)</button>
    </div>`;

  el.querySelector('#gen-prep').onclick = async e => {
    const b = e.target;
    b.disabled = true; b.textContent = 'Generating…';
    try { await api.prepSheet(subject); await renderDossier(el, subject); }
    catch (err) { toast(err.message, true); b.disabled = false; b.textContent = 'Generate prep sheet (about a minute)'; }
  };

  const cats = Object.entries(r.byCategory).filter(([, v]) => v.count > 0).sort((a, b) => b[1].weight - a[1].weight)
    .map(([k, v]) => ({ key: k, label: catLabel(k), value: v.weight, sub: `${v.count} moment${v.count === 1 ? '' : 's'}`, dim: k === 'unexplained', moments: v.moments }));
  barChart(el.querySelector('#scout-cat'), cats, {
    onClick: it => {
      el.querySelector('#scout-cat-list').innerHTML = `<b>${esc(it.label)}</b><ul style="margin:6px 0; padding-left: 18px">${it.moments.map(m => `<li><a href="#/game/${m.gameId}/${m.ply}">${m.moveNumber}${m.color === 'white' ? '.' : '...'}${esc(m.san)}</a> <span class="chip ${m.judgment}">${m.judgment}</span> <small>${esc(m.label)}</small></li>`).join('')}</ul>`;
    },
  });
}
