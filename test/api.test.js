import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempData, makeGame, writeGame } from './helpers.js';

process.env.DATA_DIR = tempData();
const { app } = await import('../server/index.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

const PGN = `[White "Kai Pisan"]
[Black "Someone Else"]
[Date "2026.03.01"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 1-0`;

test('settings: clamp out-of-range, reject non-numbers', async () => {
  const ok = await req('PUT', '/api/settings', { momentThreshold: 0, playerNames: 'Kai Pisan' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.settings.momentThreshold, 1);
  const bad = await req('PUT', '/api/settings', { engineDepth: '' });
  assert.equal(bad.status, 400);
});

test('import: parses, auto-detects colour, dedupes', async () => {
  const r1 = await req('POST', '/api/games/import', { pgn: PGN, analyse: false });
  assert.equal(r1.status, 200);
  assert.equal(r1.data.imported.length, 1);
  const games = (await req('GET', '/api/games')).data.games;
  const g = games.find(x => x.id === r1.data.imported[0]);
  assert.equal(g.playerColor, 'white');
  assert.equal(g.status, 'imported');
  const r2 = await req('POST', '/api/games/import', { pgn: PGN, analyse: false });
  assert.equal(r2.data.imported.length, 0);
  assert.equal(r2.data.skipped.length, 1);
});

test('guess endpoint seeds a drill and boosts first-try success', async () => {
  writeGame(process.env.DATA_DIR, makeGame({ id: 'abcdefabcdef', moments: [{ ply: 1, loss: 25 }] }));
  const r = await req('POST', '/api/games/abcdefabcdef/moments/1/guess', { uci: 'd2d4', correct: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.seeded, true);
  assert.equal(r.data.step, 2);
  const notMoment = await req('POST', '/api/games/abcdefabcdef/moments/2/guess', { uci: 'd2d4', correct: true });
  assert.equal(notMoment.status, 404);
});

test('drill review flow over HTTP', async () => {
  const { data } = await req('GET', '/api/drills');
  assert.equal(data.due.length, 0, 'boosted drill is not due yet');
  assert.equal(data.total, 1);
  const bad = await req('POST', '/api/drills/abcdefabcdef%3A1/review', { grade: 'again', correct: false });
  assert.equal(bad.status, 200);
  assert.equal(bad.data.drill.step, 0);
  const due = (await req('GET', '/api/drills')).data;
  assert.equal(due.due.length, 1, 'failed drill is due again immediately');
});

test('report and repertoire endpoints respond', async () => {
  const rep = await req('GET', '/api/report');
  assert.equal(rep.status, 200);
  assert.equal(typeof rep.data.report.games, 'number');
  const rp = await req('GET', '/api/repertoire');
  assert.equal(rp.status, 200);
  assert.ok(Array.isArray(rp.data.repertoire));
});
