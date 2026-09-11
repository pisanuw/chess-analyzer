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

test('scout games create punish drills from the position after the mistake', async () => {
  await syncAllDrills();
  const { drills } = await getDrills();
  const own = drills.find(d => d.gameId === 'aaaaaaaaaa01');
  assert.ok(own && !own.kind, 'own game produces a normal drill');
  const punish = drills.filter(d => d.gameId.startsWith('bbbbbbbbbb'));
  assert.equal(punish.length, 2);
  const g = makeGame({ id: 'bbbbbbbbbb01', purpose: 'scout', subject: 'Karpov, A', moments: [{ ply: 1, loss: 35 }] });
  for (const d of punish) {
    assert.equal(d.kind, 'punish');
    assert.equal(d.subject, 'Karpov, A');
    assert.equal(d.sideToMove, 'black'); // subject played white; the student punishes as black
    assert.equal(d.mistakeSan, 'e4');
    assert.equal(d.fen, g.moves[0].fenAfter, 'drill starts AFTER the mistake');
    assert.ok(d.label.startsWith('vs Karpov, A'));
    assert.ok(d.acceptedUci.length >= 1);
  }
});

test('scout API: subject list includes scouted names and own-game opponents', async () => {
  const subjects = (await (await fetch(base + '/api/scout')).json()).subjects;
  // Karpov (scouted) and the own game's opponent, plus the members who are now
  // always prep subjects (kai/nikash/neeraj), so opponents can prep against them.
  const karpov = subjects.find(s => s.subject === 'Karpov, A');
  assert.ok(karpov, 'scouted subject is listed');
  assert.equal(karpov.games, 2);
  assert.equal(karpov.scoutGames, 2);
  const opp = subjects.find(s => s.subject === 'Opponent');
  assert.ok(opp, 'opponents from own games are listed automatically');
  assert.equal(opp.ownGames, 1);
  assert.ok(subjects.some(s => s.member), 'members appear as prep subjects');
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

test('final-move mistakes make no punish drill; scout guesses seed punish drills', async () => {
  writeGame(dir, makeGame({ id: 'cccccccccc01', purpose: 'scout', subject: 'Karpov, A', moments: [{ ply: 3, loss: 30 }], plies: 3 }));
  await syncAllDrills();
  assert.ok(!(await getDrills()).drills.some(d => d.gameId === 'cccccccccc01'), 'no reply position to drill');
  const g = makeGame({ id: 'dddddddddd01', purpose: 'scout', subject: 'Karpov, A', moments: [{ ply: 1, loss: 30 }], plies: 4 });
  writeGame(dir, g);
  const r = await recordGuess(g, 1, 'd2d4', true, { drillThreshold: 20 });
  assert.equal(r.seeded, true);
  assert.equal(r.step, 1, 'correct first-try punishment starts one rung up the ladder');
  const d = (await getDrills()).drills.find(x => x.gameId === 'dddddddddd01');
  assert.equal(d.kind, 'punish');
});

test('prompt endpoint serves the scout framing for scout games', async () => {
  const r = await (await fetch(base + '/api/games/bbbbbbbbbb01/moments/1/prompt')).json();
  assert.ok(r.prompt.includes('Karpov, A'));
  assert.ok(r.system.includes('preparing'), 'system prompt prepares the student, not the mover');
  assert.deepEqual(Object.keys(r.schema.properties), ['pattern', 'category', 'time_pressure', 'explanation', 'key_question', 'concept']);
});

test('prep sheet endpoint: 404 unknown subject, clean error in manual mode', async () => {
  await fetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ llmProvider: 'manual' }) });
  const missing = await fetch(base + '/api/scout/Nobody/prepsheet', { method: 'POST' });
  assert.equal(missing.status, 404);
  const manual = await fetch(base + '/api/scout/' + encodeURIComponent('Karpov, A') + '/prepsheet', { method: 'POST' });
  assert.equal(manual.status, 500);
  assert.match((await manual.json()).error, /manual/);
});

