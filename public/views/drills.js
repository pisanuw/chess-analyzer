// Drills: replay your own critical moments, spaced repetition.
import { api, esc, toast, formatEval } from '../api.js';
import { Board, applyMove, walkSans, lineShapes } from '../board.js';

const MAX_FOLLOWUPS = 2; // player moves asked beyond the first, along the engine's PV

export async function drillsView(root) {
  let { due, total, dueCount } = await api.drills();
  let idx = 0;
  let board = null;
  let state = null; // { drill, status, verdict, game }

  root.innerHTML = `
    <div class="row" style="justify-content: space-between"><h1 style="margin:0">Drills</h1><span class="muted" id="counts"></span></div>
    <p class="muted">Positions from your own games where you went wrong. Find the engine's move, then grade how well you knew it. Correct moves move up the ladder (1, 3, 7, 14, 30, 60 days); a miss comes back at the end of the same session. Sharpener drills are near-miss moments below the mistake threshold.</p>
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
    state = { drill, status: 'guessing', verdict: null, game: null, follow: null };
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

  function loadGame() {
    api.game(state.drill.gameId).then(({ game }) => { state.game = game; renderPanel(); }).catch(() => {});
  }

  function reveal(verdict) {
    state.status = 'revealed';
    state.verdict = verdict;
    renderPanel();
    loadGame();
  }

  /** Continue along the matched engine line: opponent's reply is played for you,
   * then you must find the follow-up. Stops after MAX_FOLLOWUPS or line end. */
  function startFollowUp(steps, idx) {
    state.status = 'follow';
    state.follow = { steps, idx }; // steps[idx] was the player's last correct move
    const reply = steps[idx + 1];
    board.set(reply.fen, { lastMove: reply.uci, movableFor: state.drill.sideToMove });
    renderPanel();
  }

  function onMove(orig, dest) {
    if (!state) return;
    const d = state.drill;
    if (state.status === 'follow') {
      const f = state.follow;
      const res = applyMove(f.steps[f.idx + 1].fen, orig, dest);
      if (!res) return;
      const expected = f.steps[f.idx + 2];
      const done = played => {
        board.set(played.fen, { lastMove: played.uci, shapes: lineShapes(d.lines, d.playedUci) });
        reveal(state.verdict);
      };
      if (expected && res.uci === expected.uci) {
        state.verdict.followUps++;
        state.verdict.foundSans.push(expected.san);
        const more = f.idx + 4 < f.steps.length && state.verdict.followUps < MAX_FOLLOWUPS;
        if (more) return startFollowUp(f.steps, f.idx + 2);
        state.verdict.text += ` Follow-up${state.verdict.followUps > 1 ? 's' : ''} found: ${state.verdict.foundSans.join(', ')}.`;
        return done(res);
      }
      state.verdict.followMiss = `Follow-up: expected ${expected ? expected.san : '?'} after ${f.steps[f.idx + 1].san}, you played ${res.san}.`;
      return done(res);
    }
    if (state.status !== 'guessing') return;
    const res = applyMove(d.fen, orig, dest);
    if (!res) return;
    const correct = d.acceptedUci.includes(res.uci);
    const rank = d.lines.findIndex(l => l.uci === res.uci);
    let text;
    if (res.uci === d.bestUci) text = `${res.san}: correct, the engine's first choice.`;
    else if (correct) text = `${res.san}: accepted (engine line ${rank + 1}, within 0.30 of the best move ${d.bestSan}).`;
    else if (res.uci === d.playedUci) text = d.kind === 'punish' ? `${res.san}: that is what was played in the game, but the engine prefers ${d.bestSan}.` : `${res.san}: that is what you played in the game (${d.judgment}). Engine: ${d.bestSan}.`;
    else if (rank > 0) text = `${res.san}: engine line ${rank + 1}, but clearly worse than ${d.bestSan}.`;
    else text = `${res.san}: not among the engine's top lines. Engine: ${d.bestSan}.`;
    const verdict = { correct, text, followUps: 0, foundSans: [] };
    // Off-list move: ask the server for a quick engine eval (best effort; needs Stockfish).
    if (!correct && rank < 0 && res.uci !== d.playedUci) {
      api.evalMove(d.gameId, d.kind === 'punish' ? d.ply + 1 : d.ply, res.uci).then(r => {
        verdict.text = `${res.san}: quick eval ${formatEval(r.cp * (d.sideToMove === 'white' ? 1 : -1))}, ${r.diff.toFixed(2)} behind ${d.bestSan}.${r.diff <= 0.3 ? ' Close enough to be playable.' : ''}`;
        if (state?.verdict === verdict) renderPanel();
      }).catch(() => {});
    }
    if (correct) {
      // Walk the matched line for follow-up moves before revealing.
      const line = d.lines[rank >= 0 ? rank : 0];
      const steps = line ? walkSans(d.fen, line.san) : [];
      state.verdict = verdict;
      if (steps.length >= 3) return startFollowUp(steps, 0);
    }
    board.set(res.fen, { lastMove: res.uci, shapes: lineShapes(d.lines, d.playedUci) });
    reveal(verdict);
  }

  function renderPanel() {
    const d = state.drill;
    const p = el.querySelector('#dpanel');
    const side = d.sideToMove === 'white' ? 'White' : 'Black';
    const punish = d.kind === 'punish';
    const chips = `<span class="chip ${d.judgment}">${d.judgment}${punish ? '' : ' in the game'}</span>${punish ? ` <span class="chip">punish</span> <span class="chip">vs ${esc(d.subject || '?')}</span>` : ''}${d.tier === 'sharpen' ? ' <span class="chip">sharpener</span>' : ''}${d.category ? ` <span class="chip cat">${esc(d.category)}</span>` : ''}`;
    if (state.status === 'guessing') {
      p.innerHTML = `<div class="guess"><b>${punish ? `${esc(d.subject || 'The opponent')} just played ${esc(d.mistakeSan)}. ${side} to move: find the punishment.` : `${side} to move. Find the best move.`}</b>
        <p class="muted">Drill ${idx + 1} of ${due.length}. ${chips}</p>
        <button class="small" id="giveup">Show answer</button></div>`;
      p.querySelector('#giveup').onclick = () => { board.set(d.fen, { shapes: lineShapes(d.lines, d.playedUci) }); reveal({ correct: false, text: `Engine: ${d.bestSan}.`, followUps: 0, foundSans: [] }); };
      return;
    }
    if (state.status === 'follow') {
      const reply = state.follow.steps[state.follow.idx + 1];
      p.innerHTML = `<div class="guess"><div class="result good">${esc(state.verdict.text)}</div>
        <b>Opponent replies ${esc(reply.san)}. Find the follow-up.</b>
        <p class="muted">Continue the engine's line from memory or calculation.</p>
        <button class="small" id="stopfollow">Show the line</button></div>`;
      p.querySelector('#stopfollow').onclick = () => {
        const expected = state.follow.steps[state.follow.idx + 2];
        state.verdict.followMiss = expected ? `Follow-up was ${expected.san}.` : '';
        board.set(reply.fen, { lastMove: reply.uci, shapes: lineShapes(d.lines, d.playedUci) });
        reveal(state.verdict);
      };
      return;
    }
    const e = state.game?.explanations?.[d.ply];
    // Grading honesty: a wrong answer can only be graded Again.
    const gradeButtons = state.verdict.correct
      ? `<span class="muted">How well did you know it?</span>
         <button data-grade="again">Again <span class="kbd">1</span></button>
         <button data-grade="good">Good <span class="kbd">2</span></button>
         <button data-grade="easy">Easy <span class="kbd">3</span></button>`
      : `<span class="muted">Missed: it comes back at the end of this session.</span>
         <button data-grade="again">Continue <span class="kbd">1</span></button>`;
    p.innerHTML = `<div class="guess">
      <div class="result ${state.verdict.correct ? 'good' : 'bad'}">${esc(state.verdict.text)}</div>
      ${state.verdict.followMiss ? `<div class="result bad">${esc(state.verdict.followMiss)}</div>` : ''}
      <p style="margin: 6px 0">${chips}</p>
      <ul class="lines">${d.lines.map((l, i) => `<li class="${l.uci === d.playedUci ? 'played' : ''}"><span class="ev">${formatEval(l.cp)}</span><span>${esc(l.san.join(' '))}</span>${i === 0 ? '<span class="chip">best</span>' : ''}${l.uci === d.playedUci ? '<span class="chip mistake">played</span>' : ''}</li>`).join('')}</ul>
      ${e ? `<div class="explanation"><div class="row"><span class="chip cat">${esc(e.category)}</span> <b>${esc(e.pattern)}</b></div><p>${esc(e.explanation)}</p><div class="kq">Ask yourself: ${esc(e.key_question)}</div></div>` : (state.game ? '<p class="muted">No explanation for this moment yet.</p>' : '')}
      <div class="row" style="margin-top: 12px">${gradeButtons}</div>
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
    const g = map[e.key];
    if (g && (state.verdict.correct || g === 'again')) grade(g); // wrong answers only grade Again
  };
  document.addEventListener('keydown', onKey);
  await load();
  return { destroy: () => { board?.destroy(); document.removeEventListener('keydown', onKey); } };
}
