// Admin-only: the activity log and the roster (add and remove visitors and
// players). Roster writes land in data/users.json on the producer; publish
// bundles it to the mirror.
import { readAudit } from '../audit.js';
import { getUsers, publicUser, addVisitor, addMember, managedUsers, removeRosterEntry } from '../users.js';
import { wrap, requireAdmin } from '../http.js';

export function registerAdminRoutes(app) {
  // Admin activity log: who signed in from where, and the material actions taken.
  app.get('/api/audit', wrap(async (req, res) => {
    if (!(await requireAdmin(req, res))) return; // GET, so requireAdmin does not self-log
    res.json({ events: await readAudit(Math.min(500, Number(req.query.limit) || 200)) });
  }));

  app.get('/api/admin/users', wrap(async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const managed = new Set((await managedUsers()).map(u => u.id));
    const users = (await getUsers()).map(u => ({ ...publicUser(u), emails: u.emails || [], managed: managed.has(u.id) }));
    res.json({ users });
  }));
  app.post('/api/admin/visitors', wrap(async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    try { res.json({ ok: true, user: publicUser(await addVisitor(req.body?.email)) }); }
    catch (err) { res.status(400).json({ error: err.message }); }
  }));
  app.post('/api/admin/players', wrap(async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    try { res.json({ ok: true, user: publicUser(await addMember({ email: req.body?.email, displayName: req.body?.displayName, fideId: req.body?.fideId, playerNames: req.body?.playerNames })) }); }
    catch (err) { res.status(400).json({ error: err.message }); }
  }));
  app.delete('/api/admin/users/:id', wrap(async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const ok = await removeRosterEntry(req.params.id);
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'not an admin-managed user (built-ins and env visitors cannot be removed here)' });
  }));
}
