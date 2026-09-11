// Seeding a member's own games from their scout book (Phase 8 mechanism). Uses
// analyse:false so no engine runs; asserts the own-game records are created with
// the member as owner and a namespaced id (so the shared scout copy, if any, is
// never clobbered).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempData } from './helpers.js';

process.env.DATA_DIR = tempData();
const { listGames, getGame } = await import('../server/store.js');
const { app } = await import('../server/index.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// A small FIDE book for Nikash (DEFAULT_USERS nikash.fideId = 30960967), recent
// and on-strength so scoutDossier selects the games.
const BOOK_PGN = [
  '[Event "T1"]\n[Date "2026.06.01"]\n[White "Vemparala, Nikash"]\n[Black "Foe, One"]\n[WhiteElo "2000"]\n[BlackElo "1990"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0',
  '[Event "T2"]\n[Date "2026.07.01"]\n[White "Rival, Two"]\n[Black "Vemparala, Nikash"]\n[WhiteElo "2010"]\n[BlackElo "2000"]\n[Result "0-1"]\n\n1. d4 Nf6 2. c4 g6 0-1',
  '[Event "T3"]\n[Date "2026.08.01"]\n[White "Vemparala, Nikash"]\n[Black "Foe, Three"]\n[WhiteElo "2005"]\n[BlackElo "1980"]\n[Result "1-0"]\n\n1. e4 c5 2. Nf3 d6 1-0',
].join('\n\n');

test('import a member book, then seed their own games', async () => {
  const imp = await (await post('/api/scout/import', { pgn: BOOK_PGN, fideId: '30960967', name: 'Vemparala, Nikash' })).json();
  assert.equal(imp.imported, 3, 'the three-game book imported');

  const r = await (await post('/api/users/nikash/seed', { analyse: false })).json();
  assert.ok(r.analysisSet >= 1, 'the dossier selected games to seed');
  assert.equal(r.seeded, r.analysisSet, 'every selected game was seeded as an own game');
  assert.equal(r.queued, 0, 'analyse:false does not queue engine work');

  // The seeded games are Nikash's own, with a member-namespaced id and provenance.
  const mine = await listGames('nikash');
  assert.equal(mine.length, r.seeded);
  const g = await getGame(mine[0].id, 'nikash');
  assert.equal(g.purpose, 'own');
  assert.equal(g.owner, 'nikash');
  assert.equal(g.seededFrom.fideId, '30960967');
  assert.notEqual(g.id, g.seededFrom.gameId, 'own-game id is namespaced, not the book/scout id');
  assert.ok(['white', 'black'].includes(g.playerColor), 'the member side was detected');
});

test('re-seeding is idempotent', async () => {
  const r = await (await post('/api/users/nikash/seed', { analyse: false })).json();
  assert.equal(r.seeded, 0);
  assert.ok(r.already >= 1);
});

test('seed rejects a non-member and a member with no book', async () => {
  assert.equal((await post('/api/users/yusuf/seed', {})).status, 404); // admin, not a member
  assert.equal((await post('/api/users/kai/seed', {})).status, 404);   // member but no scout book imported
});
