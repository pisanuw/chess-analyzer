// A member with no scout book (like Kai) is scouted from their own games, so
// they get the opponent-facing prep sheet the requirement asks for, and members
// appear in the shared prep list. Their private deep report stays on /api/report.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempData, makeGame, writeGame } from './helpers.js';

process.env.DATA_DIR = tempData();
const { buildReport } = await import('../server/report.js');
const { app } = await import('../server/index.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const dir = process.env.DATA_DIR;
// makeGame defaults White to 'Kai Pisan' for a white game: these are Kai's own
// analysed games (owner resolves to kai). No scout book for Kai.
writeGame(dir, makeGame({ id: 'aa11aa11aa11', color: 'white', moments: [{ ply: 1, loss: 30 }] }));
writeGame(dir, makeGame({ id: 'aa22aa22aa22', color: 'white', moments: [{ ply: 1, loss: 22 }] }));

test('a member with no book is scouted from their own games', async () => {
  const rep = await buildReport({ purpose: 'scout', subject: 'Kai Pisan' });
  assert.equal(rep.games, 2, "both of Kai's own analysed games back the scout view");
  assert.ok(!rep.drillStats || !rep.drillStats.attempts, 'scout view carries no private drill stats');
  const none = await buildReport({ purpose: 'scout', subject: 'Nobody Here' });
  assert.equal(none.games, 0);
});

test('/api/scout lists members as prep subjects', async () => {
  const { subjects } = await (await fetch(base + '/api/scout')).json();
  const kai = subjects.find(s => s.subject === 'Kai Pisan');
  assert.ok(kai, 'Kai appears as a prep subject');
  assert.equal(kai.member, true);
  assert.ok(kai.selfGames >= 2, 'his own-game count is surfaced');
  // Members with no games yet still appear so they can be prepped once seeded.
  assert.ok(subjects.some(s => s.member && s.subject !== 'Kai Pisan'));
});
