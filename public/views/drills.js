// Drills: replay your own critical moments, spaced repetition.
import { api, esc, toast, formatEval } from '../api.js';
import { Board, applyMove, lineShapes } from '../board.js';

export async function drillsView(root) {
  let { due, total, dueCount } = await api.drills();
  let idx = 0;
  let board = null;
  let state = null; // { drill, status, verdict, game }

  root.innerHTML = `
    <div class="row" style="justify-content: space-between"><h1 style="margin:0">Drills</h1><span class="muted" id="counts"></span></div>
    <p class="muted">Positions from your own games where you went wrong. Find the engine's move, then grade how well you knew it. Correct moves move up the ladder (1, 3, 7, 14, 30, 60 days); a miss resets it.</p>
    <div id="drill"></div>`;
  const el = root.querySelector('#drill');
  const counts = root.querySelector('#counts');

  async function load() {
    if (idx >= due.length) {
      if (due.length) {
        // The server serves due drills in batches of 20; check for the rest.
        ({ due, total, dueCount } = await api.drills());
        idx = 0;
        if (due.length) return load();
      }
      counts.textContent = `${total} drill${total === 1 ? '' : 's'} total`;
      el.innerHTML = `<div class="card"><div class="empty">${total ? 'Nothing due right now. Come back later.' : 'No drills yet. Drills are created from mistakes and blunders when games are analysed.'}</div></div>`;
      board?.destroy();
      board = null;
      state = null; // stray keypresses must not re-grade the last drill
      return;
    }
    const drill = due[idx];
    counts.textContent = `${dueCount - idx} due · ${total} total`;
    state = { drill, status: 'guessing', verdict: null, game: null };
    el.innerHTML = `<div class="drill-layout">
      <div>
        <div class="board-wrap"><div id="dboard"></div></div>
        <p class="muted" style="margin-top:8px"><small>${esc(drill.label)} · ${drill.phase} · <a href="#/game/${drill.gameId}/${drill.ply}">open game</a></small></p>
      </div>
      <div id="dpanel"></div>
    </div>`;
    board?.destroy();
    board = new Board(el.querySelector('#dboard'), { orientation: drill.sideToMove, onMove });
    board.set(drill.fen, { movableFor: drill.sideToMove });
    renderPanel();
  }

  function onMove(orig, dest) {
    if (!state || state.status !== 'guessing') return;
    const d = state.drill;
    const res = applyMove(d.fen, orig, dest);
    if (!res) return;
    const correct = d.acceptedUci.includes(res.uci);
    const rank = d.lines.findIndex(l => l.uci === res.uci);
    let text;
    if (res.uci === d.bestUci) text = `${res.san}: correct, the engine's first choice.`;
    else if (correct) text = `${res.san}: accepted (engine line ${rank + 1}, within 0.30 of the best move ${d.bestSan}).`;
    else if (res.uci === d.playedUci) text = `${res.san}: that is what you played in the game (${d.judgment}). Engine: ${d.bestSan}.`;
    else if (rank > 0) text = `${res.san}: engine line ${rank + 1}, but clearly worse than ${d.bestSan}.`;
    else text = `${res.san}: not among the engine's top lines. Engine: ${d.bestSan}.`;
    state.status = 'revealed';
    state.verdict = { correct, text };
    board.set(res.fen, { lastMove: res.uci, shapes: lineShapes(d.lines, d.playedUci) });
    renderPanel();
    api.game(d.gameId).then(({ game }) => { state.game = game; renderPanel(); }).catch(() => {});
  }

  function renderPanel() {
    const d = state.drill;
    const p = el.querySelector('#dpanel');
    const side = d.sideToMove === 'white' ? 'White' : 'Black';
    if (state.status === 'guessing') {
      p.innerHTML = `<div class="guess"><b>${side} to move. Find the best move.</b>
        <p class="muted">Drill ${idx + 1} of ${due.length}. <span class="chip ${d.judgment}">${d.judgment} in the game</span></p>
        <button class="small" id="giveup">Show answer</button></div>`;
      p.querySelector('#giveup').onclick = () => { state.status = 'revealed'; state.verdict = { correct: false, text: `Engine: ${d.bestSan}.` }; board.set(d.fen, { shapes: lineShapes(d.lines, d.playedUci) }); renderPanel(); api.game(d.gameId).then(({ game }) => { state.game = game; renderPanel(); }).catch(() => {}); };
      return;
    }
    const e = state.game?.explanations?.[d.ply];
    p.innerHTML = `<div class="guess">
      <div class="result ${state.verdict.correct ? 'good' : 'bad'}">${esc(state.verdict.text)}</div>
      <ul class="lines">${d.lines.map((l, i) => `<li class="${l.uci === d.playedUci ? 'played' : ''}"><span class="ev">${formatEval(l.cp)}</span><span>${esc(l.san.join(' '))}</span>${i === 0 ? '<span class="chip">best</span>' : ''}${l.uci === d.playedUci ? '<span class="chip mistake">played</span>' : ''}</li>`).join('')}</ul>
      ${e ? `<div class="explanation"><div class="row"><span class="chip cat">${esc(e.category)}</span> <b>${esc(e.pattern)}</b></div><p>${esc(e.explanation)}</p><div class="kq">Ask yourself: ${esc(e.key_question)}</div></div>` : (state.game ? '<p class="muted">No explanation for this moment yet.</p>' : '')}
      <div class="row" style="margin-top: 12px">
        <span class="muted">How well did you know it?</span>
        <button data-grade="again">Again <span class="kbd">1</span></button>
        <button data-grade="good">Good <span class="kbd">2</span></button>
        <button data-grade="easy">Easy <span class="kbd">3</span></button>
      </div>
    </div>`;
    p.querySelectorAll('button[data-grade]').forEach(b => b.onclick = () => grade(b.dataset.grade));
  }

  let grading = false;
  async function grade(g) {
    if (!state || state.status !== 'revealed' || grading) return; // no double-grades from rapid clicks/keys
    grading = true;
    try {
      await api.reviewDrill(state.drill.id, g, state.verdict.correct);
      import('../app.js').then(m => m.updateDrillBadge());
      idx++;
      await load();
    } catch (err) { toast(err.message, true); }
    finally { grading = false; }
  }

  const onKey = e => {
    if (!state || state.status !== 'revealed' || e.target.matches('input, textarea')) return;
    const map = { 1: 'again', 2: 'good', 3: 'easy' };
    if (map[e.key]) grade(map[e.key]);
  };
  document.addEventListener('keydown', onKey);
  await load();
  return { destroy: () => { board?.destroy(); document.removeEventListener('keydown', onKey); } };
}
