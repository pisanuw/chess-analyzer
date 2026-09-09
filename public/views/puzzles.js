// Puzzles: free-solve positions derived from your games. Switch the source, find
// the move, keep a session streak. Deliberately NOT spaced repetition (that is
// Drills): nothing is scheduled and nothing is written to the server, so this
// view works unchanged on the read-only hosted mirror.
import { api, esc, toast, formatEval } from '../api.js';
import { Board, applyMove, lineShapes } from '../board.js';

const SOURCES = [
  { key: 'tactics', label: 'Decisive tactics', blurb: 'Winning shots from every game (both sides, your games and opponents\'). Find the move.' },
  { key: 'moments', label: 'Critical moments', blurb: 'The moments flagged in your own games, the same pool Drills draws from.' },
  { key: 'missed', label: 'Missed tactics', blurb: 'Winning tactics you had on the board but did not find in the game.' },
];

export async function puzzlesView(root, query) {
  const params = new URLSearchParams(query || '');
  const source = SOURCES.some(s => s.key === params.get('source')) ? params.get('source') : 'tactics';
  const spec = SOURCES.find(s => s.key === source);

  let puzzles = [], total = 0, idx = 0;
  let board = null;
  let state = null; // { puzzle, status: 'solving'|'revealed', correct, missed, tryAgain, startedAt, answerMs }
  const session = { solved: 0, attempts: 0, streak: 0, best: 0 };

  root.innerHTML = `
    <div class="row" style="justify-content: space-between"><h1 style="margin:0">Puzzles</h1>
      <span class="muted" id="score"></span></div>
    <div class="row" id="sources" style="gap:6px; margin: 4px 0 2px">
      ${SOURCES.map(s => `<button class="small${s.key === source ? ' primary' : ''}" data-src="${s.key}">${esc(s.label)}</button>`).join('')}
    </div>
    <p class="muted">${esc(spec.blurb)} Free solve: nothing is scheduled. For tracked, spaced review of your own mistakes, use <a href="#/drills">Drills</a>.</p>
    <div id="puzzle"></div>`;
  const el = root.querySelector('#puzzle');
  const scoreEl = root.querySelector('#score');
  root.querySelectorAll('button[data-src]').forEach(b => b.onclick = () => {
    if (b.dataset.src !== source) location.hash = `#/puzzles?source=${b.dataset.src}`;
  });

  function renderScore() {
    scoreEl.textContent = session.attempts
      ? `${session.solved}/${session.attempts} solved · streak ${session.streak}${session.best > session.streak ? ` (best ${session.best})` : ''}`
      : '';
  }

  try {
    ({ puzzles = [], total = 0 } = await api.puzzles({ source, limit: 30 }));
  } catch (err) {
    el.innerHTML = `<div class="card"><b>Error:</b> ${esc(err.message)}</div>`;
    return {};
  }

  function next() { idx++; load(); }

  /** Finalise the current puzzle. A clean first-try solve extends the streak; a
   * miss or a shown answer breaks it. The correct answer is always solvable, so
   * "attempts" counts puzzles resolved, "solved" the ones eventually found. */
  function resolve(correct) {
    state.status = 'revealed';
    state.correct = correct;
    if (state.answerMs == null) state.answerMs = Date.now() - state.startedAt;
    session.attempts++;
    if (correct) {
      session.solved++;
      if (!state.missed) { session.streak++; session.best = Math.max(session.best, session.streak); }
    } else session.streak = 0;
    renderScore();
    renderPanel();
  }

  async function onMove(orig, dest) {
    if (!state || state.status !== 'solving') return;
    const p = state.puzzle;
    const res = await applyMove(p.fen, orig, dest);
    if (!res) return board.set(p.fen, { movableFor: p.sideToMove }); // dismissed promotion
    if (state.answerMs == null) state.answerMs = Date.now() - state.startedAt; // time to the first answer
    if (p.acceptedUci.includes(res.uci)) {
      board.set(res.fen, { lastMove: res.uci, shapes: lineShapes(p.lines, p.playedUci) });
      resolve(true);
    } else {
      // Free solve: a wrong move is not fatal, keep trying. But it breaks the
      // streak and marks the eventual solve as unclean.
      state.missed = true;
      session.streak = 0;
      renderScore();
      state.tryAgain = `${res.san} is not it. Try again.`;
      board.set(p.fen, { movableFor: p.sideToMove });
      renderPanel();
    }
  }

  function giveup() {
    const p = state.puzzle;
    board.set(p.fen, { shapes: lineShapes(p.lines, p.playedUci) });
    resolve(false);
  }

  function load() {
    if (idx >= puzzles.length) return renderEnd();
    const p = puzzles[idx];
    state = { puzzle: p, status: 'solving', correct: null, missed: false, tryAgain: null, startedAt: Date.now(), answerMs: null };
    el.innerHTML = `<div class="drill-layout">
      <div>
        <div class="board-wrap"><div id="pboard"></div></div>
        <p class="muted" style="margin-top:8px"><small>${esc(p.label)} · ${p.phase} · <a href="#/game/${p.gameId}/${p.ply}">open game</a></small></p>
      </div>
      <div id="ppanel"></div>
    </div>`;
    board?.destroy();
    board = new Board(el.querySelector('#pboard'), { orientation: p.orientation, onMove });
    board.set(p.fen, { movableFor: p.sideToMove });
    renderPanel();
  }

  function renderPanel() {
    const p = state.puzzle;
    const pane = el.querySelector('#ppanel');
    const side = p.sideToMove === 'white' ? 'White' : 'Black';
    if (state.status === 'solving') {
      pane.innerHTML = `<div class="guess">
        <b>${side} to move. Find the best move.</b>
        <p class="muted">Puzzle ${idx + 1} of ${puzzles.length}${total > puzzles.length ? ` · ${total} in the pool` : ''}.</p>
        ${state.tryAgain ? `<div class="result bad">${esc(state.tryAgain)}</div>` : ''}
        <button class="small" id="giveup">Show answer</button></div>`;
      pane.querySelector('#giveup').onclick = giveup;
      return;
    }
    const playedNote = p.playedUci === p.bestUci
      ? 'The best move was the one played in the game.'
      : `In the game ${p.playedByPlayer ? 'you' : 'the side to move'} played ${esc(p.playedSan)}${p.playedByPlayer ? ` (${p.judgment})` : ''}.`;
    const answeredIn = state.answerMs != null ? ` · answered in ${Math.round(state.answerMs / 1000)}s` : '';
    pane.innerHTML = `<div class="guess">
      <div class="result ${state.correct ? 'good' : 'bad'}">${state.correct ? `Solved: ${esc(p.bestSan)}.${state.missed ? ' (after a miss)' : ''}` : `The move was ${esc(p.bestSan)}.`}</div>
      <p class="muted" style="margin:6px 0">${playedNote}<small class="muted">${answeredIn}</small></p>
      <ul class="lines">${p.lines.map((l, i) => `<li class="${l.uci === p.playedUci ? 'played' : ''}"><span class="ev">${formatEval(l.cp)}</span><span>${esc(l.san.join(' '))}</span>${i === 0 ? '<span class="chip">best</span>' : ''}${l.uci === p.playedUci ? '<span class="chip">played</span>' : ''}</li>`).join('')}</ul>
      <div class="row" style="margin-top: 12px"><button class="primary" id="next">Next <span class="kbd">N</span></button></div>
    </div>`;
    pane.querySelector('#next').onclick = next;
  }

  function renderEnd() {
    board?.destroy(); board = null; state = null;
    const pct = session.attempts ? Math.round((session.solved / session.attempts) * 100) : 0;
    const empty = source === 'missed'
      ? 'None found: no winning tactics you overlooked in the analysed games. Try another source.'
      : source === 'moments'
        ? 'No flagged moments yet. Analyse some of your own games first.'
        : 'None yet. Puzzles appear once games are analysed.';
    el.innerHTML = `${session.attempts ? `<div class="card" style="margin-bottom:12px"><h3 style="margin-top:0">Set done</h3>
        <p>${session.solved} of ${session.attempts} solved (${pct}%). Best streak ${session.best}.</p></div>` : ''}
      <div class="card"><div class="empty">${total
        ? `That is the whole shuffled set. <button class="small" id="again">New set</button>`
        : empty}</div></div>`;
    el.querySelector('#again')?.addEventListener('click', async () => {
      try {
        ({ puzzles = [], total = 0 } = await api.puzzles({ source, limit: 30 }));
        idx = 0;
        load(); // same sitting: keep the running session score
      } catch (err) { toast(err.message, true); }
    });
  }

  const onKey = e => {
    if (!state || state.status !== 'revealed' || e.target.matches('input, textarea')) return;
    if (e.key === 'n' || e.key === 'N' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); next(); }
  };
  document.addEventListener('keydown', onKey);

  renderScore();
  load();
  return { destroy: () => { board?.destroy(); document.removeEventListener('keydown', onKey); } };
}
