// Weakness report across all analysed games. Long, so it is split into
// collapsible sections; the chart-bearing sections open by default (charts need
// a visible width to size themselves).
import { api, esc, toast, movePrefix } from '../api.js';
import { barChart, lineChart } from '../charts.js';

export const CATEGORY_LABEL = {
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

const KIND_LABEL = { 'find-best': 'Find the best move', threat: 'See the threat', punish: 'Punish (scout)', opening: 'Opening prep' };

const catLabel = c => CATEGORY_LABEL[c] || c;
const fmtSecs = s => s == null ? '–' : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;

// A collapsible section. Chart sections pass open=true so they render sized.
const acc = (title, body, open = false) => `<details class="acc rsec"${open ? ' open' : ''}><summary><span class="acc-title">${title}</span></summary><div class="acc-body">${body}</div></details>`;

// Render the pre-tournament card's small markdown (headings, numbered/bulleted
// lists, bold) inline, so the one-page summary lives on the page rather than a
// download. The card format is fixed (see buildPrepCard), so this stays minimal.
function renderCardMd(md) {
  const inline = s => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  let html = '', list = null;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of String(md).split('\n')) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    if (/^#\s/.test(line)) { closeList(); continue; }        // drop the title (the section already says it)
    if (/^##\s/.test(line)) { closeList(); html += `<h3>${inline(line.slice(3))}</h3>`; continue; }
    const ol = /^(\d+)\.\s+(.*)$/.exec(line);
    if (ol) { if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(ol[2])}</li>`; continue; }
    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (ul) { if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(ul[1])}</li>`; continue; }
    closeList(); html += `<p>${inline(line)}</p>`;
  }
  closeList();
  return html;
}

