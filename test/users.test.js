// Roster + allowlist. Set DATA_DIR to a temp dir before importing (users.js
// imports store.js, which reads DATA_DIR at import) so getUsers() reads a
// controlled data/users.json rather than the real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'chess-users-test-'));
process.env.DATA_DIR = dir;
const U = await import('../server/users.js');

test('DEFAULT_USERS: three members and one admin with correct FIDE ids', () => {
  const byId = Object.fromEntries(U.DEFAULT_USERS.map(u => [u.id, u]));
  assert.equal(byId.kai.role, 'member');
  assert.equal(byId.kai.fideId, '39904881');
  assert.equal(byId.nikash.fideId, '30960967');
  assert.equal(byId.neeraj.fideId, '30958130');
  assert.equal(byId.yusuf.role, 'admin');
  assert.equal(U.DEFAULT_USERS.filter(u => u.role === 'member').length, 3);
});

test('parseEmails: splits, lowercases, dedupes', () => {
  assert.deepEqual(U.parseEmails('A@x.com, b@Y.com; a@x.com'), ['a@x.com', 'b@y.com']);
  assert.deepEqual(U.parseEmails(''), []);
  assert.deepEqual(U.parseEmails(null), []);
});

test('envEmails: reads AUTH_EMAIL_<ID> keys', () => {
  const env = { AUTH_EMAIL_KAI: 'kai@example.com', AUTH_EMAIL_NIKASH: 'nik@a.com, nik2@b.com', OTHER: 'x' };
  assert.deepEqual(U.envEmails(env), { kai: ['kai@example.com'], nikash: ['nik@a.com', 'nik2@b.com'] });
});

test('buildRoster: merges file users and env emails by id, unions emails', () => {
  const roster = U.buildRoster(
    U.DEFAULT_USERS,
    [{ id: 'kai', emails: ['Kai@Example.com'], rating: 2100 }, { id: 'guest', displayName: 'Guest', emails: ['g@x.com'] }],
    { kai: ['kai2@example.com'], neeraj: ['neeraj@example.com'] },
  );
  const byId = Object.fromEntries(roster.map(u => [u.id, u]));
  assert.deepEqual(byId.kai.emails, ['kai@example.com', 'kai2@example.com']); // file + env, lowercased, unioned
  assert.equal(byId.kai.rating, 2100);                    // file overrides default
  assert.equal(byId.kai.fideId, '39904881');              // default preserved
  assert.deepEqual(byId.neeraj.emails, ['neeraj@example.com']);
  assert.equal(byId.guest.role, 'member');                // new member defaults to member
  assert.deepEqual(byId.guest.emails, ['g@x.com']);
});

test('resolveUserByEmail: case-insensitive, null when not allowlisted', () => {
  const roster = U.buildRoster(U.DEFAULT_USERS, [{ id: 'kai', emails: ['kai@example.com'] }], {});
  assert.equal(U.resolveUserByEmail(roster, 'KAI@example.com').id, 'kai');
  assert.equal(U.resolveUserByEmail(roster, 'nobody@example.com'), null);
  assert.equal(U.resolveUserByEmail(roster, ''), null);
});

test('publicUser: strips emails', () => {
  const pub = U.publicUser({ id: 'kai', displayName: 'Kai', role: 'member', fideId: '1', rating: 2000, emails: ['x@y.com'] });
  assert.deepEqual(pub, { id: 'kai', displayName: 'Kai', role: 'member', fideId: '1', rating: 2000 });
  assert.equal(pub.emails, undefined);
});

test('isAdmin', () => {
  assert.equal(U.isAdmin({ role: 'admin' }), true);
  assert.equal(U.isAdmin({ role: 'member' }), false);
  assert.equal(U.isAdmin(null), false);
});

test('ADMIN_EMAIL doubles as an admin login address, and wins over the visitor list', async () => {
  process.env.ADMIN_EMAIL = 'Admin@Example.com';
  process.env.AUTH_VISITOR_EMAILS = 'admin@example.com, other@example.com';
  try {
    const admin = await U.findUserByEmail('admin@example.com');
    assert.equal(admin.id, 'yusuf');
    assert.equal(U.isAdmin(admin), true); // not demoted to the visitor entry
    assert.equal((await U.findUserByEmail('other@example.com')).role, 'visitor');
  } finally {
    delete process.env.ADMIN_EMAIL;
    delete process.env.AUTH_VISITOR_EMAILS;
  }
});

test('getUsers + findUserByEmail: reads data/users.json and env together', async () => {
  writeFileSync(path.join(dir, 'users.json'), JSON.stringify({
    users: [{ id: 'nikash', emails: ['nikash@example.com'] }],
  }));
  process.env.AUTH_EMAIL_YUSUF = 'pisan@uw.edu';
  try {
    const found = await U.findUserByEmail('NIKASH@example.com');
    assert.equal(found.id, 'nikash');
    assert.equal(found.fideId, '30960967'); // default merged with file
    const admin = await U.findUserByEmail('pisan@uw.edu');
    assert.equal(admin.id, 'yusuf');
    assert.equal(U.isAdmin(admin), true);
    assert.equal(await U.findUserByEmail('stranger@example.com'), null);
  } finally {
    delete process.env.AUTH_EMAIL_YUSUF;
  }
});