test('scout book: a FIDE export builds a recency-weighted book, listed by FIDE id', async () => {
  const JSON_H = { 'content-type': 'application/json' };
  const PGN = `[Event "A"]
[White "Tester, T"]
[Black "Foe, F"]
[Date "2026.03.01"]
[WhiteElo "2100"]
[BlackElo "2080"]
[Result "1-0"]

1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 1-0

[Event "B"]
[White "Rival, R"]
[Black "Tester, T"]
[Date "2026.04.01"]
[WhiteElo "2090"]
[BlackElo "2110"]
[Result "0-1"]

1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. cxd5 Nxd5 0-1`;
  const res = await fetch(base + '/api/scout/import', { method: 'POST', headers: JSON_H, body: JSON.stringify({ pgn: PGN, filename: 'TesterT_FIDE99887766_Total_2_Games.pgn' }) });
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.fideId, '99887766');
  assert.equal(r.name, 'Tester, T', 'subject name derived as the player in every game');
  assert.equal(r.imported, 2);
  assert.equal(r.dossier.total, 2);
  assert.equal(r.dossier.results.white.games, 1);
  assert.equal(r.dossier.results.black.games, 1);

  const subjects = (await (await fetch(base + '/api/scout')).json()).subjects;
  const t = subjects.find(s => s.subject === 'Tester, T');
  assert.ok(t, 'the book opponent is listed');
  assert.equal(t.fideId, '99887766');
  assert.equal(t.bookGames, 2);

  const book = await (await fetch(base + '/api/scout/book/99887766')).json();
  assert.equal(book.name, 'Tester, T');
  assert.equal(book.dossier.total, 2);
  // Promote status lets the UI hide a no-op analyse. Nothing promoted yet, so the
  // whole subset is queueable and none is present or analysed.
  assert.equal(book.promote.present, 0);
  assert.equal(book.promote.analysed, 0);
  assert.equal(book.promote.queueable, book.promote.total);

  assert.equal((await fetch(base + '/api/scout/book/55555')).status, 404);
  // No FIDE id anywhere (no filename): rejected, not silently mis-keyed.
  assert.equal((await fetch(base + '/api/scout/import', { method: 'POST', headers: JSON_H, body: JSON.stringify({ pgn: PGN }) })).status, 400);
});

test('import learns FIDE ids from PGN tags; /api/players exposes the map', async () => {
  const PGN = `[White "Tagged, A"]
[WhiteFideId "44556677"]
[Black "Other, B"]
[BlackFideId "11223344"]
[Result "1-0"]

1. e4 e5 1-0`;
  await fetch(base + '/api/games/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pgn: PGN, analyse: false, purpose: 'own' }) });
  const players = (await (await fetch(base + '/api/players')).json()).players;
  const a = players.find(p => p.fideId === '44556677');
  const b = players.find(p => p.fideId === '11223344');
  assert.ok(a && a.names.includes('Tagged, A'), 'white id learned from WhiteFideId');
  assert.ok(b && b.names.includes('Other, B'), 'black id learned from BlackFideId');
});

test('FIDE link records an association without a network call; bad input rejected', async () => {
  const H = { 'content-type': 'application/json' };
  assert.equal((await fetch(base + '/api/fide/search?name=a')).status, 400, 'too-short query rejected before any fetch');
  // link without verify: no FIDE call, just records name <-> id in the players map
  const ok = await fetch(base + '/api/players/link', { method: 'POST', headers: H, body: JSON.stringify({ fideId: '39904881', name: 'Pisan, Kai', fideName: 'Pisan, Kai', federation: 'USA' }) });
  assert.equal(ok.status, 200);
  const players = (await (await fetch(base + '/api/players')).json()).players;
  const p = players.find(x => x.fideId === '39904881');
  assert.ok(p && p.names.includes('Pisan, Kai') && p.federation === 'USA');
  assert.equal((await fetch(base + '/api/players/link', { method: 'POST', headers: H, body: JSON.stringify({ fideId: 'abc', name: 'X' }) })).status, 400, 'non-numeric id rejected');
});

test('own games feed a derived dossier for their opponent', async () => {
  // Own game where the OPPONENT (black, named 'Opponent') blunders at ply 2.
  writeGame(dir, makeGame({ id: 'eeeeeeeeee01', color: 'white', moments: [{ ply: 2, loss: 28 }], plies: 4, explained: false }));
  const dossier = await (await fetch(base + '/api/scout/Opponent')).json();
  // aaaaaaaaaa01 (clean for black) + eeeeeeeeee01 (black blunder), both flipped.
  assert.equal(dossier.report.games, 2);
  assert.equal(dossier.report.totalMoments, 1, 'the opponent\'s mistake is derived from stored analysis');
  assert.equal(dossier.report.byCategory.unexplained.count, 1, 'own games contribute engine data, not categories');
  assert.equal(dossier.repertoire.reduce((s, l) => s + l.count, 0), 2);
  assert.ok(dossier.repertoire.every(l => l.color === 'black'), 'repertoire is from the opponent\'s side');
  // No punish drills from own games: a missed punishment is already the player's own drill.
  await syncAllDrills();
  assert.ok(!(await getDrills()).drills.some(d => d.gameId === 'eeeeeeeeee01'));
});
