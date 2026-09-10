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
        <div style="display:flex; flex-direction:column; gap:8px; min-width: 220px">
          <input type="file" id="pgnfile" accept=".pgn,text/plain" multiple>
          <label class="check" style="margin:0"><input type="checkbox" id="auto" checked> Analyse after import</label>
          <button class="primary" id="import">Import</button>
          <small class="muted" id="import-hint">Your games, an opponent's games, or a FIDE export are detected automatically.</small>
          <small>Player: ${settings.playerNames.length ? esc(settings.playerNames.join(', ')) : 'not set'}. Engine depth ${settings.engineDepth}, explanations via ${esc(settings.llmProvider)}.</small>
        </div>
      </div>
    </div>`}
    <div class="row" style="margin: 18px 0 8px; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px">
      <h2 style="margin:0">${games.length} game${games.length === 1 ? '' : 's'}</h2>
      <div class="row" style="gap: 6px; flex-wrap: wrap; align-items: center">
        <input type="search" id="game-search" placeholder="Filter by player or event…" style="width: 200px; padding: 4px 8px; font-size: 13px">
        ${status.readonly ? '' : `
          <span id="sel-count" class="muted" style="font-size:13px"></span>
          <button id="act-analyze" class="small" title="Analyze the checked games, or every pending game if none are checked">Analyze</button>
          <button id="act-explain" class="small" title="Explain the checked games, or every analysed game with unexplained moments if none are checked">Explain</button>
          <button id="act-delete" class="small" title="Delete the checked games">Delete</button>`}
      </div>
    </div>
    <div class="card" style="padding:0" id="list"></div>
  `;

  const list = root.querySelector('#list');
  const selected = new Set(); // checked game ids for the top action buttons
  let sortKey = 'date', sortDir = -1; // -1 = descending, 1 = ascending
  let filter = 'all'; // 'all' | 'own' | a subject name
  let query = '';     // free-text filter on players and event
  const PAGE_SIZE = 50;
  let page = 0;       // 0-based page; each page is PAGE_SIZE rows (1-50, 51-100, ...)
  let showAll = false; // "Show all" ignores paging and lists every match

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
  // Rows on screen now: the current page, or everything when "Show all" is on.
  const shownRows = () => {
    const all = visibleRows();
    if (showAll) return all;
    const pageCount = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    if (page >= pageCount) page = pageCount - 1; // clamp after a filter shrinks the set
    return all.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  };

  // Page numbers to show: always first and last, a window of one either side of
  // the current page, ellipses for the gaps. Keeps the bar short with many pages.
  const pageWindow = (cur, count) => {
    const want = [...new Set([0, cur - 1, cur, cur + 1, count - 1])].filter(n => n >= 0 && n < count).sort((a, b) => a - b);
    const out = [];
    let prev = -1;
    for (const n of want) { if (n - prev > 1) out.push('gap'); out.push(n); prev = n; }
    return out;
  };

  // The pager: page buttons in chunks of PAGE_SIZE, plus a "Show all" toggle.
  const pager = total => {
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const from = showAll ? 1 : page * PAGE_SIZE + 1;
    const to = showAll ? total : Math.min(total, page * PAGE_SIZE + PAGE_SIZE);
    if (pageCount <= 1 && !showAll) return ''; // one page: nothing to page through
    const btn = (label, data, { on = false, off = false } = {}) =>
      `<button class="small${on ? ' primary' : ''}" data-page="${data}"${off ? ' disabled' : ''}>${label}</button>`;
    let controls;
    if (showAll) {
      controls = btn('Show in pages', 'pages');
    } else {
      const nums = pageWindow(page, pageCount)
        .map(n => n === 'gap' ? '<span class="muted"><small>…</small></span>' : btn(n + 1, n, { on: n === page })).join(' ');
      controls = `${btn('‹', 'prev', { off: page === 0 })} ${nums} ${btn('›', 'next', { off: page >= pageCount - 1 })} `
        + `<span class="muted">·</span> ${btn(`Show all ${total}`, 'all')}`;
    }
    return `<div class="row" style="padding:10px; gap:6px; justify-content:center; align-items:center; flex-wrap:wrap">
      <span class="muted"><small>Showing ${from}–${to} of ${total}</small></span> ${controls}
    </div>`;
  };

  const updateSel = () => {
    const c = root.querySelector('#sel-count');
    if (c) c.textContent = selected.size ? `${selected.size} selected` : '';
    const all = root.querySelector('#select-all');
    if (all) {
      const rows = shownRows();
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
    const all = visibleRows();
    if (!all.length) { list.innerHTML = filterBar + '<div class="empty">No games match.</div>'; updateSel(); return; }
    const rows = shownRows();
    const arrow = k => sortKey === k ? (sortDir === 1 ? ' ↑' : ' ↓') : '';
    const selHead = status.readonly ? '' : '<th style="width:26px"><input type="checkbox" id="select-all" title="Select all shown"></th>';
    const head = `<tr>${selHead}${cols.map(c => `<th data-sortkey="${c.key}"${c.num ? ' class="num"' : ''} style="cursor:pointer" title="Sort by ${c.label}">${c.label}${arrow(c.key)}</th>`).join('')}</tr>`;
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
          <td><span class="chip status-${g.status}">${g.status}${g.status === 'analysed' && g.explained ? ` (${g.explained}/${g.moments} explained)` : ''}</span></td>
          <td class="num">${g.accuracy != null ? g.accuracy + '%' : ''}</td>
          <td class="num">${g.moments != null ? `${g.moments}${g.blunders ? ` <span class="chip blunder">${g.blunders}??</span>` : ''}${g.mistakes ? ` <span class="chip mistake">${g.mistakes}?</span>` : ''}` : ''}</td>
        </tr>`).join('')}
      </tbody></table>` + pager(all.length);
    updateSel();
  };
  render();

  const refresh = async () => {
    games = (await api.games()).games;
    for (const id of [...selected]) if (!games.some(g => g.id === id)) selected.delete(id); // prune deleted
    render();
  };

  // Checkbox selection (change, so it does not open the game row).
  list.addEventListener('change', e => {
    if (e.target.id === 'select-all') {
      const rows = shownRows();
      rows.forEach(g => e.target.checked ? selected.add(g.id) : selected.delete(g.id));
      list.querySelectorAll('input.rowsel').forEach(cb => { cb.checked = selected.has(cb.dataset.id); });
      return updateSel();
    }
    const cb = e.target.closest('input.rowsel');
    if (cb) { cb.checked ? selected.add(cb.dataset.id) : selected.delete(cb.dataset.id); updateSel(); }
  });

  list.addEventListener('click', async e => {
    if (e.target.closest('input')) return; // checkboxes handled on 'change'
    const pg = e.target.closest('button[data-page]');
    if (pg) {
      const v = pg.dataset.page;
      if (v === 'all') showAll = true;
      else if (v === 'pages') { showAll = false; page = 0; }
      else if (v === 'prev') page = Math.max(0, page - 1);
      else if (v === 'next') page += 1; // clamped in shownRows
      else { showAll = false; page = +v; }
      return render();
    }
    const sh = e.target.closest('th[data-sortkey]');
    if (sh) {
      const k = sh.dataset.sortkey;
      if (sortKey === k) sortDir = -sortDir;
      else { sortKey = k; sortDir = (k === 'accuracy' || k === 'moments' || k === 'date') ? -1 : 1; } // numbers/dates default high-to-low
      page = 0; // reordering changes what each page holds; start from the top
      return render();
    }
    const fbtn = e.target.closest('button[data-filter]');
    if (fbtn) { filter = fbtn.dataset.filter; page = 0; return render(); }
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id;
    const btn = e.target.closest('button');
    if (btn?.dataset.color) {
      e.stopPropagation();
      try { await api.setPlayer(id, btn.dataset.color, true); toast('Colour set, analysis queued'); } catch (err) { toast(err.message, true); }
      return refresh();
    }
    if (e.target.closest('[data-stop]')) return;
    location.hash = `#/game/${id}`;
  });

  // --- top action buttons: act on the checked games, or fall back to all ------
  root.querySelector('#act-analyze')?.addEventListener('click', async e => {
    try {
      await busy(e.currentTarget, async () => {
        if (selected.size) {
          const t = games.filter(g => selected.has(g.id) && g.playerColor && (g.status === 'imported' || g.status === 'analysing'));
          await Promise.all(t.map(g => api.analyse(g.id)));
          toast(`Analysis queued for ${t.length}${t.length < selected.size ? ` (${selected.size - t.length} skipped: no colour or already analysed)` : ''}`);
          selected.clear();
        } else {
          const r = await api.analyseAll({ explain: false });
          toast(`${r.queued.length} analysis job${r.queued.length === 1 ? '' : 's'} queued`);
        }
      });
      await refresh();
    } catch (err) { toast(err.message, true); }
  });

  root.querySelector('#act-explain')?.addEventListener('click', async e => {
    try {
      await busy(e.currentTarget, async () => {
        const pool = selected.size ? games.filter(g => selected.has(g.id)) : games;
        const t = pool.filter(g => g.playerColor && g.moments != null && g.moments > (g.explained || 0) && g.status !== 'imported' && g.status !== 'analysing');
        await Promise.all(t.map(g => api.explain(g.id)));
        toast(`Explanations queued for ${t.length} game${t.length === 1 ? '' : 's'}${selected.size && t.length < selected.size ? ` (${selected.size - t.length} skipped: nothing to explain)` : ''}`);
        selected.clear();
      });
      await refresh();
    } catch (err) { toast(err.message, true); }
  });

  root.querySelector('#act-delete')?.addEventListener('click', async () => {
    if (!selected.size) return toast('Check the games you want to delete first', true);
    const ids = [...selected];
    if (!confirm(`Delete ${ids.length} game${ids.length === 1 ? '' : 's'} and their drills? This cannot be undone.`)) return;
    try {
      await Promise.all(ids.map(id => api.deleteGame(id)));
      toast(`Deleted ${ids.length} game${ids.length === 1 ? '' : 's'}`);
    } catch (err) { toast(err.message, true); }
    selected.clear();
    await refresh();
  });

  // --- import: purpose is auto-detected, no manual "own vs scout" choice ------
  // A metadb export names the opponent's FIDE id in the file, e.g.
  // "HarishNeeraj_FIDE30958130_Total_739_Games.pgn"; that becomes a scouting
  // book (hundreds of games, no per-game analysis). Otherwise: if a configured
  // player name appears in the PGN it is your game, else it scouts the opponent
  // named in it.
  const fideOf = n => (String(n).match(/fide[-_ ]?(\d{4,})/i) || [])[1] || null;
  let scoutFile = null; // { filename, fideId, text } when a FIDE export is chosen

  const topOpponentName = (text) => {
    const counts = new Map();
    for (const m of text.matchAll(/\[(?:White|Black)\s+"([^"]+)"\]/g)) {
      const n = m[1].trim();
      if (!n || n === '?' || settings.playerNames.some(p => p && n.toLowerCase().includes(p.toLowerCase()))) continue;
      counts.set(n, (counts.get(n) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  };
  const detectMode = () => {
    if (scoutFile?.fideId) return { mode: 'book', fideId: scoutFile.fideId };
    const text = root.querySelector('#pgn').value;
    if (!text.trim()) return { mode: 'empty' };
    const hasKai = settings.playerNames.some(p => p && text.toLowerCase().includes(p.toLowerCase()));
    if (hasKai || !settings.playerNames.length) return { mode: 'own' };
    return { mode: 'scout', subject: topOpponentName(text) };
  };
  const updateHint = () => {
    const hint = root.querySelector('#import-hint');
    if (!hint) return;
    const d = detectMode();
    hint.textContent = d.mode === 'book' ? `Detected: FIDE export, will build a scouting book (id ${d.fideId}).`
      : d.mode === 'own' ? 'Detected: your games (feeds drills, report, puzzles).'
        : d.mode === 'scout' ? (d.subject ? `Detected: scouting ${d.subject}.` : 'Detected: opponent games, but could not tell who. Set your name in Settings, or use a FIDE export.')
          : 'Your games, an opponent\'s games, or a FIDE export are detected automatically.';
  };

  root.querySelector('#pgnfile')?.addEventListener('change', async e => {
    const files = [...e.target.files];
    const texts = await Promise.all(files.map(f => f.text()));
    root.querySelector('#pgn').value = texts.join('\n\n');
    const f = files.find(f => fideOf(f.name));
    scoutFile = f ? { filename: f.name, fideId: fideOf(f.name), text: texts[files.indexOf(f)] } : null;
    updateHint();
  });
  root.querySelector('#pgn')?.addEventListener('input', () => { scoutFile = null; updateHint(); });

  root.querySelector('#game-search').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); page = 0; render(); });

  root.querySelector('#import')?.addEventListener('click', async e => {
    const pgn = root.querySelector('#pgn').value.trim();
    if (!pgn) return toast('Paste a PGN or choose a file first', true);
    const d = detectMode();
    if (d.mode === 'scout' && !d.subject) return toast('Could not tell whose games these are. Add your name in Settings, or use a FIDE export.', true);
    try {
      await busy(e.currentTarget, async () => {
        if (d.mode === 'book') {
          // Scouting book (server derives the subject name from the games).
          const r = await api.scoutImport({ pgn: scoutFile.text, fideId: scoutFile.fideId, filename: scoutFile.filename });
          toast(`Scouting book for ${r.name}: ${r.imported} games${r.skipped ? `, ${r.skipped} skipped (Chess960/odd)` : ''}. ${r.dossier.analysisSet.length} recent games ready to analyse.`);
          root.querySelector('#pgn').value = ''; scoutFile = null; updateHint();
          location.hash = `#/scout/${encodeURIComponent(r.name)}`;
          return;
        }
        const r = await api.importPgn(pgn, root.querySelector('#auto').checked, d.mode, d.mode === 'scout' ? d.subject : '');
        toast(`Imported ${r.imported.length}${d.mode === 'scout' ? ` (scouting ${d.subject})` : ''}${r.skipped.length ? `, ${r.skipped.length} already present` : ''}${r.failed.length ? `, ${r.failed.length} failed to parse` : ''}`);
        if (r.failed.length) console.warn('Failed games', r.failed);
        root.querySelector('#pgn').value = ''; updateHint();
        await refresh();
      });
    } catch (err) { toast(err.message, true); }
  });

  const { jobEvents } = await import('../app.js');
  const onFinished = () => refresh().catch(() => {}); // a failed poll refresh is not fatal
  jobEvents.addEventListener('finished', onFinished);
  return { destroy: () => jobEvents.removeEventListener('finished', onFinished) };
}
