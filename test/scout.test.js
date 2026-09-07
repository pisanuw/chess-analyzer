import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempData, makeGame, writeGame } from './helpers.js';

process.env.DATA_DIR = tempData();
const dir = process.env.DATA_DIR;

// One own game and two scout games of the same subject.
writeGame(dir, makeGame({ id: 'aaaaaaaaaa01', moments: [{ ply: 1, loss: 25 }] }));
writeGame(dir, makeGame({ id: 'bbbbbbbbbb01', purpose: 'scout', subject: 'Karpov, A', category: 'endgame-technique', moments: [{ ply: 1, loss: 35 }] }));
writeGame(dir, makeGame({ id: 'bbbbbbbbbb02', purpose: 'scout', subject: 'Karpov, A', category: 'endgame-technique', date: '2026.01.02', moments: [{ ply: 1, loss: 22 }] }));

const { buildReport } = await import('../server/report.js');
const { buildRepertoire } = await import('../server/repertoire.js');
const { syncAllDrills, recordGuess } = await import('../server/drills.js');
const { getDrills } = await import('../server/store.js');
const { app } = await import('../server/index.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

test('own report excludes scout games; scout report sees only the subject', async () => {
  const own = await buildReport();
  assert.equal(own.games, 1);
  assert.equal(own.byCategory['endgame-technique'].count, 0, 'opponent mistakes must not pollute the player profile');
  const scout = await buildReport({ purpose: 'scout', subject: 'Karpov, A' });
  assert.equal(scout.games, 2);
  assert.equal(scout.byCategory['endgame-technique'].count, 2);
  assert.equal(scout.byCategory.calculation.count, 0);
  assert.equal(scout.drillStats, null, 'drill stats are the player\'s, not the subject\'s');
});

test('own repertoire excludes scout games and vice versa', async () => {
  const own = await buildRepertoire();
  assert.equal(own.reduce((s, l) => s + l.count, 0), 1);
  const theirs = await buildRepertoire({ purpose: 'scout', subject: 'Karpov, A' });
  assert.equal(theirs.reduce((s, l) => s + l.count, 0), 2);
});

test('scout games create no drills and record no seeding guesses', async () => {
  await syncAllDrills();
  const { drills } = await getDrills();
  assert.ok(drills.some(d => d.gameId === 'aaaaaaaaaa01'), 'own game produces drills');
  assert.ok(!drills.some(d => d.gameId.startsWith('bbbbbbbbbb')), 'scout games must not enter the drill deck');
  const g = makeGame({ id: 'bbbbbbbbbb01', purpose: 'scout', subject: 'Karpov, A', moments: [{ ply: 1, loss: 35 }] });
  const r = await recordGuess(g, 1, 'd2d4', true, { drillThreshold: 20 });
  assert.equal(r.seeded, false);
});

test('scout API: subject list and dossier', async () => {
  const subjects = (await (await fetch(base + '/api/scout')).json()).subjects;
  assert.equal(subjects.length, 1);
  assert.equal(subjects[0].subject, 'Karpov, A');
  assert.equal(subjects[0].games, 2);
  const res = await fetch(base + '/api/scout/' + encodeURIComponent('Karpov, A'));
  assert.equal(res.status, 200);
  const dossier = await res.json();
  assert.equal(dossier.report.games, 2);
  assert.ok(Array.isArray(dossier.repertoire));
  const missing = await fetch(base + '/api/scout/Nobody');
  assert.equal(missing.status, 404);
});

test('import tags purpose and subject, detects the subject colour', async () => {
  const PGN = `[White "Karpov, A"]\n[Black "Other, B"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0`;
  const res = await fetch(base + '/api/games/import', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pgn: PGN, analyse: false, purpose: 'scout', subject: 'Karpov' }),
  });
  const r = await res.json();
  assert.equal(r.imported.length, 1);
  const games = (await (await fetch(base + '/api/games')).json()).games;
  const g = games.find(x => x.id === r.imported[0]);
  assert.equal(g.purpose, 'scout');
  assert.equal(g.subject, 'Karpov');
  assert.equal(g.playerColor, 'white');
  const noSubject = await fetch(base + '/api/games/import', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pgn: PGN, purpose: 'scout' }),
  });
  assert.equal(noSubject.status, 400);
});
