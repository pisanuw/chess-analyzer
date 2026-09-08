// Drills: replay your own critical moments, spaced repetition.
import { api, esc, toast, formatEval, fmtClock, WP_ACCEPT } from '../api.js';
import { Board, applyMove, walkSans, lineShapes } from '../board.js';
import { CATEGORY_LABEL } from './report.js';

const MAX_FOLLOWUPS = 2; // player moves asked beyond the first, along the engine's PV

export async function drillsView(root, query) {
  // With ?pattern=..., a lightning round: every drill of one recurring pattern,
  // due or not, back to back (blocked practice for a struggling pattern).
  const lightning = new URLSearchParams(query || '').get('pattern');
  let { due, total, dueCount, feedback = {} } = await api.drills({ pattern: lightning, limit: lightning ? 100 : 20, session: true });
  let idx = 0;
  let board = null;
  let state = null; // { drill, status, verdict, game, hintShown }
  const session = { attempts: 0, correct: 0, missed: [] }; // missed: first-attempt failures

  root.innerHTML = `
    <div class="row" style="justify-content: space-between"><h1 style="margin:0">${lightning ? 'Lightning round' : 'Drills'}</h1><span class="muted" id="counts"></span></div>
    ${lightning
      ? `<p class="muted">Every drill of the pattern "${esc(lightning)}", back to back. Blocked practice: passes here do not advance the spaced-repetition ladder, but a miss still resets its drill. <a href="#/drills">Back to normal drills</a>.</p>`
      : `<p class="muted">Positions from your own games where you went wrong. Find the engine's move, then grade how well you knew it. Correct moves move up the ladder (1, 3, 7, 14, 30, 60 days); a miss comes back at the end of the same session. Sharpener drills are near-miss moments below the mistake threshold.</p>`}
    <div id="drill"></div>`;
  const el = root.querySelector('#drill');
  const counts = root.querySelector('#counts');

  async function load() {
    if (idx >= due.length) {
      // Normal mode re-checks the queue (failed drills are due again, and the
      // server batches). A lightning round serves its fixed set exactly once:
      // its drills are returned regardless of due date, so a re-fetch would
      // hand back the same positions forever.
      if (due.length && !lightning) {
        ({ due, total, dueCount, feedback = {} } = await api.drills({ session: true }));
        idx = 0;
        if (due.length) return load();
      }
      counts.textContent = `${total} drill${total === 1 ? '' : 's'} total`;
      el.innerHTML = `${sessionRecap()}<div class="card"><div class="empty">${lightning
        ? 'That was every drill for this pattern. <a href="#/drills">Back to drills</a>.'
        : (total ? 'Nothing due right now. Come back later.' : 'No drills yet. Drills are created from mistakes and blunders when games are analysed.')}</div></div>`;
      board?.destroy();
      board = null;
      state = null; // stray keypresses must not re-grade the last drill
      return;
    }
    const drill = due[idx];
    counts.textContent = lightning ? `${due.length - idx} left · ${due.length} in this round` : `${dueCount - idx} due · ${total} total`;
    state = { drill, status: 'guessing', verdict: null, game: null, follow: null, hintShown: false };
    el.innerHTML = `<div class="drill-layout">
      <div>
        <div class="board-wrap"><div id="dboard"></div></div>
        <p class="muted" style="margin-top:8px"><small>${esc(drill.label)} · ${drill.phase} · <a href="#/game/${drill.gameId}/${drill.ply}">open game</a></small></p>
      </div>
      <div id="dpanel"></div>
    </div>`;
    board?.destroy();
    // Threat drills carry an orientation: the opponent moves, but the player
    // looks at the board from their own side, where threats must be spotted.
    board = new Board(el.querySelector('#dboard'), { orientation: drill.orientation || drill.sideToMove, onMove });
    board.set(drill.fen, { movableFor: drill.sideToMove });
    renderPanel();
    // From the second review on, offer the key question BEFORE the move: the
    // goal is training the thinking habit, not recall of a memorised answer.
    if (drill.reviews?.length) loadGame();
  }

  function loadGame() {
    api.game(state.drill.gameId).then(({ game }) => { state.game = game; renderPanel(); }).catch(() => {});
  }

  /** Close the loop at the end of a session: how it went, what to revisit. */
  function sessionRecap() {
    if (!session.attempts) return '';
    const missCounts = new Map();
    for (const d of session.missed) {
      const k = d.category ? (CATEGORY_LABEL[d.category] || d.category) : (d.pattern || d.phase);
      missCounts.set(k, (missCounts.get(k) || 0) + 1);
    }
    const missed = [...missCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}× ${esc(k)}`).join(', ');
    const pct = Math.round((session.correct / session.attempts) * 100);
    return `<div class="card" style="margin-bottom: 12px"><h3 style="margin-top:0">Session done</h3>
      <p>${session.attempts} answer${session.attempts === 1 ? '' : 's'}, ${session.correct} correct (${pct}%).</p>
      ${missed ? `<p class="muted">Missed on the first try: ${missed}.</p>` : '<p class="muted">Clean session, nothing missed.</p>'}</div>`;
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

  async function onMove(orig, dest) {
    if (!state) return;
    const d = state.drill;
    if (state.status === 'follow') {
      const f = state.follow;
      const reply = f.steps[f.idx + 1];
      const res = await applyMove(reply.fen, orig, dest);
      if (!res) return board.set(reply.fen, { lastMove: reply.uci, movableFor: d.sideToMove }); // dismissed promotion
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
    const res = await applyMove(d.fen, orig, dest);
    if (!res) return board.set(d.fen, { movableFor: d.sideToMove }); // dismissed promotion
    const correct = d.acceptedUci.includes(res.uci);
    const rank = d.lines.findIndex(l => l.uci === res.uci);
    let text;
    if (res.uci === d.bestUci) text = `${res.san}: correct, the engine's first choice.`;
    else if (correct) text = `${res.san}: accepted (engine line ${rank + 1}, within ${WP_ACCEPT} win-% of the best move ${d.bestSan}).`;
    else if (res.uci === d.playedUci) text = d.kind === 'punish' || d.kind === 'threat' ? `${res.san}: that is what was played in the game, but the engine prefers ${d.bestSan}.` : `${res.san}: that is what you played in the game (${d.judgment}). Engine: ${d.bestSan}.`;
    else if (rank > 0) text = `${res.san}: engine line ${rank + 1}, but clearly worse than ${d.bestSan}.`;
    else text = `${res.san}: not among the engine's top lines. Engine: ${d.bestSan}.`;
    const verdict = { correct, text, followUps: 0, foundSans: [] };
    // Off-list move: ask the server for a quick engine eval (best effort; needs
    // Stockfish). The paired same-depth search is trustworthy enough to accept
    // a move the stored lines simply did not cover.
    if (!correct && rank < 0 && res.uci !== d.playedUci) {
      // Punish and threat drills play in the position after the mistake, so the
      // answer is checked against the NEXT ply's stored analysis.
      api.evalMove(d.gameId, d.kind === 'punish' || d.kind === 'threat' ? d.ply + 1 : d.ply, res.uci).then(r => {
        const good = r.wpDiff <= WP_ACCEPT;
        if (good) verdict.correct = true;
        verdict.text = `${res.san}: quick eval ${formatEval(r.cp * (d.sideToMove === 'white' ? 1 : -1))}, ${r.wpDiff.toFixed(1)} win-% behind ${d.bestSan}.${good ? ' Accepted.' : ''}`;
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
    const threat = d.kind === 'threat';
    const chips = `<span class="chip ${d.judgment}">${d.judgment}${punish || threat ? '' : ' in the game'}</span>${punish ? ` <span class="chip">punish</span> <span class="chip">vs ${esc(d.subject || '?')}</span>` : ''}${threat ? ' <span class="chip">see the threat</span>' : ''}${d.tier === 'sharpen' ? ' <span class="chip">sharpener</span>' : ''}${d.category ? ` <span class="chip cat">${esc(d.category)}</span>` : ''}`;
    if (state.status === 'guessing') {
      // Question-first: from the second review on, invite the player to generate
      // the key question themselves before comparing with the coach's.
      const kq = d.reviews?.length ? state.game?.explanations?.[d.ply]?.key_question : null;
      const hint = kq ? (state.hintShown
        ? `<div class="kq">Ask yourself: ${esc(kq)}</div>`
        : `<p class="muted" style="margin:8px 0">What is the question in this position? Form it first, then <button class="small" id="showhint">compare with the coach's</button></p>`) : '';
      const task = punish
        ? `${esc(d.subject || 'The opponent')} just played ${esc(d.mistakeSan)}. ${side} to move: find the punishment.`
        : threat
          ? `In the game you played ${esc(d.mistakeSan)} here (${d.judgment}). What did it allow? Find ${side}'s strongest reply.`
          : `${side} to move. Find the best move.`;
      p.innerHTML = `<div class="guess"><b>${task}</b>
        <p class="muted">Drill ${idx + 1} of ${due.length}. ${chips}${d.clock != null ? ` · clock in the game: ${fmtClock(d.clock)}` : ''}</p>
        ${hint}
        <button class="small" id="giveup">Show answer</button></div>`;
      const sh = p.querySelector('#showhint');
      if (sh) sh.onclick = () => { state.hintShown = true; renderPanel(); };
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
      ${e ? `<div class="explanation"><div class="row"><span class="chip cat">${esc(e.category)}</span> <b>${esc(e.pattern)}</b></div><p>${esc(e.explanation)}</p><div class="kq">Ask yourself: ${esc(e.key_question)}</div>
        <div class="row" style="margin-top: 6px; gap: 6px"><small class="muted">Was this explanation useful?</small>
          <button class="small${feedback[`${d.gameId}:${d.ply}`]?.helpful === true ? ' primary' : ''}" data-fb="yes">Yes</button>
          <button class="small${feedback[`${d.gameId}:${d.ply}`]?.helpful === false ? ' primary' : ''}" data-fb="no">Not really</button></div></div>` : (state.game ? '<p class="muted">No explanation for this moment yet.</p>' : '')}
      <div class="row" style="margin-top: 12px">${gradeButtons}</div>
    </div>`;
    p.querySelectorAll('button[data-grade]').forEach(b => b.onclick = () => grade(b.dataset.grade));
    p.querySelectorAll('button[data-fb]').forEach(b => b.onclick = async () => {
      const helpful = b.dataset.fb === 'yes';
      try {
        await api.feedback(d.gameId, d.ply, helpful);
        feedback[`${d.gameId}:${d.ply}`] = { helpful }; // feedback is per moment, shared by a moment's twin drills
        renderPanel();
      } catch (err) { toast(err.message, true); }
    });
  }

  let grading = false;
  async function grade(g) {
    if (!state || state.status !== 'revealed' || grading) return; // no double-grades from rapid clicks/keys
    grading = true;
    try {
      await api.reviewDrill(state.drill.id, g, state.verdict.correct, !!lightning);
      session.attempts++;
      if (state.verdict.correct) session.correct++;
      else if (!session.missed.some(x => x.id === state.drill.id)) session.missed.push(state.drill);
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
