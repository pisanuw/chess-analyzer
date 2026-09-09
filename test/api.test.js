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

test('import rejects a paste with too many games before parsing', async () => {
  const one = `[White "A"]\n[Black "B"]\n[Result "*"]\n\n1. e4 e5 *\n\n`;
  const r = await req('POST', '/api/games/import', { pgn: one.repeat(501), analyse: false });
  assert.equal(r.status, 413);
  assert.match(r.data.error, /too many games/);
});

test('guess endpoint seeds a drill and boosts first-try success', async () => {
  writeGame(process.env.DATA_DIR, makeGame({ id: 'abcdefabcdef', moments: [{ ply: 1, loss: 25 }] }));
  const r = await req('POST', '/api/games/abcdefabcdef/moments/1/guess', { uci: 'd2d4', correct: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.seeded, true);
  assert.equal(r.data.step, 1); // first-try guess seeds one rung up
  const notMoment = await req('POST', '/api/games/abcdefabcdef/moments/2/guess', { uci: 'd2d4', correct: true });
  assert.equal(notMoment.status, 404);
});

test('manual explanation fields are length-clamped', async () => {
  const big = 'x'.repeat(5000);
  const r = await req('PUT', '/api/games/abcdefabcdef/moments/1/explanation',
    { pattern: big, category: 'calculation', time_pressure: true, explanation: big, key_question: big, concept: big });
  assert.equal(r.status, 200);
  const g = (await req('GET', '/api/games/abcdefabcdef')).data.game;
  assert.equal(g.explanations['1'].explanation.length, 2000);
  assert.equal(g.explanations['1'].pattern.length, 120);
  assert.equal(g.explanations['1'].key_question.length, 500);
});

test('settings caps array sizes and element lengths', async () => {
  const r = await req('PUT', '/api/settings', { remoteHosts: Array(200).fill('h'.repeat(400)) });
  assert.equal(r.status, 200);
  assert.ok(r.data.settings.remoteHosts.length <= 50);
  assert.ok(r.data.settings.remoteHosts.every(h => h.length <= 255));
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

test('player names can be edited; empty names rejected', async () => {
  const games = (await req('GET', '/api/games')).data.games;
  const id = games.find(g => g.white === 'Kai Pisan').id;
  const r = await req('POST', `/api/games/${id}/names`, { white: 'Pisan, Kai', black: 'Bilych, Oleksii' });
  assert.equal(r.status, 200);
  assert.equal(r.data.game.headers.White, 'Pisan, Kai');
  const after = (await req('GET', '/api/games')).data.games.find(g => g.id === id);
  assert.equal(after.black, 'Bilych, Oleksii');
  assert.equal((await req('POST', `/api/games/${id}/names`, { white: '', black: 'x' })).status, 400);
  assert.equal((await req('POST', '/api/games/aaaaaaaaaa99/names', { white: 'a', black: 'b' })).status, 404);
});

test('report and repertoire endpoints respond', async () => {
  const rep = await req('GET', '/api/report');
  assert.equal(rep.status, 200);
  assert.equal(typeof rep.data.report.games, 'number');
  const rp = await req('GET', '/api/repertoire');
  assert.equal(rp.status, 200);
  assert.ok(Array.isArray(rp.data.repertoire));
});

test('feedback endpoint stores votes; unexplained moments are rejected', async () => {
  const ok = await req('POST', '/api/games/abcdefabcdef/moments/1/feedback', { helpful: false });
  assert.equal(ok.status, 200);
  const g = await req('GET', '/api/games/abcdefabcdef');
  assert.equal(g.data.feedback['1'].helpful, false);
  const noExplanation = await req('POST', '/api/games/abcdefabcdef/moments/2/feedback', { helpful: true });
  assert.equal(noExplanation.status, 404);
});

test('drills endpoint filters by pattern for lightning rounds', async () => {
  const round = await req('GET', '/api/drills?pattern=Test%20pattern');
  assert.equal(round.status, 200);
  assert.ok(round.data.due.some(d => d.gameId === 'abcdefabcdef'));
  assert.equal(round.data.pattern, 'Test pattern');
});

test('prep card endpoint returns markdown', async () => {
  const res = await fetch(base + '/api/report/card');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /markdown/);
  assert.match(await res.text(), /Pre-tournament card/);
});

test('changing the moment threshold re-scores stored games without re-analysis', async () => {
  writeGame(process.env.DATA_DIR, makeGame({ id: 'abcabcabcab1', moments: [{ ply: 1, loss: 25 }, { ply: 3, loss: 14 }], plies: 4 }));
  const raised = await req('PUT', '/api/settings', { momentThreshold: 20 });
  assert.equal(raised.status, 200);
  assert.ok(raised.data.recomputed >= 1, 'at least the new game is re-scored');
  const g = (await req('GET', '/api/games/abcabcabcab1')).data.game;
  assert.deepEqual(g.analysis.summary.moments, [1], 'the 14-point moment drops out at threshold 20');
  assert.equal(g.status, 'explained', 'explanations still cover every remaining moment');
  await req('PUT', '/api/settings', { momentThreshold: 12 });
  const g2 = (await req('GET', '/api/games/abcabcabcab1')).data.game;
  assert.deepEqual(g2.analysis.summary.moments, [1, 3], 'lowering the threshold brings the moment back');
  const { data } = await req('GET', '/api/drills');
  assert.ok(data.total >= 2, 'drills resync after the threshold change');
});

test('playout endpoints validate input without touching the engine', async () => {
  assert.equal((await req('POST', '/api/playout/move', { fen: 'garbage' })).status, 400);
  // A finished game needs no engine either: the verdict is derived directly.
  const mate = await req('POST', '/api/playout/assess', { fen: '7k/6Q1/6K1/8/8/8/8/8 b - - 0 1' });
  assert.equal(mate.status, 200);
  assert.equal(mate.data.over, 'checkmate');
  assert.ok(mate.data.cp > 9000, 'mated side to move means a winning score for the other side');
});

test('reexplain guards: not a moment, no prior explanation, manual provider', async () => {
  assert.equal((await req('POST', '/api/games/abcdefabcdef/moments/2/reexplain')).status, 404, 'ply 2 is not a moment');
  await req('PUT', '/api/settings', { llmProvider: 'manual' });
  const manual = await req('POST', '/api/games/abcdefabcdef/moments/1/reexplain');
  assert.equal(manual.status, 400);
  assert.match(manual.data.error, /manual/);
  await req('PUT', '/api/settings', { llmProvider: 'claude-cli' });
  writeGame(process.env.DATA_DIR, makeGame({ id: 'abc999abc999', moments: [{ ply: 1, loss: 25 }], explained: false }));
  const noPrior = await req('POST', '/api/games/abc999abc999/moments/1/reexplain');
  assert.equal(noPrior.status, 400, 'nothing to redo without a prior explanation');
  assert.match(noPrior.data.error, /no explanation/);
});

test('review think time, undo, suspend, and restore over HTTP', async () => {
  const passed = await req('POST', '/api/drills/abcdefabcdef%3A1/review', { grade: 'good', correct: true, ms: 1500 });
  assert.equal(passed.data.drill.reviews.at(-1).ms, 1500);
  const undo = await req('POST', '/api/drills/abcdefabcdef%3A1/undo');
  assert.equal(undo.status, 200);
  assert.equal(undo.data.drill.step, 0, 'ladder restored');
  const sus = await req('POST', '/api/drills/abcdefabcdef%3A1/suspend', {});
  assert.equal(sus.data.drill.suspended, true);
  const drills = (await req('GET', '/api/drills')).data;
  assert.ok(!drills.due.some(d => d.id === 'abcdefabcdef:1'), 'suspended drill leaves the queue');
  assert.ok(drills.suspendedCount >= 1);
  const restored = await req('POST', '/api/drills/restore-suspended');
  assert.ok(restored.data.restored >= 1);
});
