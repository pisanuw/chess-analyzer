// Drills: replay your own critical moments, spaced repetition.
import { api, esc, toast, formatEval, fmtClock, winProb, WP_ACCEPT, session as auth } from '../api.js';
import { Board, applyMove, gameStatus, walkSans, lineShapes } from '../board.js';
import { CATEGORY_LABEL } from '../labels.js';
import { keymap, linesList } from '../widgets.js';

const MAX_FOLLOWUPS = 2;      // player moves asked beyond the first, along the engine's PV
const CALC_FOLLOWUPS = 4;     // calculation errors demand the full line
const TIMED_SECONDS = 30;     // opt-in countdown for time-pressure drills

// Single-move guessing cannot train these: the skill is holding an advantage
// (or a worse position) over MANY moves. Their drills play out against the
// sparring engine instead, when one is available.
const PLAYOUT_CATS = new Set(['conversion', 'defence', 'endgame-technique']);

const maxFollowFor = d => (d.category === 'calculation' ? CALC_FOLLOWUPS : MAX_FOLLOWUPS);

export async function drillsView(root, query) {
  // ?pattern=... or ?category=...: a practice round, every matching drill back
  // to back regardless of due date (blocked practice; the ladder is untouched
  // except that a miss still resets).
  const params = new URLSearchParams(query || '');
  const lightning = params.get('pattern');
  const categoryRound = params.get('category');
  const subjectRound = params.get('subject'); // prep round: one opponent's punish drills
  const roundColor = ['white', 'black'].includes(params.get('color')) ? params.get('color') : null;
  const roundKey = lightning || categoryRound || subjectRound;
  const fetchArgs = () => ({ pattern: lightning, category: categoryRound, subject: subjectRound, color: roundColor, limit: roundKey ? 100 : 20, session: !roundKey });
  let { due, total, dueCount, suspendedCount = 0, feedback = {} } = await api.drills(fetchArgs());
  const status = await api.status().catch(() => ({}));
  const { settings = {} } = await api.settings().catch(() => ({}));
  const canPlayout = !!status.engineOk && !status.readonly;
  let idx = 0;
  let board = null;
  let state = null; // { drill, status, verdict, game, hintShown, startedAt, answerMs, timer, playout, confidence, note, explainDone, pendingRes }
  let lastGraded = null; // { id, idx, correct, missedAdded } for undo
  let patternNotes = null; // lazy cache of synthesized pattern notes
  const session = { attempts: 0, correct: 0, missed: [], times: [], decoys: { seen: 0, right: 0 }, conf: {} };

  const title = lightning ? 'Lightning round' : categoryRound ? 'Category round' : subjectRound ? `Prep round: ${subjectRound}` : 'Drills';
  const intro = subjectRound
    ? `<p class="muted">Every punish drill from ${esc(subjectRound)}'s analysed games${roundColor ? ` as ${roundColor}` : ''}, opening errors first: the position after their mistake, you find the refutation. ${auth.user?.role === 'visitor' ? 'Nothing you do here is saved.' : 'Blocked practice: the ladder is untouched, but a miss still resets its drill.'} <a href="#/scout/${encodeURIComponent(subjectRound)}">Back to their dossier</a>.</p>`
    : auth.user?.role === 'visitor'
    ? '<p class="muted">Practice mode: a rotating set of drills from the scouting library (find the refutation the opponent missed). Nothing you do here is saved.</p>'
    : lightning
    ? `<p class="muted">Every drill of the pattern "${esc(lightning)}", back to back. Blocked practice: passes here do not advance the spaced-repetition ladder, but a miss still resets its drill. <a href="#/drills">Back to normal drills</a>.</p>`
    : categoryRound
      ? `<p class="muted">Every drill in the category "${esc(CATEGORY_LABEL[categoryRound] || categoryRound)}", back to back. Blocked practice: the ladder is untouched, but a miss still resets its drill. <a href="#/drills">Back to normal drills</a>.</p>`
      : `<p class="muted">Positions from your own games where you went wrong. Find the engine's move, then grade how well you knew it. Say how sure you are before the answer shows, and on a miss write what you missed before reading the coach. Correct moves move up the ladder (1, 3, 7, 14, 30, 60 days, stretched or shortened by how easy each drill has proved for you); a miss comes back at the end of the same session. Quiet-position checks are mixed in: sometimes your game move was fine, and saying so is the right answer.</p>`;
  root.innerHTML = `
    <div class="row" style="justify-content: space-between"><h1 style="margin:0">${title}</h1>
      <span class="row" style="gap:8px"><button class="small" id="undo-last" hidden title="Revert the last grade and revisit that drill">Undo last grade</button><span class="muted" id="counts"></span></span></div>
    ${intro}
    <div id="today"></div>
    <div id="drill"></div>`;
  const el = root.querySelector('#drill');
  const counts = root.querySelector('#counts');
  const undoBtn = root.querySelector('#undo-last');

  // A one-line prescription: what today's work should be, from the report.
  if (!roundKey) {
    api.report().then(({ report }) => {
      if (!report?.games) return;
      const bits = [];
      const topPattern = (report.patterns || []).find(p => p.count >= 2);
      if (topPattern) bits.push(`heaviest pattern: "${esc(topPattern.pattern)}" <a href="#/drills?pattern=${encodeURIComponent(topPattern.pattern)}" title="Every drill of this pattern, back to back">⚡ round</a>`);
      // Prefer a worsening focus area over the merely-heaviest one, and say so.
      const focus = (report.focus || []).find(f => (f.trend || 0) > 0.1) || (report.focus || [])[0];
      if (focus) {
        const tag = focus.trend > 0.1 ? ' (getting worse)' : focus.trend < -0.1 ? ' (improving)' : '';
        bits.push(`focus area: ${esc(CATEGORY_LABEL[focus.category] || focus.category)}${tag} <a href="#/drills?category=${encodeURIComponent(focus.category)}" title="Every drill of this error type, back to back">drill it</a>`);
      }
      if (bits.length) root.querySelector('#today').innerHTML = `<p class="muted">Today: ${dueCount} due · ${bits.join(' · ')}.</p>`;
    }).catch(() => {});
  }

  function clearTimer() {
    if (state?.timer) { clearInterval(state.timer.interval); state.timer = null; }
  }

  async function load() {
    clearTimer();
    if (idx >= due.length) {
      // Normal mode re-checks the queue (failed drills are due again, and the
      // server batches). A practice round serves its fixed set exactly once:
      // its drills come back regardless of due date, so a re-fetch would hand
      // back the same positions forever.
      if (due.length && !roundKey) {
        ({ due, total, dueCount, suspendedCount = 0, feedback = {} } = await api.drills(fetchArgs()));
        idx = 0;
        if (due.length) return load();
      }
      counts.textContent = `${total} drill${total === 1 ? '' : 's'} total`;
      el.innerHTML = `${sessionRecap()}<div class="card"><div class="empty">${roundKey
        ? `That was every drill in this round. <a href="#/drills">Back to drills</a>.`
        : (total ? 'Nothing due right now. Come back later.' : 'No drills yet. Drills are created from mistakes and blunders when games are analysed.')}
        ${suspendedCount ? `<p class="muted">${suspendedCount} suspended drill${suspendedCount === 1 ? '' : 's'} · <button class="small" id="restore-sus">Restore them</button></p>` : ''}</div></div>`;
      el.querySelector('#restore-sus')?.addEventListener('click', async () => {
        try {
          await api.restoreSuspended();
          ({ due, total, dueCount, suspendedCount = 0, feedback = {} } = await api.drills(fetchArgs()));
          idx = 0;
          await load();
        } catch (err) { toast(err.message, true); }
      });
      board?.destroy();
      board = null;
      state = null; // stray keypresses must not re-grade the last drill
      return;
    }
    const drill = due[idx];
    counts.textContent = roundKey ? `${due.length - idx} left · ${due.length} in this round` : `${due.length - idx} left · ${total} total`;
    // Conversion, defence, and endgame technique are trained by playing the
    // position OUT, not by one move: the sparring engine answers at the
    // player's level and a full-strength verdict decides pass or fail.
    const playout = canPlayout && !roundKey && !drill.kind && PLAYOUT_CATS.has(drill.category);
    const sign = drill.sideToMove === 'white' ? 1 : -1;
    state = {
      drill,
      status: playout ? 'playout' : 'guessing',
      playout: playout ? { fen: drill.fen, sans: [], over: null, busy: false, startWp: winProb((drill.lines[0]?.cp ?? 0) * sign) } : null,
      verdict: null, game: null, follow: null, hintShown: false,
      startedAt: Date.now(), answerMs: null, timer: null,
      confidence: null, note: null, explainDone: false, pendingRes: null,
      // Vary how deep the follow-ups go (max, or one shorter) so repeated reps
      // train the method, not a fixed "and then this exact move" sequence.
      followCap: Math.max(1, maxFollowFor(drill) - Math.round(Math.random())),
    };
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
    board = new Board(el.querySelector('#dboard'), { orientation: drill.orientation || drill.sideToMove, onMove, input: true });
    board.set(drill.fen, { movableFor: drill.sideToMove });
    renderPanel();
    // From the second review on, offer the key question BEFORE the move: the
    // goal is training the thinking habit, not recall of a memorised answer.
    if (drill.reviews?.length) loadGame();
  }

  function loadGame() {
    api.game(state.drill.gameId).then(({ game }) => { state.game = game; renderPanel(); }).catch(() => {});
  }

  function loadNotes() {
    if (patternNotes) return;
    api.patterns().then(({ notes }) => { patternNotes = notes || {}; renderPanel(); }).catch(() => { patternNotes = {}; });
  }

  /** Close the loop at the end of a session: how it went, what to revisit. */
  function sessionRecap() {
    if (!session.attempts && !session.decoys.seen) return '';
    const missCounts = new Map();
    for (const d of session.missed) {
      const k = d.category ? (CATEGORY_LABEL[d.category] || d.category) : (d.pattern || d.phase);
      missCounts.set(k, (missCounts.get(k) || 0) + 1);
    }
    const missed = [...missCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}× ${esc(k)}`).join(', ');
    const pct = session.attempts ? Math.round((session.correct / session.attempts) * 100) : 0;
    const avgSecs = session.times.length ? Math.round(session.times.reduce((s, t) => s + t, 0) / session.times.length / 1000) : null;
    return `<div class="card" style="margin-bottom: 12px"><h3 style="margin-top:0">Session done</h3>
      ${session.attempts ? `<p>${session.attempts} answer${session.attempts === 1 ? '' : 's'}, ${session.correct} correct (${pct}%).${avgSecs != null ? ` About ${avgSecs}s per answer.` : ''}</p>` : ''}
      ${missed ? `<p class="muted">Missed on the first try: ${missed}.</p>` : (session.attempts ? '<p class="muted">Clean session, nothing missed.</p>' : '')}
      ${session.decoys.seen ? `<p class="muted">Quiet-position check: ${session.decoys.right} of ${session.decoys.seen} handled correctly (these were positions where your game move was fine).</p>` : ''}
      ${Object.keys(session.conf).length ? `<p class="muted">Calibration: ${['sure', 'likely', 'guess'].filter(k => session.conf[k]).map(k => `${k} ${session.conf[k].right} of ${session.conf[k].n} right`).join(', ')}.${session.conf.sure && session.conf.sure.right < session.conf.sure.n ? ' A "sure" miss is a belief to correct: the report lists them.' : ''}</p>` : ''}</div>`;
  }

  function reveal(verdict) {
    clearTimer();
    state.status = 'revealed';
    state.verdict = verdict;
    if (state.answerMs == null) state.answerMs = Date.now() - state.startedAt;
    if (!verdict.correct && state.drill.pattern) loadNotes(); // surface the synthesized rule where the miss happened
    renderPanel();
    loadGame();
  }

  /** Continue along the matched engine line: opponent's reply is played for you,
   * then you must find the follow-up. Calculation drills walk deeper. */
  function startFollowUp(steps, idx) {
    state.status = 'follow';
    state.follow = { steps, idx }; // steps[idx] was the player's last correct move
    const reply = steps[idx + 1];
    board.set(reply.fen, { lastMove: reply.uci, movableFor: state.drill.sideToMove });
    renderPanel();
  }

  // --- play it out (conversion / defence / endgame technique) ---------------
  function drillElo() {
    return Math.min(3190, Math.max(1320, Number(settings.playerRating) || 2000));
  }

  async function playoutMove(orig, dest) {
    const po = state.playout, d = state.drill;
    if (!po || po.busy || po.over) return;
    const res = await applyMove(po.fen, orig, dest);
    if (!res) return board.set(po.fen, { movableFor: d.sideToMove });
    po.fen = res.fen; po.sans.push(res.san);
    let st = gameStatus(res.fen);
    if (st.over) { po.over = st; board.set(po.fen, { lastMove: res.uci }); return finishPlayout(null); }
    po.busy = true;
    board.set(po.fen, { lastMove: res.uci });
    renderPanel();
    try {
      const r = await api.playoutMove(po.fen, drillElo());
      if (state?.playout !== po) return; // moved on while the engine was thinking
      po.fen = r.fen; po.sans.push(r.san);
      po.busy = false;
      st = gameStatus(r.fen);
      if (st.over) { po.over = st; board.set(po.fen, { lastMove: r.uci }); return finishPlayout(null); }
      board.set(po.fen, { lastMove: r.uci, movableFor: d.sideToMove });
      renderPanel();
    } catch (err) {
      if (state?.playout !== po) return;
      po.busy = false;
      toast(err.message, true);
      board.set(po.fen, { movableFor: d.sideToMove });
      renderPanel();
    }
  }

  async function assessPlayout() {
    const po = state.playout;
    if (!po || po.busy || po.over) return;
    po.busy = true;
    renderPanel();
    try {
      const r = await api.playoutAssess(po.fen);
      if (state?.playout !== po) return;
      po.busy = false;
      finishPlayout(r);
    } catch (err) {
      if (state?.playout === po) { po.busy = false; toast(err.message, true); renderPanel(); }
    }
  }

  /** Verdict for a played-out drill: held (or grew) the starting winning
   * chances within the usual acceptance band = pass. Mate and stalemate are
   * scored as 100/0/50 so a defended draw from a lost position passes. */
  function finishPlayout(assess) {
    const po = state.playout, d = state.drill;
    let finalWp;
    if (po.over) finalWp = po.over.over === 'checkmate' ? (po.over.winner === d.sideToMove ? 100 : 0) : 50;
    else finalWp = d.sideToMove === 'white' ? assess.wp : 100 - assess.wp;
    const held = finalWp >= po.startWp - WP_ACCEPT;
    const endText = po.over
      ? (po.over.over === 'checkmate' ? (po.over.winner === d.sideToMove ? 'Checkmate: converted.' : 'Checkmated.') : (po.over.over === 'stalemate' ? 'Stalemate.' : 'Drawn.'))
      : `Engine verdict ${formatEval(assess.cp)}.`;
    reveal({
      correct: held,
      text: `${endText} Your winning chances: ${finalWp.toFixed(0)}% (started at ${po.startWp.toFixed(0)}%).${held ? ' Held.' : ' Ground given up.'}`,
      followUps: 0, foundSans: [],
    });
  }

  async function onMove(orig, dest) {
    if (!state) return;
    const d = state.drill;
    if (state.status === 'playout') return playoutMove(orig, dest);
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
        const more = f.idx + 4 < f.steps.length && state.verdict.followUps < state.followCap;
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
    clearTimer();
    if (state.answerMs == null) state.answerMs = Date.now() - state.startedAt; // time to the FIRST answer, not to the end of follow-ups (or the confidence question)
    // Confidence is asked once, after the move is committed and before anything
    // is revealed; the review stores it and the report compares it with the outcome.
    if (!state.confidence) {
      state.pendingRes = res;
      state.status = 'confidence';
      board.set(res.fen, { lastMove: res.uci });
      renderPanel();
      return;
    }
    return resolveGuess(res);
  }

  function setConfidence(c) {
    if (!state || state.status !== 'confidence') return;
    state.confidence = c;
    state.status = 'guessing';
    const res = state.pendingRes;
    state.pendingRes = null;
    resolveGuess(res);
  }

  /** Score a committed move against the drill's accepted lines and reveal. */
  async function resolveGuess(res) {
    const d = state.drill;
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
    // a move the stored lines simply did not cover. Grading is deferred until
    // the eval settles: revealing correct:false now would let a fast grade
    // persist a miss (and mis-schedule the ladder) for a move the engine then
    // accepts, while the late resolution silently no-ops.
    if (!correct && rank < 0 && res.uci !== d.playedUci) {
      state.verdict = verdict;
      state.status = 'verifying';
      board.set(res.fen, { lastMove: res.uci, shapes: lineShapes(d.lines, d.playedUci) });
      renderPanel();
      // Punish and threat drills play in the position after the mistake, so the
      // answer is checked against the NEXT ply's stored analysis.
      api.evalMove(d.gameId, d.kind === 'punish' || d.kind === 'threat' ? d.ply + 1 : d.ply, res.uci).then(r => {
        const good = r.wpDiff <= WP_ACCEPT;
        if (good) verdict.correct = true;
        verdict.text = `${res.san}: quick eval ${formatEval(r.cp * (d.sideToMove === 'white' ? 1 : -1))}, ${r.wpDiff.toFixed(1)} win-% behind ${d.bestSan}.${good ? ' Accepted.' : ''}`;
      }).catch(() => {}).then(() => {
        if (state?.verdict === verdict) reveal(verdict); // now gradeable, with the settled verdict
      });
      return;
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
    const pane = el.querySelector('#dpanel');
    const side = d.sideToMove === 'white' ? 'White' : 'Black';
    const punish = d.kind === 'punish';
    const threat = d.kind === 'threat';
    const decoy = d.kind === 'decoy';
    const opening = d.kind === 'opening';
    const chips = `${decoy ? '<span class="chip">quiet position</span>' : `<span class="chip ${d.judgment}">${d.judgment}${punish || threat ? '' : ' in the game'}</span>`}${punish ? ` <span class="chip">punish</span> <span class="chip">vs ${esc(d.subject || '?')}</span>` : ''}${threat ? ' <span class="chip">see the threat</span>' : ''}${opening ? ' <span class="chip">opening prep</span>' : ''}${d.tier === 'sharpen' ? ' <span class="chip">sharpener</span>' : ''}${d.category ? ` <span class="chip cat">${esc(d.category)}</span>` : ''}`;
    if (state.status === 'playout') {
      const po = state.playout;
      const goal = d.category === 'defence' || po.startWp < 50 - WP_ACCEPT
        ? 'Hold it: give up no more ground'
        : d.category === 'conversion' ? 'Convert it' : 'Show the technique';
      pane.innerHTML = `<div class="guess">
        <b>${goal}: play it out against the engine (~${drillElo()} Elo).</b>
        <p class="muted">Drill ${idx + 1} of ${due.length}. <span class="chip cat">${esc(d.category)}</span>${d.clock != null ? ` · clock in the game: ${fmtClock(d.clock)}` : ''}</p>
        <p class="muted">You start at ${po.startWp.toFixed(0)}% winning chances. Keep them within ${WP_ACCEPT} points (or finish the game). Evals stay hidden until the verdict.</p>
        ${po.sans.length ? `<p style="font-variant-numeric: tabular-nums">${esc(po.sans.join(' '))}</p>` : ''}
        ${po.busy ? '<p class="muted">Engine is thinking…</p>' : ''}
        <div class="row" style="gap:6px">
          <button class="small" id="po-assess" ${po.busy ? 'disabled' : ''}>Assess and finish</button>
          <button class="small" id="po-single" title="Fall back to the one-move drill">Answer as a single move instead</button>
        </div>
      </div>`;
      pane.querySelector('#po-assess').onclick = assessPlayout;
      pane.querySelector('#po-single').onclick = () => {
        state.status = 'guessing';
        state.playout = null;
        board.set(d.fen, { movableFor: d.sideToMove });
        renderPanel();
      };
      return;
    }
    if (state.status === 'confidence') {
      pane.innerHTML = `<div class="guess"><b>You played ${esc(state.pendingRes.san)}. How sure are you?</b>
        <p class="muted">Say it before the answer shows: the report compares what you said with what happened, and a "sure" miss is the first thing to study.</p>
        <div class="row" style="gap:6px">
          <button data-conf="sure">Sure <span class="kbd">1</span></button>
          <button data-conf="likely">Likely <span class="kbd">2</span></button>
          <button data-conf="guess">A guess <span class="kbd">3</span></button></div>
        ${keymap([['1', 'sure'], ['2', 'likely'], ['3', 'a guess']])}</div>`;
      pane.querySelectorAll('button[data-conf]').forEach(b => b.onclick = () => setConfidence(b.dataset.conf));
      return;
    }
    if (state.status === 'guessing') {
      // While guessing, show nothing that answers the detection question: with
      // decoys in the mix, "blunder" or a category name would tell the player
      // whether (and how) this position went wrong in the game.
      const guessChips = punish || threat ? chips
        : `${opening ? '<span class="chip">opening prep</span> ' : ''}${d.tier === 'sharpen' ? '<span class="chip">sharpener</span>' : ''}`;
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
          : opening
            ? `${side} to move. Your preparation ran out around here in the game: find the move.`
            : `${side} to move. Find the best move.`;
      // The failure being rehearsed was "decide well, fast": time-pressure
      // moments offer a countdown matching tournament reality. Opt-in, so the
      // default stays calm.
      const offerTimer = !roundKey && !decoy && (d.timePressure || (d.clock != null && d.clock < 120));
      const timerBits = state.timer
        ? `<span class="chip" id="timer-left">⏱ ${state.timer.left}s</span>`
        : (offerTimer ? `<button class="small" id="timed" title="The clock was a factor here; rehearse deciding fast">Timed: answer in ${TIMED_SECONDS}s</button>` : '');
      pane.innerHTML = `<div class="guess"><b>${task}</b>
        <p class="muted">Drill ${idx + 1} of ${due.length}. ${guessChips}${d.clock != null ? ` · clock in the game: ${fmtClock(d.clock)}` : ''} ${timerBits}</p>
        ${hint}
        <button class="small" id="giveup">Show answer <span class="kbd">Space</span></button>
        ${keymap([['Space', 'show answer'], ['f', 'flip board'], ['Enter', 'play the typed move']])}</div>`;
      const sh = pane.querySelector('#showhint');
      if (sh) sh.onclick = () => { state.hintShown = true; renderPanel(); };
      const timed = pane.querySelector('#timed');
      if (timed) timed.onclick = () => {
        state.timer = {
          left: TIMED_SECONDS,
          interval: setInterval(() => {
            if (!state?.timer) return;
            state.timer.left--;
            const chip = el.querySelector('#timer-left');
            if (chip) chip.textContent = `⏱ ${state.timer.left}s`;
            if (state.timer.left <= 0) {
              clearTimer();
              board.set(d.fen, { shapes: lineShapes(d.lines, d.playedUci) });
              reveal({ correct: false, text: `Time. Engine: ${d.bestSan}.`, followUps: 0, foundSans: [] });
            }
          }, 1000),
        };
        renderPanel();
      };
      pane.querySelector('#giveup').onclick = () => { clearTimer(); board.set(d.fen, { shapes: lineShapes(d.lines, d.playedUci) }); reveal({ correct: false, text: `Engine: ${d.bestSan}.`, followUps: 0, foundSans: [] }); };
      return;
    }
    if (state.status === 'follow') {
      const reply = state.follow.steps[state.follow.idx + 1];
      pane.innerHTML = `<div class="guess"><div class="result good">${esc(state.verdict.text)}</div>
        <b>Opponent replies ${esc(reply.san)}. Find the follow-up.</b>
        <p class="muted">Continue the engine's line from memory or calculation.</p>
        <button class="small" id="stopfollow">Show the line</button></div>`;
      pane.querySelector('#stopfollow').onclick = () => {
        const expected = state.follow.steps[state.follow.idx + 2];
        state.verdict.followMiss = expected ? `Follow-up was ${expected.san}.` : '';
        board.set(reply.fen, { lastMove: reply.uci, shapes: lineShapes(d.lines, d.playedUci) });
        reveal(state.verdict);
      };
      return;
    }
    if (state.status === 'verifying') {
      // Answer is shown, but the off-list move is still being scored by the
      // engine: no grade buttons yet, so a fast grade cannot lock in a verdict
      // the engine is about to overturn.
      pane.innerHTML = `<div class="guess">
        <div class="result ${state.verdict.correct ? 'good' : 'bad'}">${esc(state.verdict.text)}</div>
        <p style="margin: 6px 0">${chips}</p>
        ${linesList(d.lines, d.playedUci)}
        <p class="muted">Checking your move with the engine…</p>
      </div>`;
      return;
    }
    const e = state.game?.explanations?.[d.ply];
    // Explain-back: on a miss, one line on what was missed, typed before the
    // coach's explanation appears (generation before feedback is what makes
    // the correction stick). The grade waits until it is written or skipped.
    const askBack = !state.verdict.correct && !decoy && !state.explainDone;
    if (askBack) {
      pane.innerHTML = `<div class="guess">
        <div class="result bad">${esc(state.verdict.text)}</div>
        ${state.verdict.followMiss ? `<div class="result bad">${esc(state.verdict.followMiss)}</div>` : ''}
        <p style="margin: 6px 0">${chips}</p>
        ${linesList(d.lines, d.playedUci)}
        <div class="explanation"><p class="muted" style="margin:0 0 6px">Before the coach's answer: what did you miss, in one line?</p>
          <div class="row" style="gap:6px"><input type="text" id="explain-back" maxlength="300" placeholder="e.g. the knight was not really pinned" style="flex:1; min-width: 200px">
          <button class="small primary" id="eb-compare">Compare <span class="kbd">Enter</span></button> <button class="small" id="eb-skip">Skip</button></div></div>
      </div>`;
      const input = pane.querySelector('#explain-back');
      const finish = () => { state.note = input.value.trim() || null; state.explainDone = true; renderPanel(); };
      pane.querySelector('#eb-compare').onclick = finish;
      pane.querySelector('#eb-skip').onclick = () => { state.explainDone = true; renderPanel(); };
      input.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); finish(); } };
      input.focus();
      return;
    }
    // Grading honesty: a wrong answer can only be graded Again. Decoys are
    // detection checks with no schedule: a single Continue.
    const gradeButtons = decoy
      ? `<span class="muted">Detection check: no schedule to grade.</span>
         <button data-grade="again">Continue <span class="kbd">1</span></button>`
      : state.verdict.correct
        ? `<span class="muted">How well did you know it?</span>
           <button data-grade="again">Again <span class="kbd">1</span></button>
           <button data-grade="good">Good <span class="kbd">2</span></button>
           <button data-grade="easy">Easy <span class="kbd">3</span></button>`
        : `<span class="muted">Missed: it comes back at the end of this session.</span>
           <button data-grade="again">Continue <span class="kbd">1</span></button>`;
    const decoyNote = decoy ? `<p class="muted">This was a quiet position from your game: you played ${esc(d.playedSan)}, which was fine. Most drills show positions where something went wrong; recognising when nothing is wrong is the other half of the skill.</p>` : '';
    // The moment of failure is when the transferable lesson lands: show the
    // synthesized pattern rule (if one exists) right under a miss.
    const noteKey = (d.pattern || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const note = !state.verdict.correct && noteKey && patternNotes?.[noteKey];
    const answeredIn = state.answerMs != null && !decoy ? ` · answered in ${Math.round(state.answerMs / 1000)}s` : '';
    // A drill missed several times is a leech: gently suggest parking it.
    const lapses = (d.reviews || []).filter(r => r.correct === false).length;
    pane.innerHTML = `<div class="guess">
      <div class="result ${state.verdict.correct ? 'good' : 'bad'}">${esc(state.verdict.text)}</div>
      ${state.verdict.followMiss ? `<div class="result bad">${esc(state.verdict.followMiss)}</div>` : ''}
      ${note ? `<div class="kq"><b>${esc(note.pattern)}:</b> ${esc(note.rule)} Watch for: ${esc(note.triggers)}</div>` : ''}
      ${decoyNote}
      <p style="margin: 6px 0">${chips}${answeredIn ? `<small class="muted">${answeredIn}</small>` : ''}</p>
      ${linesList(d.lines, d.playedUci)}
      ${state.note ? `<div class="kq">You wrote: ${esc(state.note)}</div>` : ''}
      ${e ? `<div class="explanation"><div class="row"><span class="chip cat">${esc(e.category)}</span> <b>${esc(e.pattern)}</b></div><p>${esc(e.explanation)}</p><div class="kq">Ask yourself: ${esc(e.key_question)}</div>
        <div class="row" style="margin-top: 6px; gap: 6px"><small class="muted">Was this explanation useful?</small>
          <button class="small${feedback[`${d.gameId}:${d.ply}`]?.helpful === true ? ' primary' : ''}" data-fb="yes">Yes</button>
          <button class="small${feedback[`${d.gameId}:${d.ply}`]?.helpful === false ? ' primary' : ''}" data-fb="no">Not really</button></div></div>` : (state.game ? '<p class="muted">No explanation for this moment yet.</p>' : '')}
      <div class="row" style="margin-top: 12px">${gradeButtons}${decoy ? '' : `<span class="spacer"></span>${lapses >= 3 ? `<small class="muted" style="margin-right:6px">Missed ${lapses}x: a leech, consider parking it.</small>` : ''}<button class="small" data-suspend title="Park this drill out of every queue; restore from the end-of-queue screen">Suspend drill</button>`}</div>
      ${keymap(decoy || !state.verdict.correct ? [['1', 'continue'], ['f', 'flip board']] : [['1', 'again'], ['2', 'good'], ['3', 'easy'], ['f', 'flip board']])}
    </div>`;
    pane.querySelectorAll('button[data-grade]').forEach(b => b.onclick = () => grade(b.dataset.grade));
    pane.querySelector('button[data-suspend]')?.addEventListener('click', async () => {
      try {
        await api.suspendDrill(d.id);
        toast('Drill suspended');
        lastGraded = null; undoBtn.hidden = true; // undo would target a parked drill
        idx++;
        await load();
      } catch (err) { toast(err.message, true); }
    });
    pane.querySelectorAll('button[data-fb]').forEach(b => b.onclick = async () => {
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
      if (state.drill.kind === 'decoy') {
        // Ephemeral detection check: not graded into the ladder, but persist the
        // seen/right tally per machine so the report can show the false-positive rate.
        session.decoys.seen++;
        if (state.verdict.correct) session.decoys.right++;
        api.recordDecoy(state.verdict.correct).catch(() => {});
      } else {
        const saved = await api.reviewDrill(state.drill.id, g, state.verdict.correct, !!roundKey, state.answerMs, { confidence: state.confidence, note: state.note });
        if (saved?.queued) toast('No connection: grade saved on this device, syncs when back online');
        const missedAdded = !state.verdict.correct && !session.missed.some(x => x.id === state.drill.id);
        session.attempts++;
        if (state.verdict.correct) session.correct++;
        if (missedAdded) session.missed.push(state.drill);
        if (state.answerMs != null) session.times.push(state.answerMs);
        if (state.confidence) {
          const c = session.conf[state.confidence] = session.conf[state.confidence] || { n: 0, right: 0 };
          c.n++; if (state.verdict.correct) c.right++;
        }
        lastGraded = { id: state.drill.id, idx, correct: state.verdict.correct, missedAdded, timeAdded: state.answerMs != null, confidence: state.confidence };
        undoBtn.hidden = false;
        import('../app.js').then(m => m.updateDrillBadge());
      }
      idx++;
      await load();
    } catch (err) { toast(err.message, true); }
    finally { grading = false; }
  }

  undoBtn.onclick = async () => {
    if (!lastGraded || grading) return;
    try {
      await api.undoDrill(lastGraded.id);
      session.attempts--;
      if (lastGraded.correct) session.correct--;
      if (lastGraded.missedAdded) session.missed = session.missed.filter(x => x.id !== lastGraded.id);
      if (lastGraded.timeAdded) session.times.pop();
      if (lastGraded.confidence && session.conf[lastGraded.confidence]) { const c = session.conf[lastGraded.confidence]; c.n--; if (lastGraded.correct) c.right--; if (!c.n) delete session.conf[lastGraded.confidence]; }
      idx = lastGraded.idx;
      lastGraded = null;
      undoBtn.hidden = true;
      import('../app.js').then(m => m.updateDrillBadge());
      await load();
    } catch (err) { toast(err.message, true); }
  };

  const onKey = e => {
    if (!state || e.target.matches('input, textarea')) return;
    if (e.key === 'f' || e.key === 'F') { board?.flip(); return; }
    if (state.status === 'guessing' && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); el.querySelector('#giveup')?.click(); return; }
    if (state.status === 'confidence') {
      const conf = { 1: 'sure', 2: 'likely', 3: 'guess' }[e.key];
      if (conf) setConfidence(conf);
      return;
    }
    if (state.status !== 'revealed' || (!state.verdict.correct && state.drill.kind !== 'decoy' && !state.explainDone)) return;
    const map = { 1: 'again', 2: 'good', 3: 'easy' };
    const g = map[e.key];
    if (g && (state.verdict.correct || g === 'again')) grade(g); // wrong answers only grade Again
  };
  document.addEventListener('keydown', onKey);
  await load();
  return { destroy: () => { clearTimer(); board?.destroy(); document.removeEventListener('keydown', onKey); } };
}
