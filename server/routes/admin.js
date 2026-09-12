// Admin-only: the activity log, the roster (add and remove visitors and
// players), and the home-machine analysis overview (what claude/engine work is
// pending across the app). Roster writes land in data/users.json on the
// producer; publish bundles it to the mirror.
import { readAudit } from '../audit.js';
import { getUsers, publicUser, addVisitor, addMember, managedUsers, removeRosterEntry, listMembers } from '../users.js';
import { listAllGames, listScoutBooks, getClashNotes, getPatternNotes } from '../store.js';
import { clashNoteKey } from '../clash.js';
import { clashNarrationVersion } from '../prompts.js';
import { buildReport } from '../report.js';
import { notesNeeded, syncPatternNotes } from '../patternnotes.js';
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

  // Everything the home machine's claude subscription (and engine) still owes:
  // unexplained analysed games, opening-clash narrations that are missing,
  // outdated, or older than a re-imported book (one per book and member, since
  // the clash crosses the member's own openings with the book), and pattern
  // notes waiting on synthesis. The Admin page renders this as one card with a
  // run button per row; the endpoint only reports, running stays with the
  // existing routes so nothing here can start work by accident.
  app.get('/api/admin/analysis-status', wrap(async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const games = await listAllGames();
    const explain = games.filter(g => g.status === 'analysed' && (g.moments || 0) > 0);
    const members = await listMembers();
    const notes = await getClashNotes();
    const version = clashNarrationVersion();
    const narrations = [];
    for (const b of await listScoutBooks()) {
      const pending = [];
      for (const m of members) {
        const n = notes[clashNoteKey(b.fideId, m.id)];
        if (!n) pending.push({ user: m.id, why: 'missing' });
        else if (n.version !== version) pending.push({ user: m.id, why: 'format' });
        else if (b.importedAt && n.createdAt < b.importedAt) pending.push({ user: m.id, why: 'stale' });
      }
      if (pending.length) narrations.push({ fideId: b.fideId, name: b.name, pending });
    }
    const patternNotes = [];
    for (const m of members) {
      const report = await buildReport({ userId: m.id }); // memoized per data change
      const todo = report.games ? notesNeeded(report.patterns, await getPatternNotes(m.id)) : [];
      if (todo.length) patternNotes.push({ user: m.id, pending: todo.length });
    }
    res.json({
      explain: { own: explain.filter(g => g.purpose !== 'scout').length, scout: explain.filter(g => g.purpose === 'scout').length },
      narrations, patternNotes,
    });
  }));

  // Catch pattern notes up for every member in one call (the same sync that
  // runs after each explain job). Sequential LLM calls, so the request can
  // take a minute per pending note; the button says so.
  app.post('/api/admin/pattern-notes/sync', wrap(async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const results = [];
    for (const m of await listMembers()) {
      const r = await syncPatternNotes(m.id);
      if (r.synthesized || r.failed) results.push({ user: m.id, ...r });
    }
    res.json({ results });
  }));
}
