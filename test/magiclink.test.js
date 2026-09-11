// Magic-link sign-in. RESEND_API_KEY is left unset so requests use the console
// fallback (no network); the token/verify logic is what matters here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tempData } from './helpers.js';

process.env.DATA_DIR = tempData();
process.env.SESSION_SECRET = 'test-session-secret';
process.env.PUBLIC_URL = 'https://chess.example.com';
process.env.AUTH_EMAIL_KAI = 'kai@example.com';
delete process.env.APP_PASSWORD;
delete process.env.READONLY_DATA;
delete process.env.RESEND_API_KEY;

const M = await import('../server/magiclink.js');
const { app } = await import('../server/index.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); for (const k of ['SESSION_SECRET', 'PUBLIC_URL', 'AUTH_EMAIL_KAI']) delete process.env[k]; });

const postJson = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const rawGet = path => new Promise(resolve => {
  http.get(base + path, res => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location, setCookie: res.headers['set-cookie'] || [] }); });
});

test('magic token round-trips; rejects tamper, garbage, expiry', () => {
  const t = M.makeMagicToken('kai');
  assert.equal(M.verifyMagicToken(t).userId, 'kai');
  const p = t.split('.');
  assert.equal(M.verifyMagicToken(`${p[0]}.${p[1]}.${p[2]}z`), null);
  assert.equal(M.verifyMagicToken('garbage'), null);
  assert.equal(M.verifyMagicToken(M.makeMagicToken('kai', Date.now() - 1000)), null);
});

test('request returns the same response for allowlisted and unknown emails (no enumeration)', async () => {
  const ok = await postJson('/api/auth/magic/request', { email: 'kai@example.com' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  const unknown = await postJson('/api/auth/magic/request', { email: 'nobody@example.com' });
  assert.equal(unknown.status, 200);
  assert.deepEqual(await unknown.json(), { ok: true });
});

test('verify with a valid token sets a session and redirects', async () => {
  const r = await rawGet(`/api/auth/magic/verify?token=${encodeURIComponent(M.makeMagicToken('kai'))}`);
  assert.equal(r.status, 302);
  assert.equal(r.location, '/');
  assert.ok(r.setCookie.join(';').includes('sess='), 'sets the session cookie');
});

test('verify with a bad token is a 400, not a redirect', async () => {
  assert.equal((await rawGet('/api/auth/magic/verify?token=nope')).status, 400);
});

test('/api/auth/me reports magic disabled when RESEND_API_KEY is unset', async () => {
  const me = await (await fetch(base + '/api/auth/me')).json();
  assert.equal(me.providers.magic, false);
  assert.equal(M.magicConfigured(), false);
});
