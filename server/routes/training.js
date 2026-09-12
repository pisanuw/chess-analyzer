// A member's private training surface: the weakness report and its card, the
// repertoire, pattern study notes, puzzles, and the drill deck.
import { getSettings, getPatternNotes } from '../store.js';
import { buildReport, buildPrepCard } from '../report.js';
import { buildRepertoire } from '../repertoire.js';
import { dueDrills, visitorDrills, reviewDrill, undoReview, suspendDrill, restoreSuspended, recordDecoy } from '../drills.js';
import { buildPuzzles } from '../puzzles.js';
import { synthesizeNote } from '../patternnotes.js';
import { normalizeKey } from '../../public/shared.js';
import { currentUser } from '../auth.js';
import { isVisitor } from '../users.js';
import { wrap, effectiveUser, requireAdmin, blockVisitor, visitorNoop, studentRating } from '../http.js';

export function registerTrainingRoutes(app) {
  app.get('/api/report', wrap(async (req, res) => {
    if (await blockVisitor(req, res)) return;
    res.json({ report: await buildReport({ userId: await effectiveUser(req) }) });
  }));

  // One-page markdown card: focus areas, synthesized rules, clock line, study list.
  app.get('/api/report/card', wrap(async (req, res) => {
    if (await blockVisitor(req, res)) return;
    const uid = await effectiveUser(req);
    const report = await buildReport({ userId: uid });
    if (!report.games) return res.status(400).json({ error: 'no analysed games yet' });
    res.type('text/markdown').send(buildPrepCard(report, await getPatternNotes(uid), await getSettings()));
  }));

  app.get('/api/repertoire', wrap(async (req, res) => {
    if (await blockVisitor(req, res)) return;
    res.json({ repertoire: await buildRepertoire({ userId: await effectiveUser(req) }) });
  }));

  // --- pattern study notes ---------------------------------------------------
  app.get('/api/patterns', wrap(async (req, res) => {
    if (await blockVisitor(req, res)) return;
    res.json({ notes: await getPatternNotes(await effectiveUser(req)) });
  }));
  app.post('/api/patterns/synthesize', wrap(async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const uid = await effectiveUser(req);
    const name = String(req.body?.pattern || '').trim();
    if (!name) return res.status(400).json({ error: 'pattern required' });
    const settings = await getSettings();
    const report = await buildReport({ userId: uid });
    const key = normalizeKey(name);
    const pat = report.patterns.find(p => normalizeKey(p.pattern) === key);
    if (!pat) return res.status(404).json({ error: 'pattern not found' });
    // The button always re-synthesizes, even when the automatic pass after an
    // explain job would consider the note fresh; it is the admin's force-refresh.
    const note = await synthesizeNote(pat, uid, settings, await studentRating(req, settings));
    if (!note) return res.status(400).json({ error: 'need at least 2 explained instances' });
    res.json({ note });
  }));

  // Free-solve puzzles derived from analysed games (no schedule). GET, so it also
  // works on the read-only mirror. source: tactics | moments | missed.
  app.get('/api/puzzles', wrap(async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    res.json(await buildPuzzles(req.query.source || 'tactics', limit, undefined, await effectiveUser(req)));
  }));

  // --- drills ----------------------------------------------------------------
  app.get('/api/drills', wrap(async (req, res) => {
    const limit = Number(req.query.limit) || 20;
    const subject = req.query.subject || null;
    const color = ['white', 'black'].includes(req.query.color) ? req.query.color : null;
    // Visitors get an ephemeral scout-derived set; nothing is read from or written to a store.
    if (isVisitor(await currentUser(req))) return res.json(await visitorDrills(limit, undefined, { subject, color }));
    res.json(await dueDrills(limit, {
      pattern: req.query.pattern || null,
      category: req.query.category || null,
      subject, color, // a prep round: one opponent's punish drills, in the colour they will have
      session: req.query.session === '1', // a real training session (not the badge poll): may mix in decoys
      userId: await effectiveUser(req),
    }));
  }));
  app.post('/api/drills/restore-suspended', wrap(async (req, res) => { if (await visitorNoop(req, res)) return; res.json({ restored: await restoreSuspended(await effectiveUser(req)) }); }));
  app.post('/api/drills/decoy', wrap(async (req, res) => { if (await visitorNoop(req, res)) return; res.json({ decoys: await recordDecoy(!!req.body?.correct, await effectiveUser(req)) }); }));
  app.post('/api/drills/:id/review', wrap(async (req, res) => {
    if (await visitorNoop(req, res)) return;
    const b = req.body || {};
    res.json({ drill: await reviewDrill(req.params.id, b.grade || 'good', b.correct, !!b.practice, Number(b.ms), await effectiveUser(req), { confidence: b.confidence, note: b.note, at: b.at }) });
  }));
  app.post('/api/drills/:id/suspend', wrap(async (req, res) => {
    if (await visitorNoop(req, res)) return;
    res.json({ drill: await suspendDrill(req.params.id, req.body?.suspended !== false, await effectiveUser(req)) });
  }));
  app.post('/api/drills/:id/undo', wrap(async (req, res) => {
    if (await visitorNoop(req, res)) return;
    res.json({ drill: await undoReview(req.params.id, await effectiveUser(req)) });
  }));
}
