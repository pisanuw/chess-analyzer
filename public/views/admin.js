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
    </div></details>`;

  const reload = () => adminView(root);

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
