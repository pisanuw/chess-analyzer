// Games list and PGN import.
import { api, esc, toast, busy } from '../api.js';

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
    ${!status.readonly && !status.engineOk && (pendingAnalysis || !games.length) ? `<div class="card" style="border-color: var(--critical)"><b>Stockfish not found.</b> Install it (<code>brew install stockfish</code>) or set the path in <a href="#/settings">Settings</a>.</div>` : ''}
    ${settings.llmProvider === 'claude-cli' && !status.claude.ok && pendingExplanations ? `<div class="card" style="border-color: var(--warning); margin-top: 10px"><b>claude CLI not found.</b> Explanations will fail until it is installed, or switch the LLM provider to manual in <a href="#/settings">Settings</a>.</div>` : ''}
    ${!settings.playerNames.length && !games.length ? `<div class="card" style="margin-top: 10px">Set the player's name in <a href="#/settings">Settings</a> so imported games get the right colour automatically.</div>` : ''}
    ${status.readonly ? '<div class="card" style="margin-top: 12px"><small class="muted">Read-only mirror: games are imported and analysed on the home machine, then published here. Drills and guessing work normally.</small></div>' : `<div class="card" style="margin-top: 12px">
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
    </div>`}
    <div class="row" style="margin: 18px 0 8px; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px">
      <h2 style="margin:0">${games.length} game${games.length === 1 ? '' : 's'}</h2>
      <div class="row" style="gap: 6px; flex-wrap: wrap">
        <input type="search" id="game-search" placeholder="Filter by player or event…" style="width: 200px; padding: 4px 8px; font-size: 13px">
        ${status.readonly ? '' : `
          <button id="analyze-pending" class="small" title="Queue engine analysis for every imported game">Analyze pending</button>
          <button id="explain-pending" class="small" title="Queue explanations for every analysed game with unexplained moments">Explain pending</button>`}
      </div>
    </div>
    ${status.readonly ? '' : `<div class="row" id="bulk-bar" hidden style="gap: 6px; align-items: center; margin: 0 0 8px; padding: 6px 10px; border-radius: 6px; background: rgba(255,255,255,.05); flex-wrap: wrap">
      <b id="bulk-count"></b>
      <span class="muted">apply to selected:</span>
      <button class="small" data-bulk="analyze">Analyze</button>
      <button class="small" data-bulk="explain">Explain</button>
      <button class="small" data-bulk="delete">Delete</button>
      <button class="small" data-bulk="clear">Clear</button>
    </div>`}
    <div class="card" style="padding:0" id="list"></div>
  `;

  const list = root.querySelector('#list');
  const bulkBar = root.querySelector('#bulk-bar');
  const selected = new Set(); // selected game ids for bulk actions
  let sortKey = 'date', sortDir = -1; // -1 = descending, 1 = ascending
  let filter = 'all'; // 'all' | 'own' | a subject name
  let query = '';     // free-text filter on players and event

  const matchesQuery = g => !query || [g.white, g.black, g.event, g.subject].some(s => (s || '').toLowerCase().includes(query));
  // PGN dates are often not zero-padded ("2026.7.29"); sort on a numeric key so
  // Sept does not rank above Oct.
  const dnum = d => {
    const s = String(d || '');
    const m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (m) return (+m[1]) * 10000 + (+m[2]) * 100 + (+m[3]);
    const y = s.match(/^(\d{4})/);
    return y ? (+y[1]) * 10000 : 0;
  };
  const sortVal = {
    date: g => dnum(g.date),
    white: g => (g.white || '').toLowerCase(),
    black: g => (g.black || '').toLowerCase(),
    result: g => g.result || '',
    event: g => (g.event || '').toLowerCase(),
    played: g => g.playerColor || '~', // unset colour sorts last
    status: g => g.status || '',
    accuracy: g => g.accuracy ?? -1,
    moments: g => g.moments ?? -1,
  };
  const cmp = (a, b) => {
    const va = sortVal[sortKey](a), vb = sortVal[sortKey](b);
    let c = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
    if (!c) c = dnum(b.date) - dnum(a.date) || (b.importedAt || '').localeCompare(a.importedAt || ''); // tiebreak: newest first
    return c * sortDir;
  };
  const cols = [
    { key: 'date', label: 'Date' }, { key: 'white', label: 'White' }, { key: 'black', label: 'Black' },
    { key: 'result', label: 'Result' }, { key: 'event', label: 'Event' }, { key: 'played', label: 'Played' },
    { key: 'status', label: 'Status' }, { key: 'accuracy', label: 'Accuracy', num: true }, { key: 'moments', label: 'Moments', num: true },
  ];

  const visibleRows = () => [...games]
    .filter(g => filter === 'all' || (filter === 'own' ? g.purpose !== 'scout' : g.subject === filter))
    .filter(matchesQuery)
    .sort(cmp);

  const updateBulk = () => {
    if (!bulkBar) return;
    bulkBar.hidden = selected.size === 0;
    const c = root.querySelector('#bulk-count');
    if (c) c.textContent = `${selected.size} selected`;
    const all = root.querySelector('#select-all');
    if (all) {
      const rows = visibleRows();
      const sel = rows.filter(g => selected.has(g.id)).length;
      all.checked = rows.length > 0 && sel === rows.length;
      all.indeterminate = sel > 0 && sel < rows.length;
    }
  };

  const render = () => {
    if (!games.length) { list.innerHTML = '<div class="empty">No games yet. Import a PGN above.</div>'; return; }
    const subjects = [...new Set(games.filter(g => g.purpose === 'scout').map(g => g.subject))];
    const filterBar = subjects.length ? `<div class="row" style="padding: 8px 10px; gap: 6px; flex-wrap: wrap">
      ${[['all', 'All'], ['own', 'My games'], ...subjects.map(s => [s, 'Scout: ' + s])].map(([v, label]) =>
      `<button class="small${filter === v ? ' primary' : ''}" data-filter="${esc(v)}">${esc(label)}</button>`).join('')}
    </div>` : '';
    const rows = visibleRows();
    if (!rows.length) { list.innerHTML = filterBar + '<div class="empty">No games match.</div>'; updateBulk(); return; }
    const arrow = k => sortKey === k ? (sortDir === 1 ? ' ↑' : ' ↓') : '';
    const selHead = status.readonly ? '' : '<th style="width:26px"><input type="checkbox" id="select-all" title="Select all shown"></th>';
    const head = `<tr>${selHead}${cols.map(c => `<th data-sortkey="${c.key}"${c.num ? ' class="num"' : ''} style="cursor:pointer" title="Sort by ${c.label}">${c.label}${arrow(c.key)}</th>`).join('')}<th></th></tr>`;
    list.innerHTML = filterBar + `<table><thead>${head}</thead>
      <tbody>${rows.map(g => `
        <tr class="clickable" data-id="${g.id}">
          ${status.readonly ? '' : `<td data-stop><input type="checkbox" class="rowsel" data-id="${g.id}"${selected.has(g.id) ? ' checked' : ''}></td>`}
          <td><small>${esc(g.date)}</small></td>
          <td>${esc(g.white)}${g.whiteElo ? ` <small>(${esc(g.whiteElo)})</small>` : ''}</td>
          <td>${esc(g.black)}${g.blackElo ? ` <small>(${esc(g.blackElo)})</small>` : ''}</td>
          <td>${esc(g.result)}</td>
          <td><small>${esc(g.event)}${g.round ? ' R' + esc(g.round) : ''}</small></td>
          <td>${g.playerColor ? `<span class="chip ${g.playerColor}">${g.playerColor}</span>` : (status.readonly ? '' : `<span data-stop>I played <button class="small" data-color="white">White</button> <button class="small" data-color="black">Black</button></span>`)}</td>
          <td><span class="chip status-${g.status}">${g.status}${g.status === 'analysed' && g.explained ? ` (${g.explained}/${g.moments} explained)` : ''}</span>${g.purpose === 'scout' ? ` <span class="chip" title="Scouting ${esc(g.subject)}">scout</span>` : ''}</td>
          <td class="num">${g.accuracy != null ? g.accuracy + '%' : ''}</td>
          <td class="num">${g.moments != null ? `${g.moments}${g.blunders ? ` <span class="chip blunder">${g.blunders}??</span>` : ''}${g.mistakes ? ` <span class="chip mistake">${g.mistakes}?</span>` : ''}` : ''}</td>
          <td data-stop style="white-space:nowrap">${status.readonly ? '' : `
            ${g.playerColor && g.status === 'imported' ? '<button class="small" data-act="analyse">Analyse</button>' : ''}
            ${g.moments != null && g.moments > (g.explained || 0) && g.status !== 'imported' ? '<button class="small" data-act="explain">Explain</button>' : ''}
            <button class="small" data-act="delete" title="Delete">✕</button>`}
          </td>
        </tr>`).join('')}
      </tbody></table>`;
    updateBulk();
  };
  render();

  const refresh = async () => {
    games = (await api.games()).games;
    for (const id of [...selected]) if (!games.some(g => g.id === id)) selected.delete(id); // prune deleted
    render();
  };

  // Apply an action to every selected game. analyze/explain skip games that are
  // not in the right state; delete confirms first.
  const runBulk = async act => {
    const ids = [...selected];
    if (!ids.length) return;
    if (act === 'delete' && !confirm(`Delete ${ids.length} game${ids.length === 1 ? '' : 's'} and their drills? This cannot be undone.`)) return;
    const chosen = games.filter(g => selected.has(g.id));
    try {
      if (act === 'analyze') {
        const t = chosen.filter(g => g.playerColor && (g.status === 'imported' || g.status === 'analysing'));
        await Promise.all(t.map(g => api.analyse(g.id)));
        toast(`Analysis queued for ${t.length}${t.length < ids.length ? ` (${ids.length - t.length} skipped: no colour or already analysed)` : ''}`);
      } else if (act === 'explain') {
        const t = chosen.filter(g => g.moments != null && g.moments > (g.explained || 0) && g.status !== 'imported' && g.status !== 'analysing');
        await Promise.all(t.map(g => api.explain(g.id)));
        toast(`Explanations queued for ${t.length}${t.length < ids.length ? ` (${ids.length - t.length} skipped: nothing to explain)` : ''}`);
      } else if (act === 'delete') {
        await Promise.all(ids.map(id => api.deleteGame(id)));
        toast(`Deleted ${ids.length} game${ids.length === 1 ? '' : 's'}`);
      }
    } catch (err) { toast(err.message, true); }
    selected.clear();
    await refresh();
  };

  // Checkbox selection (change, so it does not open the game row).
  list.addEventListener('change', e => {
    if (e.target.id === 'select-all') {
      const rows = visibleRows();
      rows.forEach(g => e.target.checked ? selected.add(g.id) : selected.delete(g.id));
      list.querySelectorAll('input.rowsel').forEach(cb => { cb.checked = selected.has(cb.dataset.id); });
      return updateBulk();
    }
    const cb = e.target.closest('input.rowsel');
    if (cb) { cb.checked ? selected.add(cb.dataset.id) : selected.delete(cb.dataset.id); updateBulk(); }
  });

  bulkBar?.addEventListener('click', e => {
    const b = e.target.closest('button[data-bulk]');
    if (!b) return;
    if (b.dataset.bulk === 'clear') { selected.clear(); return render(); }
    runBulk(b.dataset.bulk);
  });

  list.addEventListener('click', async e => {
    if (e.target.closest('input')) return; // checkboxes handled on 'change'
    const sh = e.target.closest('th[data-sortkey]');
    if (sh) {
      const k = sh.dataset.sortkey;
      if (sortKey === k) sortDir = -sortDir;
      else { sortKey = k; sortDir = (k === 'accuracy' || k === 'moments' || k === 'date') ? -1 : 1; } // numbers/dates default high-to-low
      return render();
    }
    const fbtn = e.target.closest('button[data-filter]');
    if (fbtn) { filter = fbtn.dataset.filter; return render(); }
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id;
    const btn = e.target.closest('button');
    if (btn?.dataset.color) {
      e.stopPropagation();
      try { await api.setPlayer(id, btn.dataset.color, true); toast('Colour set, analysis queued'); } catch (err) { toast(err.message, true); }
      return refresh();
    }
    if (btn?.dataset.act) {
      e.stopPropagation();
      btn.disabled = true; // no double-submit; the row is replaced by refresh() anyway
      try {
        if (btn.dataset.act === 'analyse') { await api.analyse(id); toast('Analysis queued'); }
        if (btn.dataset.act === 'explain') { await api.explain(id); toast('Explanations queued'); }
        if (btn.dataset.act === 'delete') { if (!confirm('Delete this game and its drills?')) { btn.disabled = false; return; } await api.deleteGame(id); }
      } catch (err) { btn.disabled = false; toast(err.message, true); }
      return refresh();
    }
    if (e.target.closest('[data-stop]')) return;
    location.hash = `#/game/${id}`;
  });

  // A metadb export names the opponent's FIDE id in the file, e.g.
  // "HarishNeeraj_FIDE30958130_Total_739_Games.pgn". When such a file is chosen
  // for scouting, import it into the compact book tier (hundreds of games, no
  // per-game analysis) instead of the one-game-per-job path.
  const fideOf = n => (String(n).match(/fide[-_ ]?(\d{4,})/i) || [])[1] || null;
  let scoutFile = null; // { filename, fideId, text } when a FIDE export is chosen
  root.querySelector('#pgnfile')?.addEventListener('change', async e => {
    const files = [...e.target.files];
    const texts = await Promise.all(files.map(f => f.text()));
    root.querySelector('#pgn').value = texts.join('\n\n');
    const f = files.find(f => fideOf(f.name));
    scoutFile = f ? { filename: f.name, fideId: fideOf(f.name), text: texts[files.indexOf(f)] } : null;
    if (scoutFile) {
      root.querySelector('input[name="gpurpose"][value="scout"]').checked = true;
      subjectInput.hidden = false;
      const names = updateNameSuggestions();
      if (!subjectInput.value) subjectInput.value = names[0] || '';
      toast(`FIDE export detected (id ${scoutFile.fideId}); will build a scouting book`);
    } else updateNameSuggestions();
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
  root.querySelector('#pgn')?.addEventListener('input', updateNameSuggestions);

  root.querySelector('#game-search').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); render(); });

  root.querySelectorAll('input[name="gpurpose"]').forEach(el => el.addEventListener('change', () => {
    const scout = root.querySelector('input[name="gpurpose"]:checked').value === 'scout';
    subjectInput.hidden = !scout;
    if (scout) {
      const names = updateNameSuggestions();
      if (!subjectInput.value && root.querySelector('#pgn').value.trim()) subjectInput.value = names[0] || '';
      subjectInput.focus();
    }
  }));

  root.querySelector('#import')?.addEventListener('click', async e => {
    const pgn = root.querySelector('#pgn').value.trim();
    if (!pgn) return toast('Paste a PGN or choose a file first', true);
    const purpose = root.querySelector('input[name="gpurpose"]:checked').value;
    const subject = root.querySelector('#subject').value.trim();
    if (purpose === 'scout' && !subject) return toast('Enter the opponent name to scout', true);
    try {
      await busy(e.currentTarget, async () => {
        // FIDE export + scouting -> book tier. Analysis is not queued here; the
        // recent subset is promoted from the Scouting page.
        if (purpose === 'scout' && scoutFile?.fideId) {
          const r = await api.scoutImport({ pgn: scoutFile.text, fideId: scoutFile.fideId, name: subject, filename: scoutFile.filename });
          toast(`Scouting book for ${r.name}: ${r.imported} games${r.skipped ? `, ${r.skipped} skipped (Chess960/odd)` : ''}. ${r.dossier.analysisSet.length} recent games ready to analyse.`);
          root.querySelector('#pgn').value = '';
          scoutFile = null;
          location.hash = `#/scout/${encodeURIComponent(r.name)}`;
          return;
        }
        const r = await api.importPgn(pgn, root.querySelector('#auto').checked, purpose, subject);
        toast(`Imported ${r.imported.length}${r.skipped.length ? `, ${r.skipped.length} already present` : ''}${r.failed.length ? `, ${r.failed.length} failed to parse` : ''}`);
        if (r.failed.length) console.warn('Failed games', r.failed);
        root.querySelector('#pgn').value = '';
        await refresh();
      });
    } catch (err) { toast(err.message, true); }
  });

  root.querySelector('#analyze-pending')?.addEventListener('click', async e => {
    try {
      await busy(e.currentTarget, async () => {
        const r = await api.analyseAll({ explain: false });
        toast(`${r.queued.length} analysis job${r.queued.length === 1 ? '' : 's'} queued`);
      });
    } catch (err) { toast(err.message, true); }
  });

  root.querySelector('#explain-pending')?.addEventListener('click', async e => {
    try {
      await busy(e.currentTarget, async () => {
        const t = games.filter(g => g.playerColor && g.moments != null && g.moments > (g.explained || 0) && g.status !== 'imported' && g.status !== 'analysing');
        await Promise.all(t.map(g => api.explain(g.id)));
        toast(`Explanations queued for ${t.length} game${t.length === 1 ? '' : 's'}`);
      });
    } catch (err) { toast(err.message, true); }
  });

  const { jobEvents } = await import('../app.js');
  const onFinished = () => refresh().catch(() => {}); // a failed poll refresh is not fatal
  jobEvents.addEventListener('finished', onFinished);
  return { destroy: () => jobEvents.removeEventListener('finished', onFinished) };
}
