// Single game: board, eval graph, moves, critical moments with guess-first reveal, summary.
import { api, esc, toast, formatEval, fmtClock, moveLabel, movePrefix, winProb, WP_ACCEPT, JUDGE_MARK } from '../api.js';
import { Board, applyMove, gameStatus, walkSans, lineShapes } from '../board.js';
import { evalGraph } from '../charts.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Modal form for fixing player names; resolves { white, black, subject? } or null. */
function editNamesDialog(current, wantSubject) {
  return new Promise(resolve => {
    const div = document.createElement('div');
    div.className = 'promo-overlay';
    div.innerHTML = `<form class="dialog">
      <h3 style="margin:0 0 4px">Fix player names</h3>
      <label class="field"><span>White</span><input name="white" value="${esc(current.white)}"></label>
      <label class="field"><span>Black</span><input name="black" value="${esc(current.black)}"></label>
      ${wantSubject ? `<label class="field"><span>Scouting subject (must match one of the names)</span><input name="subject" value="${esc(current.subject || '')}"></label>` : ''}
      <div class="row" style="justify-content:flex-end; gap:8px"><button type="button" class="small" data-d="cancel">Cancel</button><button class="small primary">Save</button></div>
    </form>`;
    const done = v => { div.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') done(null); };
    document.addEventListener('keydown', onKey);
    div.addEventListener('click', e => { if (e.target === div || e.target.closest('[data-d="cancel"]')) done(null); });
    div.querySelector('form').addEventListener('submit', e => {
      e.preventDefault();
      const f = new FormData(e.target);
      done({
        white: String(f.get('white') || '').trim(),
        black: String(f.get('black') || '').trim(),
        subject: wantSubject ? String(f.get('subject') || '').trim() : undefined,
      });
    });
    document.body.appendChild(div);
    div.querySelector('input').focus();
  });
}

export async function gameView(root, id, startPly) {
  let { game, feedback = {} } = await api.game(id);
  const { settings } = await api.settings();
  const { readonly, engineOk } = await api.status();
  const state = { ply: 0, tab: 'moments', moment: null, guess: null, preview: null, playout: null };

  const h = game.headers;
  const player = game.playerColor;
  root.innerHTML = `
    <div class="row" style="justify-content: space-between; margin-bottom: 10px">
      <div>
        <a href="#/games">← Games</a>
        <h1 style="margin: 4px 0 0">${esc(h.White || '?')} ${h.WhiteElo ? `<small>(${esc(h.WhiteElo)})</small>` : ''} vs ${esc(h.Black || '?')} ${h.BlackElo ? `<small>(${esc(h.BlackElo)})</small>` : ''} <span class="muted">${esc(h.Result || '*')}</span></h1>
        <small>${esc([h.Event, h.Site, h.Date, h.Round ? 'Round ' + h.Round : ''].filter(Boolean).join(' · '))}${h.ECO ? ' · ' + esc(h.ECO) : ''}${h.TimeControl ? ' · ' + esc(h.TimeControl) : ''}</small>
      </div>
      <div class="row" id="actions"></div>
    </div>
    <div class="game-layout">
      <div>
        <div class="board-wrap"><div id="board"></div></div>
        <div class="board-controls">
          <button id="first" title="Start">|◀</button><button id="prev" title="Previous (←)">◀</button>
          <button id="next" title="Next (→)">▶</button><button id="last" title="End">▶|</button>
          <span class="eval-bar-text" id="evaltext"></span>
          <span class="muted" id="plytext" style="font-size:13px"></span>
          <span class="spacer"></span>
          <button id="flip" title="Flip board">⇅</button>
        </div>
        <div id="graph" style="margin-top: 10px"></div>
      </div>
      <div>
        <div class="tabs">
          <button data-tab="moments">Critical moments${game.analysis ? ` (${game.analysis.summary.moments.length})` : ''}</button>
          <button data-tab="moves">Moves</button>
          <button data-tab="summary">Summary</button>
        </div>
        <div id="panel"></div>
      </div>
    </div>`;

  // Scout games flip the guess flow: the moment is the subject's mistake, and the
  // student guesses the PUNISHMENT from the position after it, one ply later.
  const scout = game.purpose === 'scout';
  const punisher = player === 'white' ? 'black' : 'white';
  const seat = scout ? punisher : player; // the side the person at the keyboard plays

  const boardEl = root.querySelector('#board');
  const board = new Board(boardEl, { orientation: seat || 'white', onMove: onUserMove });
  const panel = root.querySelector('#panel');
  const moves = () => game.analysis ? game.analysis.moves : game.moves;
  let graph = null;

  function fenAt(ply) { return ply === 0 ? (game.moves[0]?.fenBefore || START_FEN) : game.moves[ply - 1].fenAfter; }

  function showPly(ply, { shapes = null } = {}) {
    if (state.playout) return; // navigation must not clobber a live play-out board
    state.ply = Math.max(0, Math.min(game.moves.length, ply));
    state.preview = null;
    const m = state.ply ? moves()[state.ply - 1] : null;
    const guessPly = state.guess ? (scout ? state.guess.ply : state.guess.ply - 1) : null;
    const movableFor = state.guess && (state.guess.status === 'guessing' || state.guess.status === 'retry') && state.ply === guessPly ? seat : null;
    board.set(fenAt(state.ply), { lastMove: m?.uci, movableFor, shapes: shapes || [] });
    root.querySelector('#evaltext').textContent = m && game.analysis ? formatEval(m.evalAfter) : '';
    root.querySelector('#plytext').textContent = m ? `${moveLabel(m)}${game.analysis ? ' ' + JUDGE_MARK[m.judgment] : ''}` : 'Start';
    if (graph) graph.setPly(state.ply);
    panel.querySelectorAll('.mv.current').forEach(el => el.classList.remove('current'));
    const cur = panel.querySelector(`.mv[data-ply="${state.ply}"]`);
    if (cur) { cur.classList.add('current'); cur.scrollIntoView({ block: 'nearest' }); }
  }

  function showPreview(fen, lastUci) {
    state.preview = { fen, lastUci };
    board.set(fen, { lastMove: lastUci, movableFor: null, shapes: [] });
  }

  // --- actions -------------------------------------------------------------------
  const actions = root.querySelector('#actions');
  function renderActions() {
    actions.innerHTML = readonly ? `
      ${player ? `<span class="chip ${player}">played ${player}</span>` : ''}
      <span class="chip status-${game.status}">${game.status}</span>` : `
      ${!player ? `<span>I played <button class="small" data-color="white">White</button> <button class="small" data-color="black">Black</button></span>` : `<span class="chip ${player}">played ${player}</span>`}
      ${player && !game.analysis ? `<button class="small primary" data-act="analyse">Analyse</button>` : ''}
      ${game.analysis ? `<button class="small" data-act="reanalyse" title="Re-run the engine (clears explanations)">Re-analyse</button>` : ''}
      ${game.analysis && settings.llmProvider !== 'manual' && game.analysis.summary.moments.some(p => !game.explanations?.[p]) ? `<button class="small primary" data-act="explain">Explain moments</button>` : ''}
      <button class="small" data-act="names" title="Fix player names (they must match settings/scout names for detection)">✎ names</button>
      <span class="chip status-${game.status}">${game.status}</span>`;
  }
  renderActions();
  actions.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.color) { ({ game } = await api.setPlayer(id, b.dataset.color, true)); toast('Colour set, analysis queued'); return rerender(); }
      if (b.dataset.act === 'analyse') { await api.analyse(id); toast('Analysis queued'); }
      if (b.dataset.act === 'reanalyse') { if (confirm('Re-run engine analysis? Explanations for this game will be cleared.')) { await api.analyse(id, true); toast('Re-analysis queued'); } }
      if (b.dataset.act === 'explain') { await api.explain(id); toast('Explanations queued'); }
      if (b.dataset.act === 'names') {
        const v = await editNamesDialog({ white: h.White || '', black: h.Black || '', subject: game.subject }, scout);
        if (!v) return;
        if (!v.white || !v.black) return toast('Both names are required', true);
        await api.setNames(id, v.white, v.black, v.subject);
        toast('Names updated');
        window.dispatchEvent(new HashChangeEvent('hashchange')); // header and labels derive from the names: rebuild the view
      }
    } catch (err) { toast(err.message, true); }
  });

  // --- board controls ----------------------------------------------------------------
  root.querySelector('#first').onclick = () => showPly(0);
  root.querySelector('#prev').onclick = () => showPly(state.ply - 1);
  root.querySelector('#next').onclick = () => showPly(state.ply + 1);
  root.querySelector('#last').onclick = () => showPly(game.moves.length);
  root.querySelector('#flip').onclick = () => board.flip();
  const onKey = e => {
    if (e.target.matches('input, textarea') || state.playout) return;
    if (e.key === 'ArrowLeft') { showPly(state.ply - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { showPly(state.ply + 1); e.preventDefault(); }
  };
  document.addEventListener('keydown', onKey);

  // --- tabs ---------------------------------------------------------------------------
  root.querySelector('.tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    state.tab = b.dataset.tab; renderPanel();
  });

  function renderPanel() {
    if (state.playout) return renderPlayout();
    root.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
    if (state.tab === 'moves') renderMoves();
    else if (state.tab === 'summary') renderSummary();
    else renderMoments();
  }

  function renderMoves() {
    const ms = moves();
    let html = '<div class="moves">';
    for (let i = 0; i < ms.length; i += 2) {
      const w = ms[i], b = ms[i + 1];
      const cell = m => m ? `<div class="mv ${game.analysis ? m.judgment : ''} ${m.ply === state.ply ? 'current' : ''}" data-ply="${m.ply}"><span>${esc(m.san)}${game.analysis ? JUDGE_MARK[m.judgment] : ''}</span>${game.analysis ? `<span class="ev">${formatEval(m.evalAfter)}</span>` : ''}</div>` : '<div></div>';
      html += `<div class="num">${w.moveNumber}.</div>${cell(w)}${cell(b)}`;
    }
    panel.innerHTML = html + '</div>' + (game.analysis ? `<p><small>Marks: ?! inaccuracy, ? mistake, ?? blunder (by win-probability loss). Evaluations from White's side.</small></p>` : '');
    panel.querySelector('.moves').addEventListener('click', e => {
      const mv = e.target.closest('.mv[data-ply]'); if (mv) showPly(Number(mv.dataset.ply));
    });
  }

  function renderSummary() {
    if (!game.analysis) { panel.innerHTML = '<div class="empty">Not analysed yet.</div>'; return; }
    const s = game.analysis.summary;
    const row = (label, color) => {
      const p = s[color];
      return `<tr><td>${esc(label)} <span class="chip ${color}">${color}</span></td><td class="num">${p.accuracy}%</td><td class="num">${p.acpl}</td>
        ${['opening', 'middlegame', 'endgame'].map(ph => `<td class="num">${p.byPhase[ph] ? p.byPhase[ph].accuracy + '%' : '–'}</td>`).join('')}
        <td class="num">${p.inaccuracies} / ${p.mistakes} / ${p.blunders}</td></tr>`;
    };
    const gs = game.gameSummary;
    panel.innerHTML = `
      ${gs ? `<div class="card"><p>${esc(gs.summary)}</p><p><b>Lesson:</b> ${esc(gs.lesson)}</p><p><b>Opening:</b> ${esc(gs.opening_note)}</p></div>` : `<div class="card muted">Game summary appears after the explanation step.</div>`}
      <h3>Accuracy</h3>
      <table><thead><tr><th>Player</th><th class="num">Accuracy</th><th class="num">ACPL</th><th class="num">Opening</th><th class="num">Middlegame</th><th class="num">Endgame</th><th class="num">?! / ? / ??</th></tr></thead>
      <tbody>${row(h.White || 'White', 'white')}${row(h.Black || 'Black', 'black')}</tbody></table>
      <p><small>${esc(s.engine || 'Stockfish')}, depth ${s.depth}, MultiPV ${s.multipv}. Analysed ${esc((game.analysis.analysedAt || '').slice(0, 16).replace('T', ' '))}.</small></p>
      ${game.lastError ? `<p style="color: var(--critical)"><small>Last error: ${esc(game.lastError)}</small></p>` : ''}`;
  }

  function renderMoments() {
    if (!game.analysis) {
      panel.innerHTML = `<div class="empty">${player ? 'Not analysed yet. Click Analyse above.' : 'Set which colour you played, then analyse.'}</div>`;
      return;
    }
    const plies = game.analysis.summary.moments;
    if (!plies.length) { panel.innerHTML = '<div class="empty">No critical moments for the player at the current threshold. Clean game.</div>'; return; }
    let html = '';
    if (state.moment) html += renderGuessPanel();
    html += plies.map(ply => {
      const m = moves()[ply - 1];
      const e = game.explanations?.[ply];
      return `<div class="moment ${state.moment === ply ? 'active' : ''}" data-ply="${ply}">
        <div class="title">${esc(moveLabel(m))} <span class="chip ${m.judgment}">${m.judgment}</span> <span class="chip">${m.phase}</span>
          ${e ? `<span class="chip cat">${esc(e.category)}</span>${e.time_pressure ? '<span class="chip">clock</span>' : ''}` : '<span class="chip muted">not explained</span>'}</div>
        <div class="sub">${formatEval(m.evalBefore)} → ${formatEval(m.evalAfter)}, lost ${m.loss} win-% · engine: ${esc(m.bestSan || '?')}${e ? ` · <b>${esc(e.pattern)}</b>` : ''}</div>
      </div>`;
    }).join('');
    panel.innerHTML = html;
    panel.querySelectorAll('.moment').forEach(el => el.addEventListener('click', () => openMoment(Number(el.dataset.ply))));
    bindGuessPanel();
  }

  // --- guess-first flow --------------------------------------------------------------
  function openMoment(ply) {
    state.moment = ply;
    // A scout mistake on the game's final move has no analysed reply to guess into.
    const guessable = !scout || !!moves()[ply];
    state.guess = { ply, status: guessable ? 'guessing' : 'revealed', tried: null, verdict: null, attempts: 0 };
    renderPanel();
    showPly(scout ? ply : ply - 1);
    if (seat && board.orientation !== seat) board.orient(seat);
    panel.querySelector('.guess')?.scrollIntoView({ block: 'nearest' });
  }

  // --- play it out: finish the position against a strength-limited engine -------
  // Single-move drills cannot train conversion or defence; playing the position
  // out can. The engine answers at a fixed Elo and evals stay hidden until the
  // player asks for the verdict.
  function defaultElo() {
    const oppElo = Number((seat === 'white' ? h.BlackElo : h.WhiteElo) || 0);
    return Math.min(3190, Math.max(1320, oppElo || settings.playerRating || 2000));
  }

  function startPlayout() {
    const g = state.guess;
    const t = scout ? (moves()[g.ply] || moves()[g.ply - 1]) : moves()[g.ply - 1];
    state.playout = { fen: t.fenBefore, sans: [], elo: defaultElo(), over: null, busy: false, startEval: t.evalBefore, assess: null };
    renderPanel();
    board.set(t.fenBefore, { movableFor: seat, shapes: [] });
  }

  function stopPlayout() {
    state.playout = null;
    renderPanel();
    showPly(state.ply);
  }

  async function playoutMove(orig, dest) {
    const p = state.playout;
    if (p.busy || p.over) return;
    const res = await applyMove(p.fen, orig, dest);
    if (!res) return board.set(p.fen, { movableFor: seat });
    p.fen = res.fen; p.sans.push(res.san); p.assess = null;
    let status = gameStatus(res.fen);
    if (status.over) { p.over = status; board.set(p.fen, { lastMove: res.uci }); return renderPanel(); }
    p.busy = true;
    board.set(p.fen, { lastMove: res.uci });
    renderPanel();
    try {
      const r = await api.playoutMove(p.fen, p.elo);
      if (state.playout !== p) return; // stopped while the engine was thinking
      p.fen = r.fen; p.sans.push(r.san);
      status = gameStatus(r.fen);
      if (status.over) p.over = status;
      p.busy = false;
      board.set(p.fen, { lastMove: r.uci, movableFor: p.over ? null : seat });
      renderPanel();
    } catch (err) {
      if (state.playout !== p) return;
      p.busy = false;
      toast(err.message, true);
      board.set(p.fen, { movableFor: seat });
      renderPanel();
    }
  }

  async function assessPlayout() {
    const p = state.playout;
    if (p.busy) return;
    p.busy = true;
    renderPanel();
    try {
      const r = await api.playoutAssess(p.fen);
      if (state.playout !== p) return;
      p.assess = r;
    } catch (err) { toast(err.message, true); }
    if (state.playout === p) { p.busy = false; renderPanel(); }
  }

  function renderPlayout() {
    const p = state.playout;
    root.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
    const wpFor = cp => seat === 'white' ? winProb(cp) : 100 - winProb(cp);
    const startWp = wpFor(p.startEval).toFixed(0);
    let result = '';
    if (p.over) {
      const text = p.over.over === 'checkmate'
        ? (p.over.winner === seat ? 'Checkmate: you converted it.' : 'Checkmate against you.')
        : (p.over.over === 'stalemate' ? 'Stalemate.' : 'Drawn.');
      result = `<div class="result ${p.over.over === 'checkmate' && p.over.winner === seat ? 'good' : 'bad'}">${text}</div>`;
    } else if (p.assess) {
      const nowWp = (seat === 'white' ? p.assess.wp : 100 - p.assess.wp).toFixed(0);
      const held = Number(nowWp) >= Number(startWp) - WP_ACCEPT;
      result = `<div class="result ${held ? 'good' : 'bad'}">Engine verdict: ${formatEval(p.assess.cp)}. Your winning chances: ${nowWp}% (started at ${startWp}%).${held ? '' : ' Ground given up.'}</div>`;
    }
    panel.innerHTML = `<div class="guess">
      <div class="row" style="justify-content: space-between">
        <b>Playing it out: you are ${seat}, engine at ~${p.elo} Elo</b>
        <span><button class="small" data-po="assess" ${p.busy || p.over ? 'disabled' : ''}>Assess position</button> <button class="small" data-po="stop">${p.over ? 'Done' : 'Stop'}</button></span>
      </div>
      <p class="muted">Started at ${formatEval(p.startEval)} (${startWp}% for you). Play on the board; evals stay hidden until you assess or the game ends.</p>
      ${p.sans.length ? `<p style="font-variant-numeric: tabular-nums">${esc(p.sans.join(' '))}</p>` : ''}
      ${p.busy ? '<p class="muted">Engine is thinking…</p>' : ''}
      ${result}
      <label class="field" style="margin-top: 8px; max-width: 220px"><span>Engine Elo (1320 to 3190)</span><input type="number" data-po="elo" value="${p.elo}" min="1320" max="3190"></label>
    </div>`;
    panel.querySelector('[data-po="stop"]').onclick = stopPlayout;
    panel.querySelector('[data-po="assess"]').onclick = assessPlayout;
    panel.querySelector('[data-po="elo"]').onchange = e => { p.elo = Math.min(3190, Math.max(1320, Number(e.target.value) || p.elo)); };
  }

  async function onUserMove(orig, dest) {
    if (state.playout) return playoutMove(orig, dest);
    const g = state.guess;
    if (!g || (g.status !== 'guessing' && g.status !== 'retry')) return;
    const m = moves()[g.ply - 1];
    // For scouting, the guess is played in the position AFTER the mistake, and is
    // checked against the NEXT move's stored lines (the refutation).
    const t = scout ? moves()[g.ply] : m;
    if (!t) return;
    const res = await applyMove(t.fenBefore, orig, dest);
    if (!res) return showPly(state.ply); // dismissed promotion: undo the visual drop
    g.tried = res;
    g.attempts++;
    const rank = t.lines.findIndex(l => l.uci === res.uci);
    const sign = t.color === 'white' ? 1 : -1;
    // Record the attempt: correct first-try guesses start this drill higher up the
    // ladder. For off-list moves this must wait for the quick eval, or a playable
    // guess would be recorded as wrong while the engine is still checking it.
    const record = good => api.guess(id, g.ply, res.uci, good).catch(() => {});
    let recordLater = false;
    const revealShapes = () => board.shapes(lineShapes(t.lines, scout ? t.uci : m.uci));
    if (res.uci === t.bestUci || rank === 0) g.verdict = { good: true, text: `${res.san}: the engine's first choice (${formatEval(t.lines[0]?.cp ?? t.evalBefore)}).` };
    else if (rank > 0) {
      const wpDiff = winProb(t.lines[0].cp * sign) - winProb(t.lines[rank].cp * sign);
      g.verdict = { good: wpDiff <= WP_ACCEPT, text: `${res.san}: engine line ${rank + 1} (${formatEval(t.lines[rank].cp)}, ${wpDiff.toFixed(1)} win-% behind ${t.lines[0].san[0]}).` };
    } else if (res.uci === t.uci) g.verdict = scout
      ? { good: false, text: `${res.san}: that is what was played in the game, but the engine found stronger: ${t.bestSan}.` }
      : { good: false, text: `${res.san}: that is the move played in the game, which the engine marks as ${m.judgment === 'inaccuracy' ? 'an' : 'a'} ${m.judgment}.` };
    else {
      recordLater = true;
      const verdict = g.verdict = { good: false, text: `${res.san}: not among the engine's top ${t.lines.length} lines. Checking with the engine…` };
      // Quick engine eval so an off-list guess gets a real answer (best effort).
      api.evalMove(id, scout ? g.ply + 1 : g.ply, res.uci).then(r => {
        verdict.good = r.wpDiff <= WP_ACCEPT;
        verdict.text = `${res.san}: quick eval ${formatEval(r.cp * (t.color === 'white' ? 1 : -1))}, ${r.wpDiff.toFixed(1)} win-% behind the best move.${verdict.good ? ' Playable.' : ''}`;
        record(verdict.good);
        if (state.guess?.verdict !== verdict) return;
        // A retry that the engine then calls playable is settled: reveal.
        if (verdict.good && state.guess.status === 'retry') { state.guess.status = 'revealed'; revealShapes(); }
        renderPanel();
      }).catch(() => {
        verdict.text = `${res.san}: not among the engine's top ${t.lines.length} lines.`;
        record(false);
        if (state.guess?.verdict === verdict) renderPanel();
      });
    }
    if (!recordLater) record(g.verdict.good);
    // A missed first attempt earns one retry: the verdict shows, the engine
    // lines stay hidden, and the position resets for another go.
    if (!g.verdict.good && g.attempts === 1) {
      g.status = 'retry';
      renderPanel();
      showPly(scout ? g.ply : g.ply - 1);
      return;
    }
    g.status = 'revealed';
    renderPanel();
    showPreview(res.fen, res.uci);
    revealShapes();
  }

  function renderGuessPanel() {
    const g = state.guess;
    const m = moves()[g.ply - 1];
    const t = scout ? (moves()[g.ply] || m) : m; // whose fenBefore the guess plays in
    const e = game.explanations?.[g.ply];
    const side = t.color === 'white' ? 'White' : 'Black';
    if (g.status === 'guessing' || g.status === 'retry') {
      // No eval shown while guessing: "you are much better here" answers half
      // the question. The clock is context, not a hint.
      return `<div class="guess">
        <div class="row" style="justify-content: space-between"><b>${scout ? `${esc(game.subject || 'They')} played ${esc(moveLabel(m))} <span class="chip ${m.judgment}">${m.judgment}</span>. ${side} to move: find the punishment.` : `${esc(movePrefix(m))} ${side} to move. Find the best move.`}</b>
          <span><button class="small" data-g="reveal">Show answer</button> <button class="small" data-g="close">Close</button></span></div>
        ${g.status === 'retry' && g.verdict
          ? `<div class="result bad">${esc(g.verdict.text)}</div><p class="muted">One more try: play a different move, or show the answer.</p>`
          : `<p class="muted">Play your move on the board.${m.clock != null ? ` Clock in the game: ${fmtClock(m.clock)}.` : ''}</p>`}
      </div>`;
    }
    const lines = t.lines.map((l, i) => `<li class="${l.uci === t.uci ? 'played' : ''}" data-line="${i}">
      <span class="ev">${formatEval(l.cp)}</span>
      <span>${l.san.map((s, j) => `<span class="san" data-line="${i}" data-idx="${j}" style="cursor:pointer">${j === 0 || (t.color === 'white' ? j % 2 === 0 : j % 2 === 1) ? `<span class="muted">${t.moveNumber + Math.floor((j + (t.color === 'white' ? 0 : 1)) / 2)}.</span>` : ''}${esc(s)}</span>`).join(' ')}</span>
      ${i === 0 ? '<span class="chip">best</span>' : ''}${l.uci === t.uci ? `<span class="chip ${scout ? '' : 'mistake'}">played</span>` : ''}</li>`).join('');
    const nextPly = game.analysis.summary.moments.find(p => p > g.ply);
    return `<div class="guess">
      <div class="row" style="justify-content: space-between"><b>${scout ? `${esc(game.subject || 'They')} played ` : ''}${esc(moveLabel(m))} <span class="chip ${m.judgment}">${m.judgment}</span></b>
        <span>${nextPly ? `<button class="small" data-g="next" data-ply="${nextPly}">Next moment ▶</button>` : ''} <button class="small" data-g="close">Close</button></span></div>
      ${g.verdict ? `<div class="result ${g.verdict.good ? 'good' : 'bad'}">${esc(g.verdict.text)}</div>` : ''}
      <div class="row" style="gap:6px; margin: 6px 0">
        <button class="small" data-g="before">${scout ? 'After their mistake' : 'Position before'}</button>
        ${scout
          ? (moves()[g.ply] ? `<button class="small" data-g="played">Game continued: ${esc(t.san)} (${formatEval(t.evalAfter)})</button>` : '<span class="muted">The game ended here.</span>')
          : `<button class="small" data-g="played">Played: ${esc(m.san)} (${formatEval(m.evalAfter)})</button>`}
        ${!readonly && engineOk ? `<button class="small" data-g="playout" title="Finish the position against a strength-limited engine">Play it out</button>` : ''}
      </div>
      <ul class="lines">${lines}</ul>
      <p class="muted" style="font-size:13px">Click a move in a line to see it on the board. Green arrow: engine's choice. Red: the move played.</p>
      ${e ? `<div class="explanation">
          <div class="row"><span class="chip cat">${esc(e.category)}</span> <b>${esc(e.pattern)}</b> ${e.time_pressure ? '<span class="chip">likely time pressure</span>' : ''}</div>
          <p>${esc(e.explanation)}</p>
          <div class="kq">Ask yourself: ${esc(e.key_question)}</div>
          ${e.concept ? `<p><small>Concept to study: ${esc(e.concept)}</small></p>` : ''}
          <div class="row" style="margin-top: 6px; gap: 6px"><small class="muted">Was this explanation useful?</small>
            <button class="small${feedback[g.ply]?.helpful === true ? ' primary' : ''}" data-g="fb-yes">Yes</button>
            <button class="small${feedback[g.ply]?.helpful === false ? ' primary' : ''}" data-g="fb-no">Not really</button>
            ${feedback[g.ply]?.helpful === false && !readonly && settings.llmProvider !== 'manual' ? `<button class="small" data-g="reexplain" title="Ask for a better explanation; the rejected one is quoted in the prompt">Re-explain (about a minute)</button>` : ''}</div>
        </div>` : renderNoExplanation(g.ply)}
    </div>`;
  }

  function renderNoExplanation(ply) {
    if (readonly) return '<div class="explanation muted">No explanation yet. It will appear on the next publish from the home machine.</div>';
    if (settings.llmProvider === 'manual') {
      return `<div class="explanation">
        <p class="muted">Manual LLM mode. Copy the prompt into Claude (or any assistant), then paste the JSON answer below.</p>
        <div class="row"><button class="small" data-g="copyprompt">Copy prompt</button> <button class="small" data-g="showprompt">Show prompt</button></div>
        <pre class="prompt" id="prompt-${ply}" hidden></pre>
        <textarea id="paste-${ply}" placeholder='{"pattern": "...", "category": "tactics-allowed", "time_pressure": false, "explanation": "...", "key_question": "...", "concept": "..."}' style="margin-top:8px"></textarea>
        <button class="small primary" data-g="saveexp" style="margin-top:6px">Save explanation</button>
      </div>`;
    }
    return `<div class="explanation muted">No explanation yet. ${game.status === 'analysing' ? 'Analysis in progress.' : 'Use "Explain moments" above, or wait for the queued job.'}</div>`;
  }

  function bindGuessPanel() {
    const gp = panel.querySelector('.guess'); if (!gp) return;
    const g = state.guess;
    const m = moves()[g.ply - 1];
    const t = scout ? (moves()[g.ply] || m) : m;
    const guessPly = scout ? g.ply : g.ply - 1; // the ply whose position the guess plays in
    gp.addEventListener('click', async e => {
      const san = e.target.closest('.san[data-line]');
      if (san) {
        const line = t.lines[Number(san.dataset.line)];
        const step = walkSans(t.fenBefore, line.san)[Number(san.dataset.idx)];
        if (step) showPreview(step.fen, step.uci);
        return;
      }
      const b = e.target.closest('button[data-g]'); if (!b) return;
      const act = b.dataset.g;
      if (act === 'close') { state.moment = null; state.guess = null; renderPanel(); showPly(state.ply); }
      if (act === 'reveal') { g.status = 'revealed'; g.verdict = null; renderPanel(); showPly(guessPly); board.shapes(lineShapes(t.lines, scout ? t.uci : m.uci)); }
      if (act === 'next') openMoment(Number(b.dataset.ply));
      if (act === 'playout') startPlayout();
      if (act === 'fb-yes' || act === 'fb-no') {
        try {
          await api.feedback(id, g.ply, act === 'fb-yes');
          feedback[g.ply] = { helpful: act === 'fb-yes' };
          renderPanel();
        } catch (err) { toast(err.message, true); }
      }
      if (act === 'reexplain') {
        b.disabled = true; b.textContent = 'Re-explaining…';
        try {
          ({ game } = await api.reexplain(id, g.ply));
          delete feedback[g.ply]; // the new explanation starts unrated
          toast('Explanation replaced');
          renderPanel();
        } catch (err) {
          toast(err.message, true);
          b.disabled = false; b.textContent = 'Re-explain (about a minute)';
        }
      }
      if (act === 'before') { showPly(guessPly); board.shapes(lineShapes(t.lines, scout ? t.uci : m.uci)); }
      if (act === 'played') { showPly(guessPly + 1); }
      if (act === 'copyprompt' || act === 'showprompt') {
        const { system, prompt } = await api.prompt(id, g.ply);
        const text = `SYSTEM:\n${system}\n\nUSER:\n${prompt}\n\nAnswer with JSON only, fields: pattern, category (one of tactics-allowed, tactics-missed, calculation, positional, opening, endgame-technique, conversion, defence), time_pressure (boolean), explanation, key_question, concept.`;
        if (act === 'copyprompt') { await navigator.clipboard.writeText(text); toast('Prompt copied'); }
        else { const pre = gp.querySelector(`#prompt-${g.ply}`); pre.textContent = text; pre.hidden = false; }
      }
      if (act === 'saveexp') {
        try {
          const parsed = JSON.parse(gp.querySelector(`#paste-${g.ply}`).value.replace(/^```(?:json)?/m, '').replace(/```$/m, ''));
          ({ game } = await api.saveExplanation(id, g.ply, parsed));
          toast('Explanation saved'); renderPanel(); renderActions();
        } catch (err) { toast('Could not save: ' + err.message, true); }
      }
    });
  }

  // --- refresh on job completion -----------------------------------------------------
  async function rerender() {
    ({ game, feedback = {} } = await api.game(id));
    renderActions();
    root.querySelector('[data-tab="moments"]').textContent = `Critical moments${game.analysis ? ` (${game.analysis.summary.moments.length})` : ''}`;
    if (game.analysis) graph = evalGraph(root.querySelector('#graph'), game.analysis.moves, { currentPly: state.ply, onSelect: ply => showPly(ply), timeControl: h.TimeControl });
    renderPanel();
    if (!state.playout) showPly(state.ply); // a job finishing must not clobber a live play-out board
  }
  const { jobEvents } = await import('../app.js');
  const onFinished = e => { if (e.detail.some(j => j.gameId === id)) rerender().catch(() => {}); };
  jobEvents.addEventListener('finished', onFinished);

  // --- initial render -------------------------------------------------------------
  if (game.analysis) graph = evalGraph(root.querySelector('#graph'), game.analysis.moves, { currentPly: 0, onSelect: ply => showPly(ply), timeControl: h.TimeControl });
  renderPanel();
  if (startPly && game.analysis && game.analysis.summary.moments.includes(Number(startPly))) openMoment(Number(startPly));
  else showPly(startPly ? Number(startPly) : 0);

  return { destroy: () => { board.destroy(); document.removeEventListener('keydown', onKey); jobEvents.removeEventListener('finished', onFinished); } };
}
