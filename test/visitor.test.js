// Visitor role: allowlisted guests can see the shared scouting library and
// practice drills/puzzles, but get no report/repertoire and record nothing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tempData, makeGame, writeGame } from './helpers.js';

process.env.DATA_DIR = tempData();
process.env.SESSION_SECRET = 'test-secret';
process.env.AUTH_EMAIL_KAI = 'kai@example.com';
process.env.AUTH_VISITOR_EMAILS = 'guest@example.com, friend@example.com';
delete process.env.APP_PASSWORD;
delete process.env.READONLY_DATA;

const dir = process.env.DATA_DIR;
writeGame(dir, makeGame({ id: 'aaaaaaaaaaa1', moments: [{ ply: 1, loss: 25 }] }));                                   // kai's own game
writeGame(dir, makeGame({ id: 'cccccccccc01', purpose: 'scout', subject: 'Foe, X', moments: [{ ply: 1, loss: 30 }], plies: 2 })); // shared scout game

const { findUserByEmail, isVisitor } = await import('../server/users.js');
const { createSessionToken } = await import('../server/auth.js');
const { app } = await import('../server/index.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); for (const k of ['SESSION_SECRET', 'AUTH_EMAIL_KAI', 'AUTH_VISITOR_EMAILS']) delete process.env[k]; });

const visitor = await findUserByEmail('guest@example.com');
const kai = await findUserByEmail('kai@example.com');
const vCookie = { cookie: `sess=${createSessionToken(visitor.id)}` };
const kCookie = { cookie: `sess=${createSessionToken(kai.id)}` };
const req = (method, path, headers = {}) => fetch(base + path, { method, headers });

test('visitor emails resolve to the visitor role; a member email does not', () => {
  assert.equal(isVisitor(visitor), true);
  assert.equal(kai.role, 'member');
});

test('visitors are blocked from report, repertoire, and patterns', async () => {
  assert.equal((await req('GET', '/api/report', vCookie)).status, 403);
  assert.equal((await req('GET', '/api/repertoire', vCookie)).status, 403);
  assert.equal((await req('GET', '/api/patterns', vCookie)).status, 403);
  assert.equal((await req('GET', '/api/report/card', vCookie)).status, 403);
});

test('members are not blocked from their report', async () => {
  assert.equal((await req('GET', '/api/report', kCookie)).status, 200);
});

test('visitors can see the shared scouting library', async () => {
  assert.equal((await req('GET', '/api/scout', vCookie)).status, 200);
});

test('visitors get ephemeral scout drills and record nothing', async () => {
  const drills = await (await req('GET', '/api/drills', vCookie)).json();
  assert.equal(drills.visitor, true);
  assert.ok(drills.due.length >= 1, 'visitor sees punish drills from the scout library');
  assert.equal(drills.due[0].kind, 'punish');

  // A review is a no-op: 200, ephemeral, and no per-visitor drill store is created.
  const r = await req('POST', `/api/drills/${encodeURIComponent(drills.due[0].id)}/review`, { ...vCookie, 'content-type': 'application/json' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ephemeral, true);
  assert.equal(existsSync(path.join(dir, 'users', visitor.id)), false, 'no visitor data is written');
});

test('visitor puzzles come from the shared library', async () => {
  const pz = await (await req('GET', '/api/puzzles?source=tactics', vCookie)).json();
  assert.equal(pz.source, 'tactics');
  assert.ok(Array.isArray(pz.puzzles));
});
