// Weakness report across all analysed games.
import { api, esc } from '../api.js';
import { barChart, lineChart } from '../charts.js';

const CATEGORY_LABEL = {
  'tactics-allowed': 'Overlooked opponent tactic',
  'tactics-missed': 'Missed own tactic',
  'calculation': 'Miscalculated a line',
  'positional': 'Positional / plan',
  'opening': 'Opening knowledge',
  'endgame-technique': 'Endgame technique',
  'conversion': 'Converting a win',
  'defence': 'Defensive resource',
  'unexplained': 'Not yet explained',
};

export async function reportView(root) {
  const { report: r } = await api.report();
  if (!r.games) {
    root.innerHTML = '<h1>Weakness report</h1><div class="empty">No analysed games yet. Import and analyse games first.</div>';
    return;
  }
  const j = r.totalJudged;
  root.innerHTML = `
    <h1>Weakness report</h1>
    <p class="muted">${r.games} analysed game${r.games === 1 ? '' : 's'}. Critical moments are the player's moves that lost at least the configured win-probability threshold; the engine flags them, the LLM classifies them.</p>
    <div class="tiles">
      <div class="tile"><div class="v">${r.overallAccuracy ?? '–'}%</div><div class="l">Average accuracy</div></div>
      <div class="tile"><div class="v">${(r.totalMoments / r.games).toFixed(1)}</div><div class="l">Critical moments per game</div></div>
      <div class="tile"><div class="v">${j.blunder} / ${j.mistake} / ${j.inaccuracy}</div><div class="l">Blunders / mistakes / inaccuracies</div></div>
      <div class="tile"><div class="v">${r.timePressure}</div><div class="l">Flagged as time pressure</div></div>
    </div>

    ${r.focus.length ? `<h2>Focus areas</h2><div class="grid grid-3">${r.focus.map((f, i) => `
      <div class="card"><div class="muted">#${i + 1}</div><b>${esc(CATEGORY_LABEL[f.category] || f.category)}</b><div class="muted">${f.count} moment${f.count === 1 ? '' : 's'}, weighted ${f.weight}</div></div>`).join('')}</div>` : ''}

    <div class="grid grid-2" style="margin-top: 20px">
      <div class="card">
        <h3 style="margin-top:0">Moments by error type</h3>
        <div id="cat-chart"></div>
        <small>Weighted: inaccuracy 1, mistake 2, blunder 3. Click a bar to list the moments.</small>
        <div id="cat-list" style="margin-top:10px"></div>
      </div>
      <div class="card">
        <h3 style="margin-top:0">By phase</h3>
        <table><thead><tr><th>Phase</th><th class="num">Moves</th><th class="num">Accuracy</th><th class="num">ACPL</th><th class="num">Moments / 100 moves</th></tr></thead>
        <tbody>${['opening', 'middlegame', 'endgame'].map(ph => { const p = r.byPhase[ph]; return `<tr><td>${ph}</td><td class="num">${p.moves}</td><td class="num">${p.accuracy ?? '–'}${p.accuracy != null ? '%' : ''}</td><td class="num">${p.acpl ?? '–'}</td><td class="num">${p.momentsPer100 ?? '–'}</td></tr>`; }).join('')}</tbody></table>
        <h3>By colour</h3>
        <table><thead><tr><th>Colour</th><th class="num">Games</th><th class="num">Score</th><th class="num">Accuracy</th><th class="num">Moments / game</th></tr></thead>
        <tbody>${['white', 'black'].map(c => { const p = r.byColor[c]; return `<tr><td><span class="chip ${c}">${c}</span></td><td class="num">${p.games}</td><td class="num">${p.scorePct != null ? p.scorePct + '%' : '–'}</td><td class="num">${p.accuracy ?? '–'}${p.accuracy != null ? '%' : ''}</td><td class="num">${p.games ? (p.moments / p.games).toFixed(1) : '–'}</td></tr>`; }).join('')}</tbody></table>
      </div>
    </div>

    <div class="card" style="margin-top: 20px">
      <h3 style="margin-top:0">Accuracy by game</h3>
      <div id="trend"></div>
      <small>Chronological by PGN date. Click a point to open the game.</small>
    </div>

    <div class="grid grid-2" style="margin-top: 20px">
      <div class="card">
        <h3 style="margin-top:0">Recurring patterns</h3>
        ${r.patterns.length ? `<table><thead><tr><th>Pattern</th><th class="num">Count</th><th>Type</th><th>Where</th></tr></thead><tbody>
          ${r.patterns.slice(0, 25).map(p => `<tr><td>${esc(p.pattern)}</td><td class="num">${p.count}</td><td><small>${Object.keys(p.categories).map(c => esc(CATEGORY_LABEL[c] || c)).join(', ')}</small></td>
            <td>${p.moments.slice(0, 6).map(m => `<a href="#/game/${m.gameId}/${m.ply}" title="${esc(m.label)}">${m.moveNumber}${m.color === 'white' ? '.' : '...'}${esc(m.san)}</a>`).join(' ')}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">Patterns appear once moments have been explained.</div>'}
      </div>
      <div class="card">
        <h3 style="margin-top:0">Concepts to study</h3>
        ${r.concepts.length ? `<table><tbody>${r.concepts.map(c => `<tr><td>${esc(c.concept)}</td><td class="num">${c.count}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Appears after explanations.</div>'}
      </div>
    </div>`;

  const cats = Object.entries(r.byCategory).filter(([, v]) => v.count > 0).sort((a, b) => b[1].weight - a[1].weight)
    .map(([k, v]) => ({ key: k, label: CATEGORY_LABEL[k] || k, value: v.weight, sub: `${v.count} moment${v.count === 1 ? '' : 's'}`, dim: k === 'unexplained', moments: v.moments }));
  barChart(root.querySelector('#cat-chart'), cats, {
    onClick: it => {
      root.querySelector('#cat-list').innerHTML = `<b>${esc(it.label)}</b><ul style="margin:6px 0; padding-left: 18px">${it.moments.map(m => `<li><a href="#/game/${m.gameId}/${m.ply}">${m.moveNumber}${m.color === 'white' ? '.' : '...'}${esc(m.san)}</a> <span class="chip ${m.judgment}">${m.judgment}</span> <small>${esc(m.label)}${m.date ? ', ' + esc(m.date) : ''}${m.pattern ? ' · ' + esc(m.pattern) : ''}</small></li>`).join('')}</ul>`;
    },
  });

  lineChart(root.querySelector('#trend'), r.timeline.map(t => ({ x: t.date ? t.date.slice(2) : '?', y: t.accuracy, sub: `${t.label} (${t.result}), ${t.moments} moments`, gameId: t.gameId })), {
    yMin: 50, yMax: 100, format: v => v + '%', onClick: p => { location.hash = `#/game/${p.gameId}`; },
  });
}
