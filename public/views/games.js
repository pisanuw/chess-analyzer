// Games list and PGN import.
import { api, esc, toast } from '../api.js';

export async function gamesView(root) {
  const { settings } = await api.settings();
  const status = await api.status();
  let games = (await api.games()).games;

  // A read-only clone (viewing and drilling synced games) needs neither Stockfish
  // nor the claude CLI; only warn when there is work those tools would do.
  const pendingAnalysis = games.some(g => g.status === 'imported' || g.status === 'analysing');
  const pendingExplanations = pendingAnalysis || games.some(g => g.status === 'analysed' && (g.moments ?? 0) > (g.explained ?? 0));

  root.innerHTML = `
    <h1>Games</h1>
    ${!status.engineOk && (pendingAnalysis || !games.length) ? `<div class="card" style="border-color: var(--critical)"><b>Stockfish not found.</b> Install it (<code>brew install stockfish</code>) or set the path in <a href="#/settings">Settings</a>.</div>` : ''}
    ${settings.llmProvider === 'claude-cli' && !status.claude.ok && pendingExplanations ? `<div class="card" style="border-color: var(--warning); margin-top: 10px"><b>claude CLI not found.</b> Explanations will fail until it is installed, or switch the LLM provider to manual in <a href="#/settings">Settings</a>.</div>` : ''}
    ${!settings.playerNames.length && !games.length ? `<div class="card" style="margin-top: 10px">Set the player's name in <a href="#/settings">Settings</a> so imported games get the right colour automatically.</div>` : ''}
    <div class="card" style="margin-top: 12px">
      <h3 style="margin-top:0">Import PGN</h3>
      <div class="import-area">
        <textarea id="pgn" placeholder="Paste one or more games in PGN format, or choose a .pgn file"></textarea>
        <div style="display:flex; flex-direction:column; gap:8px; min-width: 200px">
          <input type="file" id="pgnfile" accept=".pgn,text/plain" multiple>
          <label class="check" style="margin:0"><input type="radio" name="gpurpose" value="own" checked> My games</label>
          <label class="check" style="margin:0"><input type="radio" name="gpurpose" value="scout"> Scout an opponent</label>
          <input type="text" id="subject" list="subject-names" placeholder="Opponent name as in PGN headers" hidden>
          <datalist id="subject-names"></datalist>
          <label class="check" style="margin:0"><input type="checkbox" id="auto" checked> Analyse after import</label>
          <button class="primary" id="import">Import</button>
          <small>Player: ${settings.playerNames.length ? esc(settings.playerNames.join(', ')) : 'not set'}. Engine depth ${settings.engineDepth}, explanations via ${esc(settings.llmProvider)}.</small>
        </div>
      </div>
    </div>
    <div class="row" style="margin: 18px 0 8px; justify-content: space-between">
      <h2 style="margin:0">${games.length} game${games.length === 1 ? '' : 's'}</h2>
      <div class="row">
        <button id="analyse-all" class="small">Analyse and explain everything pending</button>
      </div>
    </div>
    <div class="card" style="padding:0" id="list"></div>
  `;

  const list = root.querySelector('#list');
  let sortAsc = false;
  let filter = 'all'; // 'all' | 'own' | a subject name
  const byDate = (a, b) => (b.date || '').localeCompare(a.date || '') || b.importedAt.localeCompare(a.importedAt);
  const render = () => {
    if (!games.length) { list.innerHTML = '<div class="empty">No games yet. Import a PGN above.</div>'; return; }
    const subjects = [...new Set(games.filter(g => g.purpose === 'scout').map(g => g.subject))];
    const filterBar = subjects.length ? `<div class="row" style="padding: 8px 10px; gap: 6px; flex-wrap: wrap">
      ${[['all', 'All'], ['own', 'My games'], ...subjects.map(s => [s, 'Scout: ' + s])].map(([v, label]) =>
        `<button class="small${filter === v ? ' primary' : ''}" data-filter="${esc(v)}">${esc(label)}</button>`).join('')}
    </div>` : '';
    const rows = [...games].filter(g => filter === 'all' || (filter === 'own' ? g.purpose !== 'scout' : g.subject === filter)).sort(byDate);
    if (sortAsc) rows.reverse();
    list.innerHTML = filterBar + `<table>
      <thead><tr><th data-sort style="cursor:pointer" title="Toggle date order">Date ${sortAsc ? '↑' : '↓'}</th><th>White</th><th>Black</th><th>Result</th><th>Event</th><th>Played</th><th>Status</th><th class="num">Accuracy</th><th class="num">Moments</th><th></th></tr></thead>
      <tbody>${rows.map(g => `
        <tr class="clickable" data-id="${g.id}">
          <td><small>${esc(g.date)}</small></td>
          <td>${esc(g.white)}${g.whiteElo ? ` <small>(${esc(g.whiteElo)})</small>` : ''}</td>
          <td>${esc(g.black)}${g.blackElo ? ` <small>(${esc(g.blackElo)})</small>` : ''}</td>
          <td>${esc(g.result)}</td>
          <td><small>${esc(g.event)}${g.round ? ' R' + esc(g.round) : ''}</small></td>
          <td>${g.playerColor ? `<span class="chip ${g.playerColor}">${g.playerColor}</span>` : `<span data-stop>I played <button class="small" data-color="white">White</button> <button class="small" data-color="black">Black</button></span>`}</td>
          <td><span class="chip status-${g.status}">${g.status}${g.status === 'analysed' && g.explained ? ` (${g.explained}/${g.moments} explained)` : ''}</span>${g.purpose === 'scout' ? ` <span class="chip" title="Scouting ${esc(g.subject)}">scout</span>` : ''}</td>
          <td class="num">${g.accuracy != null ? g.accuracy + '%' : ''}</td>
          <td class="num">${g.moments != null ? `${g.moments}${g.blunders ? ` <span class="chip blunder">${g.blunders}??</span>` : ''}${g.mistakes ? ` <span class="chip mistake">${g.mistakes}?</span>` : ''}` : ''}</td>
          <td data-stop style="white-space:nowrap">
            ${g.playerColor && g.status === 'imported' ? '<button class="small" data-act="analyse">Analyse</button>' : ''}
            ${g.status === 'analysed' && g.moments > g.explained ? '<button class="small" data-act="explain">Explain</button>' : ''}
            <button class="small" data-act="delete" title="Delete">✕</button>
          </td>
        </tr>`).join('')}
      </tbody></table>`;
  };
  render();

  const refresh = async () => { games = (await api.games()).games; render(); };

  list.addEventListener('click', async e => {
    const fbtn = e.target.closest('button[data-filter]');
    if (fbtn) { filter = fbtn.dataset.filter; return render(); }
    if (e.target.closest('th[data-sort]')) { sortAsc = !sortAsc; return render(); }
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id;
    const btn = e.target.closest('button');
    if (btn?.dataset.color) {
      e.stopPropagation();
      await api.setPlayer(id, btn.dataset.color, true);
      toast('Colour set, analysis queued');
      return refresh();
    }
    if (btn?.dataset.act) {
      e.stopPropagation();
      try {
        if (btn.dataset.act === 'analyse') { await api.analyse(id); toast('Analysis queued'); }
        if (btn.dataset.act === 'explain') { await api.explain(id); toast('Explanations queued'); }
        if (btn.dataset.act === 'delete') { if (confirm('Delete this game and its drills?')) await api.deleteGame(id); }
      } catch (err) { toast(err.message, true); }
      return refresh();
    }
    if (e.target.closest('[data-stop]')) return;
    location.hash = `#/game/${id}`;
  });

  root.querySelector('#pgnfile').addEventListener('change', async e => {
    const texts = await Promise.all([...e.target.files].map(f => f.text()));
    root.querySelector('#pgn').value = texts.join('\n\n');
    updateNameSuggestions();
  });

  // Autocomplete for the scout subject: names from the pasted PGN headers (weighted
  // by frequency, so the studied player floats to the top of a multi-game file),
  // plus known subjects and past opponents. The player's own names are excluded.
  const subjectInput = root.querySelector('#subject');
  const updateNameSuggestions = () => {
    const counts = new Map();
    const bump = (n, w = 1) => {
      n = (n || '').trim();
      if (!n || n === '?') return;
      if (settings.playerNames.some(p => n.toLowerCase().includes(p.toLowerCase()))) return;
      counts.set(n, (counts.get(n) || 0) + w);
    };
    for (const m of root.querySelector('#pgn').value.matchAll(/\[(?:White|Black)\s+"([^"]+)"\]/g)) bump(m[1], 10);
    for (const g of games) { bump(g.subject, 5); bump(g.white); bump(g.black); }
    const names = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([n]) => n);
    root.querySelector('#subject-names').innerHTML = names.map(n => `<option value="${esc(n)}"></option>`).join('');
    return names;
  };
  root.querySelector('#pgn').addEventListener('input', updateNameSuggestions);

  root.querySelectorAll('input[name="gpurpose"]').forEach(el => el.addEventListener('change', () => {
    const scout = root.querySelector('input[name="gpurpose"]:checked').value === 'scout';
    subjectInput.hidden = !scout;
    if (scout) {
      const names = updateNameSuggestions();
      if (!subjectInput.value && root.querySelector('#pgn').value.trim()) subjectInput.value = names[0] || '';
      subjectInput.focus();
    }
  }));

  root.querySelector('#import').addEventListener('click', async () => {
    const pgn = root.querySelector('#pgn').value.trim();
    if (!pgn) return toast('Paste a PGN or choose a file first', true);
    const purpose = root.querySelector('input[name="gpurpose"]:checked').value;
    const subject = root.querySelector('#subject').value.trim();
    if (purpose === 'scout' && !subject) return toast('Enter the opponent name to scout', true);
    try {
      const r = await api.importPgn(pgn, root.querySelector('#auto').checked, purpose, subject);
      toast(`Imported ${r.imported.length}${r.skipped.length ? `, ${r.skipped.length} already present` : ''}${r.failed.length ? `, ${r.failed.length} failed to parse` : ''}`);
      if (r.failed.length) console.warn('Failed games', r.failed);
      root.querySelector('#pgn').value = '';
      await refresh();
    } catch (err) { toast(err.message, true); }
  });

  root.querySelector('#analyse-all').addEventListener('click', async () => {
    const r = await api.analyseAll();
    toast(`${r.queued.length} job${r.queued.length === 1 ? '' : 's'} queued`);
  });

  const { jobEvents } = await import('../app.js');
  const onFinished = () => refresh();
  jobEvents.addEventListener('finished', onFinished);
  return { destroy: () => jobEvents.removeEventListener('finished', onFinished) };
}
