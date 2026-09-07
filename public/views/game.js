// Single game: board, eval graph, moves, critical moments with guess-first reveal, summary.
import { api, esc, toast, formatEval, moveLabel, JUDGE_MARK } from '../api.js';
import { Board, applyMove, walkLine, lineShapes } from '../board.js';
import { evalGraph } from '../charts.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export async function gameView(root, id, startPly) {
  let { game } = await api.game(id);
  const { settings } = await api.settings();
  const state = { ply: 0, tab: 'moments', moment: null, guess: null, preview: null };

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
    state.ply = Math.max(0, Math.min(game.moves.length, ply));
    state.preview = null;
    const m = state.ply ? moves()[state.ply - 1] : null;
    const guessPly = state.guess ? (scout ? state.guess.ply : state.guess.ply - 1) : null;
    const movableFor = state.guess && state.guess.status === 'guessing' && state.ply === guessPly ? seat : null;
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
    actions.innerHTML = `
      ${!player ? `<span>I played <button class="small" data-color="white">White</button> <button class="small" data-color="black">Black</button></span>` : `<span class="chip ${player}">played ${player}</span>`}
      ${player && !game.analysis ? `<button class="small primary" data-act="analyse">Analyse</button>` : ''}
      ${game.analysis ? `<button class="small" data-act="reanalyse" title="Re-run the engine (clears explanations)">Re-analyse</button>` : ''}
      ${game.analysis && settings.llmProvider !== 'manual' && game.analysis.summary.moments.some(p => !game.explanations?.[p]) ? `<button class="small primary" data-act="explain">Explain moments</button>` : ''}
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
    } catch (err) { toast(err.message, true); }
  });

  // --- board controls ----------------------------------------------------------------
  root.querySelector('#first').onclick = () => showPly(0);
  root.querySelector('#prev').onclick = () => showPly(state.ply - 1);
  root.querySelector('#next').onclick = () => showPly(state.ply + 1);
  root.querySelector('#last').onclick = () => showPly(game.moves.length);
  root.querySelector('#flip').onclick = () => board.flip();
  const onKey = e => {
    if (e.target.matches('input, textarea')) return;
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
    state.guess = { ply, status: guessable ? 'guessing' : 'revealed', tried: null, verdict: null };
    renderPanel();
    showPly(scout ? ply : ply - 1);
    if (seat && board.orientation !== seat) board.orient(seat);
    panel.querySelector('.guess')?.scrollIntoView({ block: 'nearest' });
  }

  function onUserMove(orig, dest) {
    const g = state.guess;
    if (!g || g.status !== 'guessing') return;
    const m = moves()[g.ply - 1];
    // For scouting, the guess is played in the position AFTER the mistake, and is
    // checked against the NEXT move's stored lines (the refutation).
    const t = scout ? moves()[g.ply] : m;
    if (!t) return;
    const res = applyMove(t.fenBefore, orig, dest);
    if (!res) return;
    g.tried = res;
    g.status = 'revealed';
    const rank = t.lines.findIndex(l => l.uci === res.uci);
    const sign = t.color === 'white' ? 1 : -1;
    if (res.uci === t.bestUci || rank === 0) g.verdict = { good: true, text: `${res.san}: the engine's first choice (${formatEval(t.lines[0]?.cp ?? t.evalBefore)}).` };
    else if (rank > 0) {
      const diff = ((t.lines[0].cp - t.lines[rank].cp) * sign) / 100;
      g.verdict = { good: diff <= 0.3, text: `${res.san}: engine line ${rank + 1} (${formatEval(t.lines[rank].cp)}, ${diff.toFixed(2)} behind ${t.lines[0].san[0]}).` };
    } else if (res.uci === t.uci) g.verdict = scout
      ? { good: false, text: `${res.san}: that is what was played in the game, but the engine found stronger: ${t.bestSan}.` }
      : { good: false, text: `${res.san}: that is the move played in the game, which the engine marks as ${m.judgment === 'inaccuracy' ? 'an' : 'a'} ${m.judgment}.` };
    else {
      const verdict = g.verdict = { good: false, text: `${res.san}: not among the engine's top ${t.lines.length} lines. Checking with the engine…` };
      // Quick engine eval so an off-list guess gets a real answer (best effort).
      api.evalMove(id, scout ? g.ply + 1 : g.ply, res.uci).then(r => {
        verdict.good = r.diff <= 0.3;
        verdict.text = `${res.san}: quick eval ${formatEval(r.cp * (t.color === 'white' ? 1 : -1))}, ${r.diff.toFixed(2)} behind the best move.${verdict.good ? ' Playable.' : ''}`;
        if (state.guess?.verdict === verdict) renderPanel();
      }).catch(() => {
        verdict.text = `${res.san}: not among the engine's top ${t.lines.length} lines.`;
        if (state.guess?.verdict === verdict) renderPanel();
      });
    }
    // Record the attempt: correct first-try guesses start this drill higher up the ladder.
    api.guess(id, g.ply, res.uci, g.verdict.good).catch(() => {});
    renderPanel();
    showPreview(res.fen, res.uci);
    board.shapes(lineShapes(t.lines, scout ? t.uci : m.uci));
  }

  function renderGuessPanel() {
    const g = state.guess;
    const m = moves()[g.ply - 1];
    const t = scout ? (moves()[g.ply] || m) : m; // whose fenBefore the guess plays in
    const e = game.explanations?.[g.ply];
    const side = t.color === 'white' ? 'White' : 'Black';
    if (g.status === 'guessing') {
      return `<div class="guess">
        <div class="row" style="justify-content: space-between"><b>${scout ? `${esc(game.subject || 'They')} played ${esc(moveLabel(m))} <span class="chip ${m.judgment}">${m.judgment}</span>. ${side} to move: find the punishment.` : `${esc(moveLabel(m).replace(m.san, '').trim())} ${side} to move. Find the best move.`}</b>
          <span><button class="small" data-g="reveal">Show answer</button> <button class="small" data-g="close">Close</button></span></div>
        <p class="muted">Play your move on the board. Eval here: ${formatEval(scout ? m.evalAfter : m.evalBefore)}${m.clock != null ? ` · clock ${fmtClock(m.clock)}` : ''}</p>
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
      </div>
      <ul class="lines">${lines}</ul>
      <p class="muted" style="font-size:13px">Click a move in a line to see it on the board. Green arrow: engine's choice. Red: the move played.</p>
      ${e ? `<div class="explanation">
          <div class="row"><span class="chip cat">${esc(e.category)}</span> <b>${esc(e.pattern)}</b> ${e.time_pressure ? '<span class="chip">likely time pressure</span>' : ''}</div>
          <p>${esc(e.explanation)}</p>
          <div class="kq">Ask yourself: ${esc(e.key_question)}</div>
          ${e.concept ? `<p><small>Concept to study: ${esc(e.concept)}</small></p>` : ''}
        </div>` : renderNoExplanation(g.ply)}
    </div>`;
  }

  function renderNoExplanation(ply) {
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
        const steps = walkLine(t.fenBefore, uciLine(t, line));
        const step = steps[Number(san.dataset.idx)];
        if (step) showPreview(step.fen, step.uci);
        return;
      }
      const b = e.target.closest('button[data-g]'); if (!b) return;
      const act = b.dataset.g;
      if (act === 'close') { state.moment = null; state.guess = null; renderPanel(); showPly(state.ply); }
      if (act === 'reveal') { g.status = 'revealed'; g.verdict = null; renderPanel(); showPly(guessPly); board.shapes(lineShapes(t.lines, scout ? t.uci : m.uci)); }
      if (act === 'next') openMoment(Number(b.dataset.ply));
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

  function uciLine(m, line) {
    // Rebuild the UCI sequence for a line from its SAN list (server stored only the first UCI move).
    const steps = [];
    let fen = m.fenBefore;
    for (const san of line.san) {
      const r = sanToUci(fen, san); if (!r) break;
      steps.push(r.uci); fen = r.fen;
    }
    return steps;
  }

  // --- refresh on job completion -----------------------------------------------------
  async function rerender() {
    ({ game } = await api.game(id));
    renderActions();
    root.querySelector('[data-tab="moments"]').textContent = `Critical moments${game.analysis ? ` (${game.analysis.summary.moments.length})` : ''}`;
    if (game.analysis) graph = evalGraph(root.querySelector('#graph'), game.analysis.moves, { currentPly: state.ply, onSelect: ply => showPly(ply) });
    renderPanel();
    showPly(state.ply);
  }
  const { jobEvents } = await import('../app.js');
  const onFinished = e => { if (e.detail.some(j => j.gameId === id)) rerender(); };
  jobEvents.addEventListener('finished', onFinished);

  // --- initial render -------------------------------------------------------------
  if (game.analysis) graph = evalGraph(root.querySelector('#graph'), game.analysis.moves, { currentPly: 0, onSelect: ply => showPly(ply) });
  renderPanel();
  if (startPly && game.analysis && game.analysis.summary.moments.includes(Number(startPly))) openMoment(Number(startPly));
  else showPly(startPly ? Number(startPly) : 0);

  return { destroy: () => { board.destroy(); document.removeEventListener('keydown', onKey); jobEvents.removeEventListener('finished', onFinished); } };
}

function fmtClock(s) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

import { Chess } from '/vendor/chess.js/chess.js';
function sanToUci(fen, san) {
  try {
    const c = new Chess(fen);
    const m = c.move(san);
    return m ? { uci: m.from + m.to + (m.promotion || ''), fen: c.fen() } : null;
  } catch { return null; }
}
