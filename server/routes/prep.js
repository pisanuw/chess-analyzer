// The "Prepare for a game" flow: a member's upcoming games, the composed prep
// payload for one opponent in one colour, and the marks that track the deck.
import { getSettings } from '../store.js';
import { buildPrep } from '../prep.js';
import { listUpcoming, addUpcoming, removeUpcoming } from '../upcoming.js';
import { markPrep } from '../prepmarks.js';
import { currentUser } from '../auth.js';
import { isVisitor } from '../users.js';
import { wrap, effectiveUser, blockVisitor, visitorNoop } from '../http.js';

export function registerPrepRoutes(app) {
  app.get('/api/upcoming', wrap(async (req, res) => {
    if (isVisitor(await currentUser(req))) return res.json({ upcoming: [] });
    res.json({ upcoming: await listUpcoming(await effectiveUser(req)) });
  }));
  app.post('/api/upcoming', wrap(async (req, res) => {
    if (await blockVisitor(req, res)) return;
    res.json({ entry: await addUpcoming(await effectiveUser(req), req.body || {}) });
  }));
  app.delete('/api/upcoming/:id', wrap(async (req, res) => {
    if (await blockVisitor(req, res)) return;
    const ok = await removeUpcoming(await effectiveUser(req), req.params.id);
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'not found' });
  }));

  // One opponent, one colour (the student's), optionally one time-control class.
  app.get('/api/prep/:subject', wrap(async (req, res) => {
    const myColor = req.query.color === 'black' ? 'black' : 'white';
    const tc = ['classical', 'rapid', 'blitz'].includes(req.query.tc) ? req.query.tc : 'all';
    const uid = await effectiveUser(req);
    const visitor = isVisitor(await currentUser(req));
    const prep = await buildPrep({ uid, subject: req.params.subject, myColor, tc, settings: await getSettings(), visitor });
    if (!prep.report.games && !prep.book && !prep.headToHead.games.length) return res.status(404).json({ error: 'nothing known about this opponent yet' });
    res.json({ prep });
  }));

  // A deck item was attempted: remembered per member so the page shows progress
  // and the Home page can say how far the prep has come.
  app.post('/api/prep/mark', wrap(async (req, res) => {
    if (await visitorNoop(req, res)) return;
    const id = String(req.body?.id || '');
    if (!/^(line:|[a-f0-9]{12}:)/.test(id)) return res.status(400).json({ error: 'unknown drill id' });
    res.json({ mark: await markPrep(id, !!req.body?.correct, await effectiveUser(req)) });
  }));
}
