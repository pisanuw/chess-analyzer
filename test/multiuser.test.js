// Per-user ownership of games: own games are private to their owner, scout games
// are shared, and the report/repertoire read-paths are scoped by userId. Set
// DATA_DIR before importing (store.js reads it at import).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempData, makeGame, writeGame } from './helpers.js';

process.env.DATA_DIR = tempData();
const { listGames, listAllGames, getGame, saveGame, deleteGame, ownsGame, DEFAULT_USER } = await import('../server/store.js');
const { buildReport } = await import('../server/report.js');
const { buildRepertoire } = await import('../server/repertoire.js');

const dir = process.env.DATA_DIR;
const ids = list => new Set(list.map(g => g.id));

// kai: one legacy own game (no owner field) + one explicit owner:'kai'.
// nikash: one own game. Plus one shared scout game.
writeGame(dir, makeGame({ id: 'aaaaaaaaaaa1', moments: [{ ply: 1, loss: 25 }] }));                              // legacy own -> kai
writeGame(dir, makeGame({ id: 'aaaaaaaaaaa2', owner: 'kai', moments: [{ ply: 1, loss: 25 }] }));               // explicit kai
writeGame(dir, makeGame({ id: 'bbbbbbbbbbb1', owner: 'nikash', moments: [{ ply: 1, loss: 25 }] }));            // nikash own
writeGame(dir, makeGame({ id: 'ccccccccccc1', purpose: 'scout', subject: 'Karpov, A', moments: [{ ply: 1, loss: 25 }] })); // shared scout

test('listGames isolates own games by owner and shares scout games', async () => {
  const kai = ids(await listGames('kai'));
  assert.ok(kai.has('aaaaaaaaaaa1') && kai.has('aaaaaaaaaaa2'), 'kai sees own games incl legacy');
  assert.ok(kai.has('ccccccccccc1'), 'kai sees the shared scout game');
  assert.ok(!kai.has('bbbbbbbbbbb1'), 'kai does not see nikash own game');

  const nik = ids(await listGames('nikash'));
  assert.ok(nik.has('bbbbbbbbbbb1') && nik.has('ccccccccccc1'), 'nikash sees own + scout');
  assert.ok(!nik.has('aaaaaaaaaaa1') && !nik.has('aaaaaaaaaaa2'), 'nikash does not see kai own games');

  assert.equal((await listAllGames()).length, 4);
});

test('listGames default userId is DEFAULT_USER', async () => {
  assert.equal(DEFAULT_USER, 'kai');
  assert.deepEqual(ids(await listGames()), ids(await listGames('kai')));
});

test('index entry carries a resolved owner', async () => {
  const byId = Object.fromEntries((await listAllGames()).map(g => [g.id, g]));
  assert.equal(byId['aaaaaaaaaaa1'].owner, 'kai');    // legacy resolves to the default user
  assert.equal(byId['bbbbbbbbbbb1'].owner, 'nikash');
  assert.equal(byId['ccccccccccc1'].owner, null);     // scout is unowned (shared)
});

test('getGame enforces ownership only when a userId is passed', async () => {
  assert.ok(await getGame('bbbbbbbbbbb1'));                 // default '*': no ownership check
  assert.ok(await getGame('bbbbbbbbbbb1', 'nikash'));       // owner may read
  assert.equal(await getGame('bbbbbbbbbbb1', 'kai'), null); // non-owner may not
  assert.ok(await getGame('ccccccccccc1', 'kai'));          // scout is shared
});

test('saveGame stamps owner on an unowned own game; scout stays unowned; existing owner kept', async () => {
  await saveGame(makeGame({ id: 'ddddddddddd1', moments: [] }), 'neeraj');
  assert.equal((await getGame('ddddddddddd1')).owner, 'neeraj');

  await saveGame(makeGame({ id: 'eeeeeeeeeee1', purpose: 'scout', subject: 'X', moments: [] }), 'neeraj');
  assert.equal((await getGame('eeeeeeeeeee1')).owner, undefined);

  await saveGame(makeGame({ id: 'bbbbbbbbbbb1', owner: 'nikash', moments: [] }), 'kai'); // wrong caller, kept
  assert.equal((await getGame('bbbbbbbbbbb1')).owner, 'nikash');
});

test('deleteGame respects ownership when a userId is passed', async () => {
  await deleteGame('aaaaaaaaaaa2', 'nikash');   // not nikash's: no-op
  assert.ok(await getGame('aaaaaaaaaaa2'));
  await deleteGame('aaaaaaaaaaa2', 'kai');       // owner: deletes
  assert.equal(await getGame('aaaaaaaaaaa2'), null);
});

test('ownsGame semantics', () => {
  assert.equal(ownsGame({ purpose: 'own', owner: 'kai' }, 'kai'), true);
  assert.equal(ownsGame({ purpose: 'own', owner: 'kai' }, 'nikash'), false);
  assert.equal(ownsGame({ purpose: 'own' }, 'kai'), true);       // legacy -> default user
  assert.equal(ownsGame({ purpose: 'scout' }, 'nikash'), true);  // scout shared
  assert.equal(ownsGame({ purpose: 'own', owner: 'nikash' }, '*'), true);
});

test('buildReport and buildRepertoire are scoped per user', async () => {
  // aaaaaaaaaaa2 was deleted above, so kai now has one own game (the legacy one).
  assert.equal((await buildReport({ userId: 'kai' })).games, 1);
  assert.equal((await buildReport({ userId: 'nikash' })).games, 1);

  const total = rep => rep.reduce((n, l) => n + l.count, 0);
  assert.equal(total(await buildRepertoire({ userId: 'kai' })), 1);
  assert.equal(total(await buildRepertoire({ userId: 'nikash' })), 1);
});
