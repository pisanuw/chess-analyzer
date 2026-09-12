// Prepare for a game: one opponent, in the colour you will have, on one page.
// The sheet, your record, what they play in that colour and how they handle
// the evaluation, the predicted lines with a board, and a prep deck (your moves
// along the predicted lines, their mistakes to punish, and predicted positions
// to play out). Progress is remembered per member so the Home page can say how
// far the prep has come.
import { api, esc, toast, busy, formatEval, session } from '../api.js';
import { Board, applyMove, lineShapes } from '../board.js';
import { fmtLine, lichessUrl } from '../shared.js';
import { prepSheetBody, headToHeadCard, tendencyTiles, habitTiles } from '../widgets.js';
import { renderClashForest } from './scout.js';
import { createPlayout } from '../playout.js';

export async function prepView(root, subjectEnc, query) {
  const subject = decodeURIComponent(subjectEnc);
  const params = new URLSearchParams(query || '');
  const myColor = params.get('color') === 'black' ? 'black' : 'white';
  const tc = ['classical', 'rapid', 'blitz'].includes(params.get('tc')) ? params.get('tc') : null;
  const go = (color, tcv) => { location.hash = `#/prep/${encodeURIComponent(subject)}?color=${color}${tcv ? `&tc=${tcv}` : ''}`; };

  let prep;
  try { ({ prep } = await api.prep(subject, myColor, tc)); }
  catch (err) {
    root.innerHTML = `<h1>Prepare</h1><div class="empty">${esc(err.message)} <a href="#/scout/${encodeURIComponent(subject)}">Open their dossier</a>.</div>`;
    return;
  }
  const { oppColor, sheet, report, headToHead, book, features, clash, deck, progress } = prep;
  const upcoming = session.user?.role === 'visitor' ? [] : (await api.upcoming().catch(() => ({ upcoming: [] }))).upcoming;
  const mine = upcoming.filter(u => u.subject === subject);
  const boards = { clash: { board: null }, deck: null };
  const total = deck.lines.length + deck.punish.length;
  const done = progress.done;

  const cov = book?.coverage;
  const classes = ['classical', 'rapid', 'blitz'].filter(k => (cov?.byTimeControl || {})[k] > 0);
  const tcToggle = classes.length && (classes.length > 1 || (cov.byTimeControl.unknown || 0) > 0)
    ? `<span class="row" style="gap:4px"><small class="muted">Time control:</small>${[['all', 'All'], ...classes.map(k => [k, k[0].toUpperCase() + k.slice(1)])].map(([v, l]) => `<button class="small${(tc || 'all') === v ? ' primary' : ''}" data-tc="${v}">${l}</button>`).join('')}</span>`
    : '';

  const bookLines = book?.repertoire?.length ? `<table><thead><tr><th class="num">Share</th><th>Their line as ${oppColor}</th><th>ECO</th><th class="num">Games</th><th class="num">Scores</th><th>Last</th></tr></thead><tbody>${book.repertoire.slice(0, 6).map(r => `<tr>
      <td class="num"><b>${r.share}%</b></td><td>${esc(fmtLine(r.line))} <a href="${lichessUrl(r.line)}" target="_blank" rel="noopener" title="Open on lichess">↗</a></td><td>${esc(r.eco)}</td><td class="num">${r.count}</td><td class="num">${r.scorePct != null ? r.scorePct + '%' : '–'}</td><td><small>${esc(r.lastDate)}</small></td></tr>`).join('')}</tbody></table>` : '';

  root.innerHTML = `
    <div class="row" style="justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:8px">
      <div>
        <a href="#/scout/${encodeURIComponent(subject)}">← ${esc(subject)}'s dossier</a>
        <h1 style="margin:4px 0 0">Prepare: you as <span class="chip ${myColor}">${myColor}</span> vs ${esc(subject)}</h1>
        <small class="muted">${book?.currentElo ? `Currently about ${book.currentElo}. ` : ''}${report.games ? `${report.games} analysed game${report.games === 1 ? '' : 's'} of them as ${oppColor}.` : `No analysed games of them as ${oppColor} yet.`}</small>
      </div>
      <div class="row" style="gap:6px; align-items:center">
        <span class="row" style="gap:4px"><small class="muted">Your colour:</small><button class="small${myColor === 'white' ? ' primary' : ''}" data-color="white">White</button><button class="small${myColor === 'black' ? ' primary' : ''}" data-color="black">Black</button></span>
        ${tcToggle}
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="row" style="justify-content:space-between; flex-wrap:wrap; gap:8px">
        <div>
          <b>Twenty-minute plan</b>
          <ol style="margin:6px 0 0; padding-left:20px">
            <li>Five minutes: read the sheet${sheet ? '' : ' (none yet: use the dossier below)'}.</li>
            <li>Five minutes: walk the predicted lines on the board${clash ? '' : ' (no FIDE book for them, so no predicted lines)'}.</li>
            <li>Ten minutes: the deck, <b id="deck-progress">${done} of ${total}</b> done${deck.sparring.length ? ', then play a predicted position out' : ''}.</li>
          </ol>
        </div>
        <div style="min-width:220px">
          ${mine.length ? mine.map(u => `<div class="row" style="gap:6px"><span class="chip ${u.color}">${u.color}</span> <b>${esc(u.date || 'date not set')}</b>${u.round ? ` <small class="muted">round ${esc(u.round)}</small>` : ''} <button class="small" data-remove-upcoming="${esc(u.id)}" title="Remove from upcoming games">✕</button></div>`).join('')
            : (session.user?.role === 'visitor' ? '' : `<form id="add-upcoming" class="row" style="gap:6px; flex-wrap:wrap">
              <input type="date" name="date" style="width:auto"><input type="text" name="round" placeholder="Round" style="width:7ch">
              <button class="small primary">Add to upcoming games</button></form>`)}
          <div class="bar" style="height:8px; background:var(--surface-2); border-radius:4px; overflow:hidden; margin-top:8px"><i id="deck-bar" style="display:block; height:100%; width:${total ? Math.round((done / total) * 100) : 0}%; background:var(--accent)"></i></div>
        </div>
      </div>
    </div>

    <details class="acc" open><summary><span class="acc-title">Preparation sheet</span>${sheet ? '' : ' <span class="chip muted">none yet</span>'}</summary>
      <div class="acc-body">${sheet ? prepSheetBody(sheet) + `<p class="muted no-print"><small>From ${sheet.games} game${sheet.games === 1 ? '' : 's'}, ${esc((sheet.createdAt || '').slice(0, 10))}.</small> <button class="small" id="prep-copy">Copy as markdown</button></p>`
        : `<p class="muted">No preparation sheet for ${esc(subject)} yet. ${session.user?.role === 'admin' ? `Generate one from <a href="#/scout/${encodeURIComponent(subject)}">their dossier</a>.` : `Request one from <a href="#/scout/${encodeURIComponent(subject)}">their dossier</a>; the rest of this page works without it.`}</p>`}</div>
    </details>

    ${headToHeadCard(headToHead)}

    <details class="acc" open><summary><span class="acc-title">Them as ${oppColor}</span> <span class="muted" style="font-size:13px">${book ? `${book.repertoire.length} line${book.repertoire.length === 1 ? '' : 's'} in their book` : ''}${report.games ? `${book ? ' · ' : ''}${report.games} analysed` : ''}</span></summary>
      <div class="acc-body">
        ${bookLines}
        ${report.tendencies?.games ? `<h3>How they handle the evaluation as ${oppColor}</h3>${tendencyTiles(report.tendencies)}` : ''}
        ${features ? `<h3>Habits from their whole history</h3>${habitTiles(features)}` : ''}
        ${report.games && report.focus?.length ? `<h3>Where they go wrong as ${oppColor}</h3><p>${report.focus.map(f => `<span class="chip cat">${esc(f.category)}</span> ${f.count} moment${f.count === 1 ? '' : 's'}`).join(' · ')} <a href="#/drills?subject=${encodeURIComponent(subject)}&color=${oppColor}">all their punish drills ▸</a></p>` : ''}
        ${!book && !report.games ? `<div class="empty">Nothing analysed for ${esc(subject)} as ${oppColor}.</div>` : ''}
      </div>
    </details>

    ${clash ? `<details class="acc" open id="prep-clash"><summary><span class="acc-title">Predicted lines: you as ${myColor}</span></summary><div class="acc-body" id="prep-clash-body"></div></details>` : ''}

    <details class="acc" open><summary><span class="acc-title">Prep deck</span> <span class="muted" style="font-size:13px">${deck.lines.length} line card${deck.lines.length === 1 ? '' : 's'}, ${deck.punish.length} punish drill${deck.punish.length === 1 ? '' : 's'}${deck.sparring.length ? `, ${deck.sparring.length} position${deck.sparring.length === 1 ? '' : 's'} to play out` : ''}</span></summary>
      <div class="acc-body" id="deck"></div>
    </details>`;

  // --- toggles and upcoming --------------------------------------------------
  root.querySelectorAll('[data-color]').forEach(b => b.onclick = () => go(b.dataset.color, tc));
  root.querySelectorAll('[data-tc]').forEach(b => b.onclick = () => go(myColor, b.dataset.tc === 'all' ? null : b.dataset.tc));
  root.querySelector('#add-upcoming')?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try { await api.addUpcoming({ subject, fideId: prep.fideId, color: myColor, date: f.get('date') || '', round: f.get('round') || '', timeControl: tc || 'all' }); toast('Added to your upcoming games'); location.reload(); }
    catch (err) { toast(err.message, true); }
  });
  root.querySelectorAll('[data-remove-upcoming]').forEach(b => b.onclick = async () => {
    try { await api.removeUpcoming(b.dataset.removeUpcoming); toast('Removed'); location.reload(); } catch (err) { toast(err.message, true); }
  });
  const copyBtn = root.querySelector('#prep-copy');
  if (copyBtn) copyBtn.onclick = () => busy(copyBtn, async () => {
    try { await navigator.clipboard.writeText(await api.scoutCard(subject)); toast('Sheet copied as markdown'); } catch (err) { toast(err.message, true); }
  });

  // --- predicted lines: the existing clash renderer, cut to this colour ------
  if (clash) renderClashForest(clash, root.querySelector('#prep-clash-body'), boards.clash, { fideId: prep.fideId, readonly: true, onlyForest: myColor });

  // --- the deck --------------------------------------------------------------
  const deckEl = root.querySelector('#deck');
  const items = [...deck.lines, ...deck.punish];
  let idx = 0, state = null, playout = null;
  let doneCount = done;
  const marks = { ...progress.marks };
  const onKey = e => {
    if (e.target.matches('input, textarea') || !state) return;
    if ((e.key === 'n' || e.key === 'N' || e.key === 'Enter' || e.key === ' ') && state.status === 'revealed') { e.preventDefault(); next(); }
  };
  document.addEventListener('keydown', onKey);

  function updateProgress() {
    root.querySelector('#deck-progress').textContent = `${doneCount} of ${total}`;
    root.querySelector('#deck-bar').style.width = `${total ? Math.round((doneCount / total) * 100) : 0}%`;
  }

  function mountBoard(orientation, onMove) {
    boards.deck?.destroy();
    boards.deck = new Board(deckEl.querySelector('#deck-board'), { orientation, onMove });
    return boards.deck;
  }

  function next() { idx++; load(); }

  function load() {
    playout?.stop(); playout = null;
    if (!items.length) { deckEl.innerHTML = `<div class="empty">No deck yet: it fills as ${esc(subject)}'s games are analysed and once they have a FIDE book.</div>${sparringList()}`; wireSparring(); return; }
    if (idx >= items.length) {
      state = null;
      deckEl.innerHTML = `<div class="card"><div class="empty">That is the whole deck. <button class="small" id="deck-again">Go through it again</button></div></div>${sparringList()}`;
      deckEl.querySelector('#deck-again').onclick = () => { idx = 0; load(); };
      wireSparring();
      return;
    }
    const d = items[idx];
    state = { d, status: 'solving', startedAt: Date.now() };
    deckEl.innerHTML = `<div class="drill-layout">
      <div><div class="board-wrap"><div id="deck-board"></div></div>
        <p class="muted" style="margin-top:8px"><small>${esc(d.label)}${d.kind === 'punish' ? ` · <a href="#/game/${d.gameId}/${d.ply}">open game</a>` : ''}</small></p></div>
      <div id="deck-panel"></div></div>`;
    mountBoard(d.orientation || d.sideToMove, onMove).set(d.fen, { movableFor: d.sideToMove });
    renderPanel();
  }

  async function onMove(orig, dest) {
    if (!state || state.status !== 'solving') return;
    const d = state.d;
    const res = await applyMove(d.fen, orig, dest);
    if (!res) return boards.deck.set(d.fen, { movableFor: d.sideToMove });
    const correct = d.acceptedUci.includes(res.uci);
    const rank = d.lines.findIndex(l => l.uci === res.uci);
    state.status = 'revealed';
    state.correct = correct;
    state.text = correct
      ? (res.uci === d.bestUci ? `${res.san}: yes, ${d.kind === 'line' ? `that is your line${d.source === 'engine' ? ' (engine-approved)' : ''}` : "the engine's first choice"}.` : `${res.san}: accepted (${d.kind === 'line' ? 'another line of yours' : `engine line ${rank + 1}`}).`)
      : (res.uci === d.playedUci ? `${res.san}: what was played in the game, but ${d.bestSan} is stronger.` : `${res.san}: not it. ${d.kind === 'line' ? `Your line here is ${d.bestSan}.` : `The refutation is ${d.bestSan}.`}`);
    boards.deck.set(res.fen, { lastMove: res.uci, shapes: lineShapes(d.lines, d.playedUci) });
    const had = (marks[d.id]?.right || 0) > 0;
    marks[d.id] = { seen: (marks[d.id]?.seen || 0) + 1, right: (marks[d.id]?.right || 0) + (correct ? 1 : 0) };
    if (correct && !had) { doneCount++; updateProgress(); }
    api.prepMark(d.id, correct).catch(() => {});
    renderPanel();
  }

  function renderPanel() {
    const d = state.d;
    const pane = deckEl.querySelector('#deck-panel');
    const side = d.sideToMove === 'white' ? 'White' : 'Black';
    const kindChip = d.kind === 'line' ? `<span class="chip">your line</span> <small class="muted">from ${esc(d.source)}</small>` : `<span class="chip">punish</span> <span class="chip ${d.judgment}">${d.judgment}</span>`;
    if (state.status === 'solving') {
      const task = d.kind === 'line'
        ? `${d.path.length ? `After ${esc(fmtLine(d.path))}: ` : ''}${side} to move. What do you play against ${esc(subject)} here?`
        : `${esc(subject)} just played ${esc(d.mistakeSan)}. ${side} to move: find the punishment.`;
      pane.innerHTML = `<div class="guess"><b>${task}</b>
        <p class="muted">Card ${idx + 1} of ${items.length}. ${kindChip}${marks[d.id] ? ` · seen ${marks[d.id].seen}, right ${marks[d.id].right}` : ''}</p>
        <button class="small" id="deck-show">Show answer</button></div>`;
      pane.querySelector('#deck-show').onclick = () => {
        state.status = 'revealed'; state.correct = false; state.text = `${d.bestSan}.`;
        boards.deck.set(d.fen, { shapes: lineShapes(d.lines, d.playedUci) });
        api.prepMark(d.id, false).catch(() => {});
        marks[d.id] = { seen: (marks[d.id]?.seen || 0) + 1, right: marks[d.id]?.right || 0 };
        renderPanel();
      };
      return;
    }
    pane.innerHTML = `<div class="guess">
      <div class="result ${state.correct ? 'good' : 'bad'}">${esc(state.text)}</div>
      <p style="margin:6px 0">${kindChip}</p>
      <ul class="lines">${d.lines.map((l, i) => `<li class="${l.uci === d.playedUci ? 'played' : ''}"><span class="ev">${formatEval(l.cp)}</span><span>${esc(l.san.join(' '))}</span>${i === 0 ? '<span class="chip">best</span>' : ''}${l.uci === d.playedUci ? '<span class="chip mistake">played</span>' : ''}</li>`).join('')}</ul>
      <div class="row" style="margin-top:12px"><button class="primary" id="deck-next">Next <span class="kbd">N</span></button></div>
    </div>`;
    pane.querySelector('#deck-next').onclick = next;
  }

  // --- sparring: play a predicted position out against the engine -------------
  function sparringList() {
    if (!deck.sparring.length) return '';
    return `<div class="card" style="margin-top:12px"><h3 style="margin-top:0">Play a predicted position out</h3>
      <p class="muted">The positions where the prediction runs out, deepest first: the middlegames you are likeliest to reach against ${esc(subject)}. Play them out against the engine at ${book?.currentElo ? `their strength (~${book.currentElo})` : 'your level'}${session.user?.role === 'visitor' || !clash ? '' : ''}.</p>
      <ul style="padding-left:18px">${deck.sparring.map((s, i) => `<li style="margin:4px 0"><code>${esc(s.sanLine)}</code> <small class="muted">${esc(s.reason)}</small> <button class="small" data-spar="${i}">Play it out</button></li>`).join('')}</ul>
      <div id="spar-area"></div></div>`;
  }

  function wireSparring() {
    deckEl.querySelectorAll('[data-spar]').forEach(b => b.onclick = () => startSparring(deck.sparring[Number(b.dataset.spar)]));
  }

  function startSparring(s) {
    playout?.stop();
    const area = deckEl.querySelector('#spar-area');
    area.innerHTML = `<div class="drill-layout" style="margin-top:10px"><div><div class="board-wrap"><div id="deck-board"></div></div></div><div id="spar-panel"></div></div>`;
    const seat = myColor;
    const elo = Math.min(3190, Math.max(1320, book?.currentElo || 2000));
    const board = mountBoard(seat, (o, d) => playout?.move(o, d));
    const render = st => {
      const v = playout?.verdict();
      area.querySelector('#spar-panel').innerHTML = `<div class="guess">
        <div class="row" style="justify-content:space-between"><b>${esc(s.sanLine)}: you are ${seat}, engine at ~${st.elo}</b>
          <span><button class="small" id="spar-assess" ${st.busy || st.over ? 'disabled' : ''}>Assess position</button> <button class="small" id="spar-stop">${st.over ? 'Done' : 'Stop'}</button></span></div>
        <p class="muted">${st.side === seat ? '' : ''}Play on the board; evals stay hidden until you assess or the game ends.</p>
        ${st.sans.length ? `<p style="font-variant-numeric: tabular-nums">${esc(st.sans.join(' '))}</p>` : ''}
        ${st.busy ? '<p class="muted">Engine is thinking…</p>' : ''}
        ${st.error ? `<p style="color:var(--critical)">${esc(st.error)}</p>` : ''}
        ${v ? `<div class="result ${v.good ? 'good' : 'bad'}">${esc(v.text)}</div>` : ''}
      </div>`;
      area.querySelector('#spar-assess').onclick = () => playout.assess();
      area.querySelector('#spar-stop').onclick = () => { playout.stop(); area.innerHTML = ''; boards.deck?.destroy(); boards.deck = null; };
    };
    // The predicted position may have the opponent to move: let the engine reply first.
    playout = createPlayout({ board, fen: s.fen, seat, elo, render });
    if (s.side !== seat) {
      playout.state.busy = true; render(playout.state);
      api.playoutMove(s.fen, elo).then(r => {
        if (playout.state.stopped) return;
        playout.state.fen = r.fen; playout.state.sans.push(r.san); playout.state.busy = false;
        board.set(r.fen, { lastMove: r.uci, movableFor: seat });
        render(playout.state);
      }).catch(err => { playout.state.busy = false; playout.state.error = err.message; render(playout.state); });
    }
  }

  load();
  return { destroy() { playout?.stop(); boards.deck?.destroy(); boards.clash.board?.destroy(); document.removeEventListener('keydown', onKey); } };
}
