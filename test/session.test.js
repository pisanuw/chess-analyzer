// Per-user sessions and identity. Uses SESSION_SECRET (not APP_PASSWORD) so the
// new session path is exercised on its own. Set env before importing modules.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempData, makeGame, writeGame } from './helpers.js';

process.env.DATA_DIR = tempData();
process.env.SESSION_SECRET = 'test-session-secret';
delete process.env.APP_PASSWORD;
delete process.env.READONLY_DATA;
writeGame(process.env.DATA_DIR, makeGame({ id: 'abcdefabcdef' }));                    // kai's (legacy owner -> kai)
writeGame(process.env.DATA_DIR, makeGame({ id: 'ababababab01', owner: 'nikash' }));    // nikash's own game

const { createSessionToken, verifySessionToken, authActive } = await import('../server/auth.js');
const { app } = await import('../server/index.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); delete process.env.SESSION_SECRET; });

const req = (method, path, { headers = {} } = {}) => fetch(base + path, { method, headers });
const sessCookie = id => ({ cookie: `sess=${createSessionToken(id)}` });

test('session token round-trips and rejects tampering/expiry', () => {
  const t = createSessionToken('kai');
  assert.equal(verifySessionToken(t).userId, 'kai');
  assert.equal(verifySessionToken(t.slice(0, -1) + (t.at(-1) === 'a' ? 'b' : 'a')), null); // flipped last char of the mac
  assert.equal(verifySessionToken('garbage'), null);
  assert.equal(verifySessionToken(createSessionToken('kai', Date.now() - 1000)), null);    // already expired
});

test('authActive is on when SESSION_SECRET is set', () => {
  assert.equal(authActive(), true);
});

test('api is gated without a session, open with one', async () => {
  assert.equal((await req('GET', '/api/games')).status, 401);
  assert.equal((await req('GET', '/')).status, 200);            // static passes
  assert.equal((await req('GET', '/api.js')).status, 200);      // frontend module passes
  assert.equal((await req('GET', '/api/games', { headers: sessCookie('kai') })).status, 200);
  assert.equal((await req('GET', '/api/games', { headers: { cookie: 'sess=bogus.123.abc' } })).status, 401);
});

test('/api/auth/me reports identity, reachable unauthenticated', async () => {
  const anon = await (await req('GET', '/api/auth/me')).json();
  assert.equal(anon.user, null);
  assert.equal(anon.authActive, true);

  const kai = await (await req('GET', '/api/auth/me', { headers: sessCookie('kai') })).json();
  assert.equal(kai.user.id, 'kai');
  assert.equal(kai.user.role, 'member');
  assert.equal(kai.user.email, undefined); // publicUser strips emails

  const admin = await (await req('GET', '/api/auth/me', { headers: sessCookie('yusuf') })).json();
  assert.equal(admin.user.role, 'admin');
});

test('logout clears the session cookie', async () => {
  const r = await req('POST', '/api/auth/logout', { headers: sessCookie('kai') });
  assert.equal(r.status, 200);
  const setCookie = r.headers.get('set-cookie');
  assert.match(setCookie, /sess=;/);
  assert.match(setCookie, /Max-Age=0/);
});

const gameIds = async headers => (await (await req('GET', '/api/games', { headers })).json()).games.map(g => g.id);

test('members see only their own games; an admin can target a member with ?user=', async () => {
  const kai = await gameIds(sessCookie('kai'));
  assert.ok(kai.includes('abcdefabcdef') && !kai.includes('ababababab01'), 'kai sees own, not nikash');
  const nik = await gameIds(sessCookie('nikash'));
  assert.ok(nik.includes('ababababab01') && !nik.includes('abcdefabcdef'), 'nikash sees own, not kai');
  const adminDefault = await gameIds(sessCookie('yusuf'));
  assert.ok(adminDefault.includes('abcdefabcdef') && !adminDefault.includes('ababababab01'), 'admin defaults to the primary member');
  const adminNik = (await (await req('GET', '/api/games?user=nikash', { headers: sessCookie('yusuf') })).json()).games.map(g => g.id);
  assert.ok(adminNik.includes('ababababab01'), 'admin can view another member via ?user=');
});

test('a member cannot view another member\'s game', async () => {
  assert.equal((await req('GET', '/api/games/ababababab01', { headers: sessCookie('kai') })).status, 404);
  assert.equal((await req('GET', '/api/games/ababababab01', { headers: sessCookie('nikash') })).status, 200);
});

test('a signed session for a user no longer on the roster is rejected, not served the default member', async () => {
  const ghost = sessCookie('ghost_user_not_on_roster');
  for (const path of ['/api/games', '/api/report', '/api/drills', '/api/scout', '/api/jobs']) {
    const r = await req('GET', path, { headers: ghost });
    assert.equal(r.status, 401, `${path} must reject the ghost session`);
  }
  const r = await req('GET', '/api/games', { headers: ghost });
  assert.match(r.headers.get('set-cookie') || '', /sess=;/, 'the dead cookie is cleared');
  // The identity endpoint stays reachable and reports nobody signed in.
  const me = await (await req('GET', '/api/auth/me', { headers: ghost })).json();
  assert.equal(me.user, null);
  // Training writes are rejected too (they used to record against the default member).
  assert.equal((await req('POST', '/api/games/abcdefabcdef/moments/1/guess', { headers: ghost })).status, 401);
});

test('management routes are admin only', async () => {
  assert.equal((await req('POST', '/api/games/import', { headers: sessCookie('kai') })).status, 403);
  assert.equal((await req('PUT', '/api/settings', { headers: sessCookie('kai') })).status, 403);
  assert.equal((await req('DELETE', '/api/games/abcdefabcdef', { headers: sessCookie('kai') })).status, 403);
  // admin passes the guard: import with no body is a 400 (missing PGN), not a 403
  assert.equal((await req('POST', '/api/games/import', { headers: sessCookie('yusuf') })).status, 400);
});
