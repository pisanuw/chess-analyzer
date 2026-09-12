// The admin activity log: the store round-trips (newest first) and the
// /api/audit endpoint is admin-only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempData } from './helpers.js';

process.env.DATA_DIR = tempData();
process.env.SESSION_SECRET = 'test-session-secret';
process.env.AUTH_EMAIL_KAI = 'kai@example.com';
delete process.env.APP_PASSWORD;
delete process.env.READONLY_DATA;

const audit = await import('../server/audit.js');
const { createSessionToken } = await import('../server/auth.js');
const { app } = await import('../server/index.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); for (const k of ['SESSION_SECRET', 'AUTH_EMAIL_KAI']) delete process.env[k]; });

test('logEvent then readAudit round-trips, newest first, with a timestamp', async () => {
  await audit.logEvent({ action: 'login', userId: 'kai', ip: '1.2.3.4' });
  await audit.logEvent({ action: 'DELETE /api/games/x', userId: 'yusuf', role: 'admin' });
  const events = await audit.readAudit(10);
  assert.equal(events[0].action, 'DELETE /api/games/x'); // newest first
  assert.equal(events[1].action, 'login');
  assert.ok(events[0].at, 'stamps an ISO timestamp');
});

test('concurrent appends are serialised so none is lost', async () => {
  const before = (await audit.readAudit(500)).length;
  await Promise.all([...Array(12).keys()].map(i => audit.logEvent({ action: `burst ${i}` })));
  const events = await audit.readAudit(500);
  assert.equal(events.length, before + 12, 'every event of the burst survived');
});

test('/api/audit is admin only', async () => {
  assert.equal((await fetch(base + '/api/audit')).status, 401, 'no session is rejected by the auth gate');
  const kai = createSessionToken('kai');
  assert.equal((await fetch(base + '/api/audit', { headers: { cookie: `sess=${kai}` } })).status, 403, 'a member is rejected');
  const yusuf = createSessionToken('yusuf');
  const r = await fetch(base + '/api/audit', { headers: { cookie: `sess=${yusuf}` } });
  assert.equal(r.status, 200, 'the admin is allowed');
  assert.ok(Array.isArray((await r.json()).events));
});
