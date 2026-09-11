// Hand-rolled Google OAuth. Exercises the pure pieces (auth URL, CSRF state,
// id_token decode, allowlist -> session) plus the wired routes, without calling
// Google (the token exchange itself is a thin fetch wrapper, not unit-tested).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tempData } from './helpers.js';

process.env.DATA_DIR = tempData();
process.env.SESSION_SECRET = 'test-session-secret';
process.env.GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'secret-xyz';
process.env.PUBLIC_URL = 'https://chess.example.com';
process.env.AUTH_EMAIL_KAI = 'kai@example.com';
delete process.env.APP_PASSWORD;
delete process.env.READONLY_DATA;

const G = await import('../server/googleauth.js');
const { getProfile } = await import('../server/profiles.js');
const { verifySessionToken } = await import('../server/auth.js');
const { app } = await import('../server/index.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); for (const k of ['SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'PUBLIC_URL', 'AUTH_EMAIL_KAI']) delete process.env[k]; });

const b64url = s => Buffer.from(s).toString('base64url');
const idToken = claims => `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.sig`;
// node:http (not fetch) so redirects are NOT followed and headers stay readable.
const rawGet = path => new Promise(resolve => {
  http.get(base + path, res => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location, setCookie: res.headers['set-cookie'] || [] }); });
});

test('googleConfigured reflects env', () => {
  assert.equal(G.googleConfigured(), true);
});

test('googleAuthUrl carries client_id, redirect, scope, state', () => {
  const url = new URL(G.googleAuthUrl('STATE123'));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), process.env.GOOGLE_CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://chess.example.com/api/auth/google/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.match(url.searchParams.get('scope'), /openid/);
  assert.equal(url.searchParams.get('state'), 'STATE123');
});

test('CSRF state round-trips; rejects cookie mismatch, tampering, garbage', () => {
  const s = G.makeState();
  assert.equal(G.checkState(s, s), true);
  assert.equal(G.checkState(s, 'other-cookie'), false);
  const p = s.split('.');
  const tampered = `${p[0]}.${p[1]}.${p[2]}z`;
  assert.equal(G.checkState(tampered, tampered), false);
  assert.equal(G.checkState('a.b.c', 'a.b.c'), false);
});

test('decodeIdToken parses the payload; null on garbage', () => {
  assert.equal(G.decodeIdToken(idToken({ email: 'x@y.com' })).email, 'x@y.com');
  assert.equal(G.decodeIdToken('nope'), null);
});

test('googleLoginToken: allowlisted + verified -> session; otherwise null', async () => {
  const aud = process.env.GOOGLE_CLIENT_ID;
  const tok = await G.googleLoginToken(idToken({ email: 'kai@example.com', email_verified: true, aud }));
  assert.ok(tok, 'allowlisted verified email issues a session');
  assert.equal(verifySessionToken(tok).userId, 'kai');
  assert.equal(await G.googleLoginToken(idToken({ email: 'stranger@example.com', email_verified: true, aud })), null);
  assert.equal(await G.googleLoginToken(idToken({ email: 'kai@example.com', email_verified: false, aud })), null);
  assert.equal(await G.googleLoginToken(idToken({ email: 'kai@example.com', email_verified: true, aud: 'wrong' })), null);
});

test('GET /api/auth/google redirects to Google and sets a state cookie', async () => {
  const r = await rawGet('/api/auth/google');
  assert.equal(r.status, 302);
  assert.match(r.location, /accounts\.google\.com/);
  assert.ok(r.setCookie.join(';').includes('g_state='), 'sets the g_state cookie');
});

test('callback with a bad state is rejected', async () => {
  assert.equal((await rawGet('/api/auth/google/callback?state=bad&code=x')).status, 400);
});

test('/api/auth/me advertises the google provider', async () => {
  const me = await (await fetch(base + '/api/auth/me')).json();
  assert.equal(me.providers.google, true);
});

test('google login captures the display name and picture for the top bar', async () => {
  const aud = process.env.GOOGLE_CLIENT_ID;
  const tok = await G.googleLoginToken(idToken({ email: 'kai@example.com', email_verified: true, aud, name: 'Kai Pisan', picture: 'https://pic.example/p.png' }));
  assert.ok(tok);
  const prof = await getProfile('kai');
  assert.equal(prof.name, 'Kai Pisan');
  assert.equal(prof.picture, 'https://pic.example/p.png');
  const me = await (await fetch(base + '/api/auth/me', { headers: { cookie: `sess=${tok}` } })).json();
  assert.equal(me.user.name, 'Kai Pisan');
  assert.equal(me.user.picture, 'https://pic.example/p.png');
});
