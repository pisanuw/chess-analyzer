// Admin-only page to manage the roster: view everyone on the allowlist, add
// visitors and players, and remove admin-managed entries. Writes land in
// data/users.json on the producer and reach the mirror at the next publish.
import { api, esc, toast, busy } from '../api.js';

const ROLE_ORDER = { admin: 0, member: 1, visitor: 2 };

function roleChip(role) {
  const cls = role === 'admin' ? 'blunder' : role === 'member' ? 'good' : 'inaccuracy';
  return `<span class="chip ${cls}">${esc(role)}</span>`;
}

function row(u) {
  return `<tr>
    <td>${esc(u.displayName || u.id)}</td>
    <td>${roleChip(u.role)}</td>
    <td class="muted">${u.fideId ? esc(u.fideId) : ''}</td>
    <td class="muted">${(u.emails || []).map(esc).join(', ')}</td>
    <td>${u.managed ? `<button class="small" data-remove="${esc(u.id)}" title="Remove from data/users.json">Remove</button>` : '<span class="muted"><small>built-in</small></span>'}</td>
  </tr>`;
}

export async function adminView(root) {
  root.innerHTML = '<h1>Admin</h1><div class="empty">Loading…</div>';
  let users;
  try { ({ users } = await api.adminUsers()); }
  catch (err) { root.innerHTML = `<h1>Admin</h1><p class="empty">Could not load the roster (${esc(err.message)}).</p>`; return; }
  users.sort((a, b) => (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || String(a.displayName).localeCompare(String(b.displayName)));

  root.innerHTML = `
    <h1>Admin</h1>
    <p class="muted">Add visitors and players to the allowlist. Changes are saved on this machine; run <code>npm run publish-web</code> to push them to the hosted site. Built-in members and env-based visitors show as "built-in" and are edited in the environment.</p>

    <details class="acc" open><summary><span class="acc-title">Add a visitor</span></summary><div class="acc-body">
      <p class="muted" style="margin-top:0">Visitors see the shared scouting library and can practise drills, but nothing is recorded and they have no report or repertoire.</p>
      <div class="row" style="gap:6px; align-items:center">
        <input type="email" id="v-email" placeholder="visitor@example.com" style="padding:6px 10px; font-size:14px; min-width:24ch">
        <button class="small primary" id="add-visitor">Add visitor</button>
      </div>
    </div></details>

    <details class="acc" open><summary><span class="acc-title">Add a player</span></summary><div class="acc-body">
      <p class="muted" style="margin-top:0">A player is a full member with their own games, report, repertoire, and drills.</p>
      <div class="row" style="gap:6px; align-items:center; flex-wrap:wrap">
        <input type="text" id="p-name" placeholder="Display name" style="padding:6px 10px; font-size:14px">
        <input type="email" id="p-email" placeholder="player@example.com" style="padding:6px 10px; font-size:14px; min-width:22ch">
        <input type="text" id="p-fide" inputmode="numeric" placeholder="FIDE id (optional)" style="padding:6px 10px; font-size:14px; width:16ch">
        <input type="text" id="p-names" placeholder="PGN name matches, semicolon-separated e.g. Last, First; F Last (optional)" style="padding:6px 10px; font-size:14px; min-width:30ch">
        <button class="small primary" id="add-player">Add player</button>
      </div>
    </div></details>

    <details class="acc" open><summary><span class="acc-title">Roster (${users.length})</span></summary><div class="acc-body">
      <table><thead><tr><th>Name</th><th>Role</th><th>FIDE</th><th>Emails</th><th></th></tr></thead>
      <tbody id="roster-body">${users.map(row).join('')}</tbody></table>
    </div></details>

    <details class="acc" open><summary><span class="acc-title">Claude analysis (home machine)</span></summary><div class="acc-body">
      <p class="muted" style="margin-top:0">Everything the claude subscription and the engine still owe, in one place. Explanations run through the job queue (progress in the header); the clash and pattern-note runs happen right here and report as they go.</p>
      <div id="llm-work"><span class="muted">Checking…</span></div>
    </div></details>`;

  const reload = () => adminView(root);
  renderLlmWork(root.querySelector('#llm-work'));

  root.querySelector('#add-visitor').onclick = () => busy(root.querySelector('#add-visitor'), async () => {
    const email = root.querySelector('#v-email').value.trim();
    try { await api.addVisitor(email); toast(`Added visitor ${email}`); reload(); }
    catch (err) { toast(err.message || 'Could not add the visitor', true); }
  });

  root.querySelector('#add-player').onclick = () => busy(root.querySelector('#add-player'), async () => {
    const payload = {
      displayName: root.querySelector('#p-name').value.trim(),
      email: root.querySelector('#p-email').value.trim(),
      fideId: root.querySelector('#p-fide').value.trim() || null,
      playerNames: root.querySelector('#p-names').value.trim(),
    };
    try { await api.addPlayer(payload); toast(`Added player ${payload.displayName}`); reload(); }
    catch (err) { toast(err.message || 'Could not add the player', true); }
  });

  root.querySelectorAll('button[data-remove]').forEach(b => b.onclick = () => busy(b, async () => {
    if (!confirm('Remove this user from the allowlist?')) return;
    try { await api.removeUser(b.dataset.remove); toast('Removed'); reload(); }
    catch (err) { toast(err.message || 'Could not remove', true); }
  }));
}

/** The pending home-machine work, one row per kind with a run button. Bulk
 * runs go sequentially (one CLI call at a time, like the job queue) with a
 * live progress line; a failed item is reported and skipped, not fatal. */
async function renderLlmWork(el) {
  let status;
  try { status = await api.adminAnalysisStatus(); }
  catch (err) { el.innerHTML = `<span class="muted">Could not check: ${esc(err.message)}</span>`; return; }
  const narrTotal = status.narrations.reduce((n, b) => n + b.pending.length, 0);
  const patTotal = status.patternNotes.reduce((n, m) => n + m.pending, 0);
  const explainTotal = status.explain.own + status.explain.scout;
  const rows = [];
  rows.push(explainTotal
    ? `<tr><td>Explanations</td><td>${explainTotal} analysed game${explainTotal === 1 ? '' : 's'} with unexplained moments (${status.explain.own} own, ${status.explain.scout} scout)</td>
       <td><button class="small primary" id="llm-explain">Explain all</button></td></tr>`
    : '<tr><td>Explanations</td><td class="muted">every analysed game is explained</td><td></td></tr>');
  rows.push(narrTotal
    ? `<tr><td>Opening clash</td><td>${narrTotal} narration${narrTotal === 1 ? '' : 's'} missing or outdated across ${status.narrations.length} opponent book${status.narrations.length === 1 ? '' : 's'} (one per member: their openings, their lines)</td>
       <td><button class="small primary" id="llm-narrate" title="For each book and member: extend the prep-end leaves with the engine, then have the coach explain the key lines">Extend &amp; narrate all</button></td></tr>`
    : '<tr><td>Opening clash</td><td class="muted">every book has a current narration for every member</td><td></td></tr>');
  rows.push(patTotal
    ? `<tr><td>Pattern notes</td><td>${patTotal} pattern${patTotal === 1 ? '' : 's'} ready to synthesize (${status.patternNotes.map(m => `${esc(m.user)}: ${m.pending}`).join(', ')})</td>
       <td><button class="small primary" id="llm-patterns" title="About a minute per note">Synthesize</button></td></tr>`
    : '<tr><td>Pattern notes</td><td class="muted">every recurring pattern has a current note</td><td></td></tr>');
  rows.push('<tr><td>Prep sheets</td><td class="muted">generated and refreshed per opponent from the <a href="#/scout">Players</a> page (the dots show which are ready, to do, or stale)</td><td></td></tr>');
  el.innerHTML = `<table><thead><tr><th>Work</th><th>Pending</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>
    <p class="muted" id="llm-progress" hidden></p>`;
  const progress = el.querySelector('#llm-progress');
  const say = msg => { progress.hidden = false; progress.textContent = msg; };

  el.querySelector('#llm-explain')?.addEventListener('click', e => busy(e.currentTarget, async () => {
    try {
      const r = await api.analyseAll({ explain: true });
      toast(`${r.queued.length} job${r.queued.length === 1 ? '' : 's'} queued; progress shows in the header`);
    } catch (err) { toast(err.message, true); }
  }));

  el.querySelector('#llm-narrate')?.addEventListener('click', e => busy(e.currentTarget, async () => {
    const work = status.narrations.flatMap(b => b.pending.map(p => ({ fideId: b.fideId, name: b.name, user: p.user })));
    let done = 0, failed = 0;
    for (const w of work) {
      say(`Opening clash ${done + failed + 1}/${work.length}: ${w.name} for ${w.user} (extending leaves, then narrating)…`);
      try {
        await api.scoutClash(w.fideId, { extend: true, user: w.user }); // engine fills the prep-end leaves (cache-first)
        await api.narrateClash(w.fideId, w.user);                       // the coach explains the key lines
        done++;
      } catch (err) {
        failed++;
        console.error(`narration failed for ${w.name}/${w.user}: ${err.message}`);
      }
    }
    say(`Opening clash: ${done} narrated${failed ? `, ${failed} failed (see the browser console)` : ''}.`);
    renderLlmWork(el);
  }));

  el.querySelector('#llm-patterns')?.addEventListener('click', e => busy(e.currentTarget, async () => {
    say(`Synthesizing ${patTotal} pattern note${patTotal === 1 ? '' : 's'} (about a minute each)…`);
    try {
      const { results } = await api.syncPatternNotes();
      const made = results.reduce((n, r) => n + r.synthesized, 0);
      say(`Pattern notes: ${made} synthesized.`);
    } catch (err) { say(`Pattern notes failed: ${err.message}`); }
    renderLlmWork(el);
  }));
}
