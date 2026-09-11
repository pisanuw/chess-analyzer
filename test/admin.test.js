// Admin roster management (add/remove visitors and players) and the public
// request-access route.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempData } from './helpers.js';

process.env.DATA_DIR = tempData();
process.env.SESSION_SECRET = 'test-session-secret';
process.env.ADMIN_EMAIL = 'admin@example.com';
delete process.env.APP_PASSWORD;
delete process.env.READONLY_DATA;
delete process.env.RESEND_API_KEY; // console fallback for the request-access email

const users = await import('../server/users.js');
const { createSessionToken } = await import('../server/auth.js');
const { app } = await import('../server/index.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); for (const k of ['SESSION_SECRET', 'ADMIN_EMAIL']) delete process.env[k]; });

const admin = { cookie: `sess=${createSessionToken('yusuf')}`, 'content-type': 'application/json' };
const member = { cookie: `sess=${createSessionToken('kai')}`, 'content-type': 'application/json' };
const post = (path, headers, body) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });

test('roster helpers: add visitor, add member, list managed, remove', async () => {
  const v = await users.addVisitor('New.Visitor@Example.com');
  assert.equal(v.role, 'visitor');
  assert.equal((await users.findUserByEmail('new.visitor@example.com'))?.role, 'visitor');

  const m = await users.addMember({ email: 'player@example.com', displayName: 'Test Player', fideId: '12345678', playerNames: 'Player, Test; T Player' });
  assert.equal(m.role, 'member');
  assert.deepEqual(m.playerNames, ['Player, Test', 'T Player']);
  const found = await users.findUserByEmail('player@example.com');
  assert.equal(found.displayName, 'Test Player');
  assert.equal(found.fideId, '12345678');

  const managedIds = (await users.managedUsers()).map(u => u.id);
  assert.ok(managedIds.includes(v.id) && managedIds.includes(m.id));

  assert.equal(await users.removeRosterEntry(v.id), true);
  assert.equal(await users.findUserByEmail('new.visitor@example.com'), null);
  assert.equal(await users.removeRosterEntry('kai'), false, 'built-ins are not in the file');
});

test('bad email is rejected by the helpers', async () => {
  await assert.rejects(() => users.addVisitor('not-an-email'));
  await assert.rejects(() => users.addMember({ email: 'x@y.com', displayName: '' }));
});

test('GET /api/admin/users is admin only and includes emails + managed flag', async () => {
  assert.equal((await fetch(base + '/api/admin/users')).status, 401);
  assert.equal((await fetch(base + '/api/admin/users', { headers: member })).status, 403);
  const r = await fetch(base + '/api/admin/users', { headers: admin });
  assert.equal(r.status, 200);
  const { users: list } = await r.json();
  const kai = list.find(u => u.id === 'kai');
  assert.ok(kai && 'emails' in kai && kai.managed === false);
});

test('admin can add a visitor and a player through the routes', async () => {
  assert.equal((await post('/api/admin/visitors', admin, { email: 'route.visitor@example.com' })).status, 200);
  assert.equal((await users.findUserByEmail('route.visitor@example.com'))?.role, 'visitor');
  assert.equal((await post('/api/admin/players', admin, { email: 'route.player@example.com', displayName: 'Route Player', fideId: '999' })).status, 200);
  assert.equal((await users.findUserByEmail('route.player@example.com'))?.role, 'member');
  // a member cannot
  assert.equal((await post('/api/admin/visitors', member, { email: 'nope@example.com' })).status, 403);
  assert.equal((await post('/api/admin/visitors', admin, { email: 'bad' })).status, 400);
});

test('DELETE /api/admin/users/:id removes managed, 404 for built-ins', async () => {
  const v = await users.addVisitor('delete.me@example.com');
  assert.equal((await fetch(base + `/api/admin/users/${v.id}`, { method: 'DELETE', headers: admin })).status, 200);
  assert.equal((await fetch(base + '/api/admin/users/kai', { method: 'DELETE', headers: admin })).status, 404);
});

test('request-access is public and validates the email', async () => {
  const ok = await post('/api/auth/request-access', { 'content-type': 'application/json' }, { email: 'stranger@example.com', reason: 'I play at the club' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
  assert.equal((await post('/api/auth/request-access', { 'content-type': 'application/json' }, { email: 'bad', reason: 'x' })).status, 400);
});
