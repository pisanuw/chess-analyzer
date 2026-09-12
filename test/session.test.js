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

const postJson = (path, headers, body) => fetch(base + path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('an import can be filed under a member, whose own PGN names decide the colour', async () => {
  const PGN = '[White "Vemparala, Nikash"]\n[Black "Someone"]\n[Date "2026.05.05"]\n[Result "1-0"]\n\n1. e4 e5 1-0';
  const r = await postJson('/api/games/import', sessCookie('yusuf'), { pgn: PGN, analyse: false, owner: 'nikash' });
  assert.equal(r.status, 200);
  const { imported } = await r.json();
  assert.equal(imported.length, 1);
  const nik = (await (await req('GET', '/api/games', { headers: sessCookie('nikash') })).json()).games.find(x => x.id === imported[0]);
  assert.ok(nik, 'nikash sees the imported game');
  assert.equal(nik.owner, 'nikash');
  assert.equal(nik.playerColor, 'white', "detected from nikash's roster names, not the operator's settings");
  assert.ok(!(await gameIds(sessCookie('kai'))).includes(imported[0]), 'kai does not see it');
  assert.equal((await postJson('/api/games/import', sessCookie('yusuf'), { pgn: PGN, analyse: false, owner: 'nobody' })).status, 400);
});

test('/api/members lists members with PGN names and without emails', async () => {
  const { members } = await (await req('GET', '/api/members', { headers: sessCookie('kai') })).json();
  const nik = members.find(m => m.id === 'nikash');
  assert.ok(nik && Array.isArray(nik.playerNames) && nik.playerNames.length);
  assert.equal(nik.emails, undefined);
  assert.ok(!members.some(m => m.role !== 'member'));
});

test("a colour or name fix on a member's game syncs that member's drills, and a threshold change re-syncs every member", async () => {
  const { getDrills } = await import('../server/store.js');
  const admin = sessCookie('yusuf');
  // nikash's fixture game has a moment at ply 1 (White). Re-affirming White
  // keeps the moment and must write the drill into nikash's store, not kai's.
  assert.equal((await postJson('/api/games/ababababab01/player', admin, { color: 'white', analyse: false })).status, 200);
  const nik = (await getDrills('nikash')).drills.map(d => d.id);
  assert.ok(nik.includes('ababababab01:1'), "the drill lands in the owner's store");
  assert.ok(!(await getDrills('kai')).drills.some(d => d.gameId === 'ababababab01'), 'and not in the default member\'s');
  assert.equal((await postJson('/api/games/ababababab01/names', admin, { white: 'Vemparala, Nikash', black: 'Opp' })).status, 200);
  assert.ok((await getDrills('nikash')).drills.some(d => d.id === 'ababababab01:1' && d.label.startsWith('Vemparala, Nikash')), 'the name fix refreshes the owner\'s drill label');
  assert.ok(!(await getDrills('kai')).drills.some(d => d.gameId === 'ababababab01'));
  // The fixture moment lost 25 points: core at the default threshold of 20,
  // a sharpener at 30. Raising the threshold must re-tier nikash's drill too.
  assert.equal((await getDrills('nikash')).drills.find(d => d.id === 'ababababab01:1').tier, 'core');
  const r = await fetch(base + '/api/settings', { method: 'PUT', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ drillThreshold: 30 }) });
  assert.equal(r.status, 200);
  assert.equal((await getDrills('nikash')).drills.find(d => d.id === 'ababababab01:1').tier, 'sharpen');
  await fetch(base + '/api/settings', { method: 'PUT', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ drillThreshold: 20 }) });
});

test('management routes are admin only', async () => {
  assert.equal((await req('POST', '/api/games/import', { headers: sessCookie('kai') })).status, 403);
  assert.equal((await req('PUT', '/api/settings', { headers: sessCookie('kai') })).status, 403);
  assert.equal((await req('DELETE', '/api/games/abcdefabcdef', { headers: sessCookie('kai') })).status, 403);
  // admin passes the guard: import with no body is a 400 (missing PGN), not a 403
  assert.equal((await req('POST', '/api/games/import', { headers: sessCookie('yusuf') })).status, 400);
});
