// Admin-only activity log: who signed in from where, and the material actions
// taken. Reads /api/audit (admin-gated); the Log nav item is only revealed for
// admins, and non-admins are redirected away from #/log by the router.
// Paged 50 at a time: the recent entries are the ones being checked, older
// pages stay a click away.
import { api, esc } from '../api.js';
import { makePager } from '../widgets.js';

function when(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso || ''; }
}

function row(e) {
  const who = e.name || e.userId || 'unknown';
  const role = e.role ? ` (${e.role})` : '';
  return `<tr>
    <td class="nowrap muted">${esc(when(e.at))}</td>
    <td>${esc(who + role)}</td>
    <td class="nowrap muted">${esc(e.ip || '')}</td>
    <td>${esc(e.action || '')}</td>
    <td class="muted">${esc(e.detail || '')}</td>
  </tr>`;
}

export async function logView(app) {
  app.innerHTML = '<h1>Activity log</h1><div class="empty">Loading…</div>';
  let events;
  try { ({ events } = await api.audit()); }
  catch (err) { app.innerHTML = `<h1>Activity log</h1><p class="empty">Could not load the log (${esc(err.message)}).</p>`; return; }
  const pg = makePager('logPageSize', { defaultSize: 50 });
  const render = () => {
    const body = events.length
      ? `<table class="log-table"><thead><tr><th>When</th><th>Who</th><th>Where</th><th>Action</th><th>Detail</th></tr></thead><tbody>${pg.slice(events).map(row).join('')}</tbody></table>` + pg.bar(events.length)
      : '<p class="empty">No activity recorded yet.</p>';
    app.innerHTML = `<h1>Activity log</h1>
      <p class="muted">Sign-ins and material actions, newest first.</p>
      ${body}`;
    pg.wire(app, render);
  };
  render();
}
