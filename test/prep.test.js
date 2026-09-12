// The "Prepare for a game" flow: upcoming games, the composed prep payload for
// one opponent in one colour, the line-flashcard deck, and progress marks.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempData, makeGame, writeGame } from './helpers.js';

process.env.DATA_DIR = tempData();
const dir = process.env.DATA_DIR;
// Karpov scouted as White twice (moments at ply 1 give punish drills for the
// student as Black); one own game of the primary member against Karpov.
writeGame(dir, makeGame({ id: 'bbbbbbbbbb01', purpose: 'scout', subject: 'Karpov, A', moments: [{ ply: 1, loss: 35 }], plies: 4 }));
writeGame(dir, makeGame({ id: 'bbbbbbbbbb02', purpose: 'scout', subject: 'Karpov, A', moments: [{ ply: 1, loss: 22 }], date: '2026.02.02', plies: 4 }));
const own = makeGame({ id: 'aaaaaaaaaa01', color: 'black', moments: [{ ply: 2, loss: 25 }], plies: 4 });
own.headers.White = 'Karpov, A';
writeGame(dir, own);

const { parseGame } = await import('../server/pgn.js');
const { buildStudentIndex, buildOpponentIndex, assembleClashForest } = await import('../server/clash.js');
const { buildLineDrills, sparringPositions } = await import('../server/prep.js');
const { syncAllDrills } = await import('../server/drills.js');
const { app } = await import('../server/index.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
const json = (method, path, body) => fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });

function pgnOf(sans, result = '1-0') {
  let mt = '';
  for (let i = 0; i < sans.length; i++) { if (i % 2 === 0) mt += `${i / 2 + 1}. `; mt += sans[i] + ' '; }
  return `[White "W"]\n[Black "B"]\n[Result "${result}"]\n\n${mt}${result}`;
}
function studentGame(color, sans) {
  const { moves } = parseGame(pgnOf(sans));
  return { playerColor: color, headers: { Result: '1-0' }, analysis: { moves: moves.map(m => ({ ...m, evalAfter: 10, accuracy: 95, loss: 0, playedRank: 1, phase: 'opening' })) } };
}
const bookGame = (color, sans) => ({ color, date: '2026.05.01', result: '1-0', oppElo: 2000, posKey: 'std', pgn: pgnOf(sans) });

test('line flashcards follow the predicted lines and ask for the student\'s own move', async () => {
  const student = buildStudentIndex([
    studentGame('black', ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4']), studentGame('black', ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4']),
  ]);
  const book = { fideId: '777', name: 'Opp', importedAt: 'x', games: [bookGame('white', ['e4', 'c6', 'd4', 'd5', 'Nc3']), bookGame('white', ['e4', 'c6', 'd4', 'd5', 'Nc3'])] };
  const { index, coverage } = await buildOpponentIndex(book, { scoutMaxAgeYears: 3, scoutHalfLifeDays: 540 }, { now: new Date('2026-09-01') });
  const clash = assembleClashForest({ oppIndex: index, coverage, student, book });
  const drills = buildLineDrills(clash, 'black', 'Opp', '777');
  assert.ok(drills.length >= 2, 'a card per student node on the line');
  assert.ok(drills.every(d => d.kind === 'line' && d.sideToMove === 'black' && d.acceptedUci.length && d.id.startsWith('line:777:')));
  const first = drills[0];
  assert.equal(first.ply, 1, 'the first card is the reply to 1.e4');
  assert.equal(first.bestSan, 'c6');
  assert.deepEqual(first.path, ['e4']);
  assert.equal(first.label, 'Prep vs Opp: 1.e4');
  assert.equal(buildLineDrills(clash, 'white', 'Opp', '777').length, 0, 'no white games: no white cards');
  const spar = sparringPositions(clash, 'black');
  assert.ok(spar.length >= 1 && spar[0].fen && spar[0].sanLine.startsWith('1.e4 c6'), 'sparring starts from a predicted position');
});

test('upcoming games: add, list soonest first, remove, validate', async () => {
  assert.equal((await json('POST', '/api/upcoming', { subject: 'Karpov, A', color: 'white', date: '2026-10-05' })).status, 200);
  const later = await (await json('POST', '/api/upcoming', { subject: 'Karpov, A', color: 'black', date: '2026-09-20', timeControl: 'rapid' })).json();
  assert.equal(later.entry.color, 'black');
  assert.equal(later.entry.timeControl, 'rapid');
  const { upcoming } = await (await json('GET', '/api/upcoming')).json();
  assert.equal(upcoming.length, 2);
  assert.equal(upcoming[0].date, '2026-09-20', 'soonest first');
  assert.equal((await json('POST', '/api/upcoming', { subject: '', color: 'white' })).status, 400);
  assert.equal((await json('POST', '/api/upcoming', { subject: 'X', color: 'green' })).status, 400);
  assert.equal((await json('POST', '/api/upcoming', { subject: 'X', color: 'white', date: 'soon' })).status, 400);
  assert.equal((await json('DELETE', `/api/upcoming/${later.entry.id}`)).status, 200);
  assert.equal((await json('DELETE', `/api/upcoming/${later.entry.id}`)).status, 404);
  assert.equal((await (await json('GET', '/api/upcoming')).json()).upcoming.length, 1);
});

test('the prep payload composes the colour-cut dossier, head to head, and a punish deck; marks track progress', async () => {
  await syncAllDrills();
  const r = await json('GET', '/api/prep/' + encodeURIComponent('Karpov, A') + '?color=black');
  assert.equal(r.status, 200);
  const { prep } = await r.json();
  assert.equal(prep.myColor, 'black');
  assert.equal(prep.oppColor, 'white');
  assert.equal(prep.report.games, 3, 'Karpov as White: both scout fixtures plus the own game against him, flipped');
  assert.equal(prep.headToHead.record.games, 1, 'the own game against Karpov');
  assert.equal(prep.clash, null, 'no FIDE book: no clash, no line cards');
  assert.deepEqual(prep.deck.lines, []);
  assert.ok(prep.deck.punish.length >= 2 && prep.deck.punish.every(d => d.kind === 'punish' && d.subjectColor === 'white'));
  assert.equal(prep.progress.total, prep.deck.punish.length);
  assert.equal(prep.progress.done, 0);

  const id = prep.deck.punish[0].id;
  const m1 = await (await json('POST', '/api/prep/mark', { id, correct: false })).json();
  assert.deepEqual([m1.mark.seen, m1.mark.right], [1, 0]);
  await json('POST', '/api/prep/mark', { id, correct: true });
  const again = (await (await json('GET', '/api/prep/' + encodeURIComponent('Karpov, A') + '?color=black')).json()).prep;
  assert.equal(again.progress.done, 1);
  assert.equal(again.progress.marks[id].right, 1);
  assert.equal((await json('POST', '/api/prep/mark', { id: 'evil', correct: true })).status, 400);

  // The other colour: Karpov never played Black in the fixtures, so the dossier is empty but the page still opens.
  const white = (await (await json('GET', '/api/prep/' + encodeURIComponent('Karpov, A') + '?color=white')).json()).prep;
  assert.equal(white.report.games, 0);
  assert.equal(white.deck.punish.length, 0);
  assert.equal((await json('GET', '/api/prep/Nobody?color=white')).status, 404);
});
