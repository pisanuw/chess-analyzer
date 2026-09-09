import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempData, makeGame, writeGame } from './helpers.js';

process.env.DATA_DIR = tempData();
process.env.APP_PASSWORD = 'test-passphrase-42';
process.env.READONLY_DATA = '1';
writeGame(process.env.DATA_DIR, makeGame({ id: 'abcdefabcdef' }));

const { app } = await import('../server/index.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); delete process.env.APP_PASSWORD; delete process.env.READONLY_DATA; });

const req = (method, path, { body, headers = {} } = {}) => fetch(base + path, {
  method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
  body: body ? JSON.stringify(body) : undefined,
});

test('api is locked without credentials; static is not', async () => {
  assert.equal((await req('GET', '/api/games')).status, 401);
  assert.equal((await req('GET', '/')).status, 200);
});

test('login: wrong password rejected, right password sets a working cookie', async () => {
  assert.equal((await req('POST', '/api/login', { body: { password: 'nope' } })).status, 401);
  const ok = await req('POST', '/api/login', { body: { password: 'test-passphrase-42' } });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^auth=/);
  const games = await req('GET', '/api/games', { headers: { cookie } });
  assert.equal(games.status, 200);
  assert.equal((await games.json()).games.length, 1);
});

test('bearer auth works for scripts', async () => {
  const r = await req('GET', '/api/status', { headers: { authorization: 'Bearer test-passphrase-42' } });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.readonly, true);
});

test('login throttle binds per client and ignores forged X-Forwarded-For', async () => {
  // Rotating X-Forwarded-For used to hand out a fresh bucket per request; the
  // limiter now keys on the real peer (req.ip here), so all of these count as
  // one client and the window still binds. Runs after the successful-login test,
  // which clears this client's counter.
  for (let i = 0; i < 20; i++) {
    const r = await req('POST', '/api/login', { body: { password: 'nope' }, headers: { 'x-forwarded-for': `10.0.0.${i}` } });
    assert.equal(r.status, 401, `attempt ${i} is a normal wrong-password 401`);
  }
  const blocked = await req('POST', '/api/login', { body: { password: 'nope' }, headers: { 'x-forwarded-for': '10.9.9.9' } });
  assert.equal(blocked.status, 429, 'the 21st attempt is throttled despite a fresh X-Forwarded-For');
  // The throttle applies before the password check, so even the right password waits.
  const rightButThrottled = await req('POST', '/api/login', { body: { password: 'test-passphrase-42' } });
  assert.equal(rightButThrottled.status, 429);
});

test('read-only mode: game mutations blocked, training writes allowed', async () => {
  const auth = { authorization: 'Bearer test-passphrase-42' };
  const blocked = await req('POST', '/api/games/import', { body: { pgn: 'x' }, headers: auth });
  assert.equal(blocked.status, 405);
  assert.match((await blocked.json()).error, /read-only/);
  assert.equal((await req('DELETE', '/api/games/abcdefabcdef', { headers: auth })).status, 405);
  assert.equal((await req('POST', '/api/games/abcdefabcdef/names', { body: { white: 'a', black: 'b' }, headers: auth })).status, 405);
  // Training paths pass the read-only gate (guess seeds a drill; review then works).
  const guess = await req('POST', '/api/games/abcdefabcdef/moments/1/guess', { body: { uci: 'd2d4', correct: true }, headers: auth });
  assert.equal(guess.status, 200);
  const review = await req('POST', '/api/drills/abcdefabcdef%3A1/review', { body: { grade: 'again', correct: false }, headers: auth });
  assert.equal(review.status, 200);
  // Settings are forced safe on the mirror.
  const settings = await (await req('GET', '/api/settings', { headers: auth })).json();
  assert.equal(settings.settings.llmProvider, 'manual');
  assert.equal(settings.settings.autoExplain, false);
});