export async function reportView(root) {
  const { report: r } = await api.report();
  const { notes } = await api.patterns().catch(() => ({ notes: {} }));
  const { readonly } = await api.status().catch(() => ({}));
  if (!r.games) {
    root.innerHTML = '<div class="empty">No analysed games yet. Import and analyse games first.</div>';
    return;
  }
  const j = r.totalJudged;
  // The one-page pre-tournament card, shown inline (was a markdown download).
  let cardMd = '';
  try { cardMd = await api.card(); } catch { /* best-effort: the report still renders without it */ }

  // At-a-glance numbers stay visible above the collapsible sections.
  const overview = `
    <p class="muted">${r.games} analysed game${r.games === 1 ? '' : 's'}. Critical moments are the player's moves that lost at least the configured win-probability threshold; the engine flags them, the LLM classifies them.</p>
    <div class="tiles">
      <div class="tile"><div class="v">${r.overallAccuracy ?? '–'}%</div><div class="l">Average accuracy</div></div>
      <div class="tile"><div class="v">${(r.totalMoments / r.games).toFixed(1)}</div><div class="l">Critical moments per game</div></div>
      <div class="tile"><div class="v">${j.blunder} / ${j.mistake} / ${j.inaccuracy}</div><div class="l">Blunders / mistakes / inaccuracies</div></div>
      <div class="tile"><div class="v">${r.timePressure}</div><div class="l">Flagged as time pressure</div></div>
    </div>`;

  // What is going well: the report is otherwise all deficits. Surface the
  // longitudinal wins the player rarely scrolls to.
  const whatsGoingWell = (() => {
    const best = [...(r.timeline || [])].filter(t => t.accuracy != null).sort((a, b) => b.accuracy - a.accuracy)[0];
    const improving = (r.categoryTrend || []).filter(t => t.delta <= -0.2);
    const wins = [];
    if (best) wins.push(`Best game: <b>${best.accuracy}%</b> accuracy vs ${esc(best.opponent || '?')}${best.date ? ` (${esc(best.date)})` : ''}`);
    if (improving.length) wins.push(`Improving: ${improving.map(t => esc(catLabel(t.category))).join(', ')}`);
    if (r.decoys && r.decoys.seen >= 3) wins.push(`Quiet positions read correctly: <b>${100 - r.decoys.falsePositiveRate}%</b>`);
    if (r.drillStats && r.drillStats.rate >= 55) wins.push(`Drill accuracy: <b>${r.drillStats.rate}%</b> over ${r.drillStats.attempts} attempts`);
    return wins.length ? `<div class="card" style="margin-top: 4px; border-left: 3px solid var(--good, green)"><h3 style="margin-top:0">What's going well</h3><ul style="margin:0; padding-left: 18px">${wins.map(w => `<li>${w}</li>`).join('')}</ul></div>` : '';
  })();

  const focusBody = (r.focus.length ? `<div class="grid grid-3">${r.focus.map((f, i) => `
      <div class="card"><div class="muted">#${i + 1}</div><b>${esc(CATEGORY_LABEL[f.category] || f.category)}</b><div class="muted">${f.count} moment${f.count === 1 ? '' : 's'}, weighted ${f.weight}${f.trend > 0.1 ? ' · <span style="color: var(--critical)">getting worse</span>' : f.trend < -0.1 ? ' · <span style="color: var(--good, green)">improving</span>' : ''}</div>
      <div style="margin-top:6px"><a href="#/drills?category=${encodeURIComponent(f.category)}" title="Every drill of this error type, back to back (does not touch the review schedule)">Drill this ▸</a></div></div>`).join('')}</div>` : '<div class="empty">No focus areas yet.</div>') + whatsGoingWell;

  const chartsBody = `<div class="grid grid-2">
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
    </div>`;

  const trendBody = '<div id="trend"></div><small>Chronological by PGN date. Click a point to open the game.</small>';

  const catTrendBody = r.categoryTrend ? `<table><thead><tr><th>Error type</th><th class="num">Earlier (per game)</th><th class="num">Recent (per game)</th><th>Trend</th></tr></thead>
      <tbody>${r.categoryTrend.sort((a, b) => b.recentPerGame - a.recentPerGame).map(t => `
        <tr><td>${esc(catLabel(t.category))}</td><td class="num">${t.priorPerGame}</td><td class="num">${t.recentPerGame}</td>
        <td>${t.delta <= -0.2 ? '<span style="color: var(--good, green)">▼ improving</span>' : t.delta >= 0.2 ? '<span style="color: var(--critical)">▲ worse</span>' : '≈ flat'}</td></tr>`).join('')}
      </tbody></table>
      <small>Weighted moments per game, last ${r.categoryTrend[0].recentGames} games vs the ${r.categoryTrend[0].priorGames} before. Only error types with 3+ moments.</small>` : '';

  const timeBody = r.timeManagement ? `<div class="tiles">
        <div class="tile"><div class="v">${r.timeManagement.comfortBlunders}</div><div class="l">Mistakes with over 5 min left</div></div>
        <div class="tile"><div class="v">${r.timeManagement.underTwoMinMoments}</div><div class="l">Moments under 2 min</div></div>
        <div class="tile"><div class="v">${r.timeManagement.fastMoments}</div><div class="l">Moments after ≤10s thought</div></div>
        <div class="tile"><div class="v">${fmtSecs(r.timeManagement.momentAvgSpent)} vs ${fmtSecs(r.timeManagement.otherAvgSpent)}</div><div class="l">Avg think: error moves vs others</div></div>
      </div>
      <small>From PGN clock comments (${r.timeManagement.movesWithClock} player moves with clocks). Mistakes with plenty of time are understanding gaps, not clock problems.</small>` : '';

  const endgamesBody = r.endgames?.length ? `<table><thead><tr><th>Material</th><th class="num">Moments</th><th>Where</th></tr></thead>
      <tbody>${r.endgames.map(eg => `<tr><td>${esc(eg.signature)}</td><td class="num">${eg.count}</td>
        <td>${eg.moments.map(m => `<a href="#/game/${m.gameId}/${m.ply}" title="${esc(m.label)}">${movePrefix(m)}${esc(m.san)}</a>`).join(' ')}</td></tr>`).join('')}</tbody></table>
      <small>Endgame moments bucketed by material (your pieces vs theirs). A repeating signature is a study target.</small>` : '';

  const feedbackBody = r.feedback ? `<p class="muted" style="margin-top:0">${r.feedback.helpful} rated helpful, ${r.feedback.unhelpful} not.</p>
      ${r.feedback.unhelpfulMoments.length ? `<p>Worth re-explaining or a better prompt: ${r.feedback.unhelpfulMoments.map(m => `<a href="#/game/${m.gameId}/${m.ply}" title="${esc(m.label)}">${movePrefix(m)}${esc(m.san)}</a>`).join(' ')}</p>` : ''}` : '';

  const drillBody = r.drillStats ? `<p class="muted" style="margin-top:0">${r.drillStats.attempts} attempts (reviews and first-try guesses)${r.drillStats.machines > 1 ? ` across ${r.drillStats.machines} machines` : ' on this machine'}, ${r.drillStats.rate}% correct.</p>
      <div class="grid grid-2">
        <table><thead><tr><th>Phase</th><th class="num">Attempts</th><th class="num">Correct</th></tr></thead>
        <tbody>${Object.entries(r.drillStats.byPhase).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.attempts}</td><td class="num">${Math.round((v.correct / v.attempts) * 100)}%</td></tr>`).join('')}</tbody></table>
        <table><thead><tr><th>Error type</th><th class="num">Attempts</th><th class="num">Correct</th></tr></thead>
        <tbody>${Object.entries(r.drillStats.byCategory).map(([k, v]) => `<tr><td>${esc(catLabel(k))}</td><td class="num">${v.attempts}</td><td class="num">${Math.round((v.correct / v.attempts) * 100)}%</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Categories appear once explained games are re-synced.</td></tr>'}</tbody></table>
      </div>
      ${Object.keys(r.drillStats.byKind || {}).length > 1 ? `<h3>By drill type</h3>
      <table><thead><tr><th>Type</th><th class="num">Attempts</th><th class="num">Correct</th></tr></thead>
      <tbody>${Object.entries(r.drillStats.byKind).map(([k, v]) => `<tr><td>${esc(KIND_LABEL[k] || k)}</td><td class="num">${v.attempts}</td><td class="num">${Math.round((v.correct / v.attempts) * 100)}%</td></tr>`).join('')}</tbody></table>
      <small>Separate streams: finding the best move, seeing the threat you allowed, punishing an opponent's error, opening prep.</small>` : ''}
      ${r.decoys ? `<p class="muted" style="margin-top:10px">Quiet-position detection: ${r.decoys.right} of ${r.decoys.seen} handled correctly (${r.decoys.falsePositiveRate}% false positives, calling a fine move a mistake).</p>` : ''}
      ${r.drillStats.speed ? `<h3>Recognition speed</h3>
      <table><thead><tr><th>Pattern</th><th class="num">Timed reviews</th><th class="num">Median answer</th></tr></thead>
      <tbody>${r.drillStats.speed.map(s => `<tr><td>${esc(s.pattern)}</td><td class="num">${s.attempts}</td><td class="num">${(s.medianMs / 1000).toFixed(1)}s</td></tr>`).join('')}</tbody></table>
      <small>Instant recognition, not laborious re-derivation, is what pattern training is after; watch the medians fall.</small>` : ''}` : '';

  const patternsConceptsBody = `<div class="grid grid-2">
      <div class="card">
        <h3 style="margin-top:0">Recurring patterns</h3>
        ${r.patterns.length ? `<table><thead><tr><th>Pattern</th><th class="num">Count</th><th>Type</th><th>Where</th></tr></thead><tbody>
          ${r.patterns.slice(0, 25).map(p => `<tr><td>${esc(p.pattern)}${p.count >= 2 ? ` <a href="#/drills?pattern=${encodeURIComponent(p.pattern)}" title="Lightning round: every drill of this pattern, back to back">⚡</a>` : ''}</td><td class="num">${p.count}</td><td><small>${Object.keys(p.categories).map(c => esc(CATEGORY_LABEL[c] || c)).join(', ')}</small></td>
            <td>${p.moments.slice(0, 6).map(m => `<a href="#/game/${m.gameId}/${m.ply}" title="${esc(m.label)}">${movePrefix(m)}${esc(m.san)}</a>`).join(' ')}</td></tr>`).join('')}
        </tbody></table><small>⚡ drills a recurring pattern back to back (does not touch the review schedule).</small>` : '<div class="empty">Patterns appear once moments have been explained.</div>'}
      </div>
      <div class="card">
        <h3 style="margin-top:0">Concepts to study</h3>
        ${r.concepts.length ? `<table><tbody>${r.concepts.map(c => `<tr><td>${esc(c.concept)}</td><td class="num">${c.count}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Appears after explanations.</div>'}
      </div>
    </div>`;

  const patternNotesBody = `<div id="pattern-notes">
      <p class="muted" style="margin-top:0">One transferable lesson per recurring pattern, synthesized from all its instances.</p>
      ${Object.values(notes).map(n => `<div class="explanation" style="margin-bottom:10px"><b>${esc(n.pattern)}</b> <span class="muted">(${n.count} instances)</span>
        <p><b>Rule:</b> ${esc(n.rule)}</p><p><b>Watch for:</b> ${esc(n.triggers)}</p><p><b>Habit:</b> ${esc(n.advice)}</p></div>`).join('') || ''}
      ${readonly
        ? (Object.keys(notes).length ? '' : '<div class="empty">Pattern notes are generated on the home machine and published here.</div>')
        : (r.patterns.filter(p => p.count >= 2 && !notes[p.pattern.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()]).slice(0, 10).map(p =>
            `<button class="small" data-synth="${esc(p.pattern)}" style="margin: 2px">Synthesize: ${esc(p.pattern)} (${p.count})</button>`).join('')
          || (Object.keys(notes).length ? '' : '<div class="empty">Appears once a pattern recurs in 2+ explained moments.</div>'))}
    </div>`;

  root.innerHTML = overview
    + (cardMd ? acc('Pre-tournament card', `<div class="prep-card-md">${renderCardMd(cardMd)}</div>`, true) : '')
    + acc('Focus areas', focusBody, true)
    + acc('Moments by error type, phase &amp; colour', chartsBody, true)
    + acc('Accuracy by game', trendBody, true)
    + (catTrendBody ? acc('Are the weaknesses shrinking?', catTrendBody) : '')
    + (timeBody ? acc('Time management', timeBody) : '')
    + (endgamesBody ? acc('Recurring endgame trouble', endgamesBody) : '')
    + (feedbackBody ? acc('Explanation feedback', feedbackBody) : '')
    + (drillBody ? acc('Drill performance', drillBody) : '')
    + acc('Recurring patterns &amp; concepts to study', patternsConceptsBody)
    + acc('Pattern study notes', patternNotesBody);

  root.querySelectorAll('button[data-synth]').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Synthesizing (about a minute)…';
    try { await api.synthesizePattern(b.dataset.synth); window.dispatchEvent(new HashChangeEvent('hashchange')); }
    catch (err) { b.disabled = false; b.textContent = `Synthesize: ${b.dataset.synth}`; toast(err.message, true); }
  });

  const cats = Object.entries(r.byCategory).filter(([, v]) => v.count > 0).sort((a, b) => b[1].weight - a[1].weight)
    .map(([k, v]) => ({ key: k, label: CATEGORY_LABEL[k] || k, value: v.weight, sub: `${v.count} moment${v.count === 1 ? '' : 's'}`, dim: k === 'unexplained', moments: v.moments }));
  barChart(root.querySelector('#cat-chart'), cats, {
    onClick: it => {
      root.querySelector('#cat-list').innerHTML = `<b>${esc(it.label)}</b><ul style="margin:6px 0; padding-left: 18px">${it.moments.map(m => `<li><a href="#/game/${m.gameId}/${m.ply}">${movePrefix(m)}${esc(m.san)}</a> <span class="chip ${m.judgment}">${m.judgment}</span> <small>${esc(m.label)}${m.date ? ', ' + esc(m.date) : ''}${m.pattern ? ' · ' + esc(m.pattern) : ''}</small></li>`).join('')}</ul>`;
    },
  });

  lineChart(root.querySelector('#trend'), r.timeline.map(t => ({ x: t.date ? t.date.slice(2) : '?', y: t.accuracy, sub: `${t.label} (${t.result}), ${t.moments} moments`, gameId: t.gameId })), {
    // Never clip a rough game below the axis.
    yMin: Math.min(50, ...r.timeline.map(t => Math.floor(t.accuracy / 10) * 10)),
    yMax: 100, format: v => v + '%', onClick: p => { location.hash = `#/game/${p.gameId}`; },
  });
}
