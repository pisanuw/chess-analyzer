// The member roster and login allowlist. This is what turns the app from
// single-user (Kai) into a small allowlisted set of members plus an admin.
//
// Identity + FIDE mapping live in code (DEFAULT_USERS) so the roster ships with
// the app and tests are deterministic. Email addresses are personal and vary per
// deployment, so they come from data/users.json or the environment (AUTH_EMAIL_<ID>),
// never hard-coded here. Auth secrets never live here at all (see .env).
//
// This module is pure data + lookups: it does not touch sessions, routes, or the
// per-user data layout. Those wire it in later phases.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, writeJson } from './store.js';

// role 'admin' can import games, run analysis, manage users, and edit the global
// engine/LLM settings. role 'member' sees only their own games/report/repertoire/
// drills/puzzles plus the shared scouting library. Kai is a plain member now.
//
// playerNames are substrings matched case-insensitively against PGN White/Black
// headers to detect which side a member played, the same mechanism the app used
// for the single "player" before. fideId ties a member to their scout book so we
// can seed their own games from it.
export const DEFAULT_USERS = [
  { id: 'kai',    displayName: 'Kai Pisan',        role: 'member', fideId: '39904881', playerNames: ['Kai Pisan', 'Pisan, Kai', 'Pisan'], rating: 2000 },
  { id: 'nikash', displayName: 'Vemparala Nikash', role: 'member', fideId: '30960967', playerNames: ['Vemparala, Nikash', 'Vemparala Nikash'], rating: null },
  { id: 'neeraj', displayName: 'Harish Neeraj',    role: 'member', fideId: '30958130', playerNames: ['Harish, Neeraj', 'Harish Neeraj'], rating: null },
  { id: 'yusuf',  displayName: 'Yusuf Pisan',      role: 'admin',  fideId: null,       playerNames: [], rating: null },
];

const lc = s => String(s || '').trim().toLowerCase();
const uniq = arr => [...new Set(arr)];

/** Split a comma/space/semicolon-separated list into lowercased email addresses. */
export function parseEmails(value) {
  return uniq(String(value || '').split(/[\s,;]+/).map(lc).filter(Boolean));
}

/** Split a semicolon/newline list of player-name substrings, case preserved.
 * Not comma-separated: PGN names are "Last, First", so commas stay in the name. */
export function parseNames(value) {
  if (Array.isArray(value)) return uniq(value.map(s => String(s).trim()).filter(Boolean));
  return uniq(String(value || '').split(/[;\n]+/).map(s => s.trim()).filter(Boolean));
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Login emails supplied through the environment, keyed by user id. Form:
 *  AUTH_EMAIL_<ID>="a@x.com, b@y.com" (id uppercased). Read per call, not at
 *  import, so a restart or a test can change them without reloading the module. */
export function envEmails(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^AUTH_EMAIL_(.+)$/.exec(k);
    if (m && v) {
      const id = m[1].toLowerCase();
      out[id] = uniq([...(out[id] || []), ...parseEmails(v)]);
    }
  }
  return out;
}

/** Merge the built-in roster with per-deployment overrides. File entries (from
 * data/users.json) and env emails are matched to defaults by id; a file may add
 * new members or extend an existing member's fields. Emails are unioned and
 * lowercased so the same address is never stored twice or in mixed case. */
export function buildRoster(defaults = DEFAULT_USERS, fileUsers = [], emailsById = {}) {
  const byId = new Map();
  const merge = u => {
    if (!u || !u.id) return;
    const cur = byId.get(u.id) || { id: u.id, displayName: u.id, role: 'member', fideId: null, playerNames: [], rating: null, emails: [] };
    byId.set(u.id, {
      ...cur,
      ...u,
      emails: uniq([...(cur.emails || []), ...(u.emails || [])].map(lc)),
    });
  };
  for (const u of defaults) merge(u);
  for (const u of fileUsers) merge(u);
  for (const [id, emails] of Object.entries(emailsById)) merge({ id, emails });
  return [...byId.values()];
}

/** Find the allowlisted user for a login email, or null if not allowlisted. */
export function resolveUserByEmail(roster, email) {
  const e = lc(email);
  if (!e) return null;
  return roster.find(u => (u.emails || []).includes(e)) || null;
}

/** A view of a user safe to send to the browser: no email addresses. */
export function publicUser(u) {
  if (!u) return null;
  const { id, displayName, role, fideId, rating } = u;
  return { id, displayName, role, fideId, rating };
}

async function readUsersFile() {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'users.json'), 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.users)) return raw.users;
    return [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

const slugId = (prefix, e) => prefix + lc(e).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const slugEmail = e => slugId('v_', e);   // visitor id from email
const memberId = e => slugId('p_', e);    // admin-added player (member) id from email

/** The full roster: built-in members plus data/users.json plus AUTH_EMAIL_* env,
 * plus a flat visitor allowlist (AUTH_VISITOR_EMAILS). Visitors have no data of
 * their own: each is a thin identity keyed by their email, allowed to see the
 * shared scouting library and practice drills/puzzles without anything recorded.
 * A member or admin email always wins over the visitor list. */
export async function getUsers() {
  const roster = buildRoster(DEFAULT_USERS, await readUsersFile(), envEmails());
  const taken = new Set(roster.flatMap(u => u.emails || []));
  for (const email of parseEmails(process.env.AUTH_VISITOR_EMAILS || '')) {
    if (taken.has(email)) continue;
    roster.push({ id: slugEmail(email), displayName: email, role: 'visitor', fideId: null, playerNames: [], rating: null, emails: [email] });
  }
  return roster;
}

export async function getUser(id) {
  return (await getUsers()).find(u => u.id === id) || null;
}

export async function listMembers() {
  return (await getUsers()).filter(u => u.role === 'member');
}

export function isAdmin(user) {
  return !!user && user.role === 'admin';
}

export function isVisitor(user) {
  return !!user && user.role === 'visitor';
}

/** Look up an allowlisted user by their login email (full roster), or null. */
export async function findUserByEmail(email) {
  return resolveUserByEmail(await getUsers(), email);
}

/** The member a scout-subject name refers to (matched on displayName or any of
 * their playerNames), so a member's own games can back their opponent-facing prep
 * sheet when they have no scout book. Null for a non-member subject. */
export async function memberByName(name) {
  const n = lc(name);
  if (!n) return null;
  return (await listMembers()).find(u => lc(u.displayName) === n || (u.playerNames || []).some(p => lc(p) === n)) || null;
}

// --- admin-managed roster (data/users.json) ---------------------------------
// The admin UI adds visitors and players here. buildRoster merges these by id
// with the built-ins, so a fresh id creates a user and a reused id extends one.
// Written on the producer and bundled to the mirror at publish time.

/** The entries currently stored in data/users.json (admin-managed, removable). */
export async function managedUsers() { return readUsersFile(); }

async function writeUsersFile(users) { await writeJson(path.join(DATA_DIR, 'users.json'), users); }

async function upsertRosterEntry(entry) {
  const users = await readUsersFile();
  const i = users.findIndex(u => u.id === entry.id);
  if (i >= 0) users[i] = { ...users[i], ...entry, emails: uniq([...(users[i].emails || []), ...(entry.emails || [])].map(lc)) };
  else users.push(entry);
  await writeUsersFile(users);
  return entry;
}

/** Add (or re-point) a visitor by email. */
export async function addVisitor(email) {
  const e = lc(email);
  if (!EMAIL_RE.test(e)) throw new Error('enter a valid email address');
  return upsertRosterEntry({ id: slugEmail(e), displayName: e, role: 'visitor', fideId: null, playerNames: [], rating: null, emails: [e] });
}

/** Add a player (member) with a login email and optional FIDE id / name matches. */
export async function addMember({ email, displayName, fideId = null, playerNames = [], rating = null }) {
  const e = lc(email);
  if (!EMAIL_RE.test(e)) throw new Error('enter a valid email address');
  const name = String(displayName || '').trim();
  if (!name) throw new Error('enter a display name');
  return upsertRosterEntry({
    id: memberId(e), displayName: name, role: 'member',
    fideId: fideId ? String(fideId).trim() : null,
    playerNames: parseNames(playerNames), rating: rating ?? null, emails: [e],
  });
}

/** Remove an admin-managed entry. Built-ins and env visitors are not in the file. */
export async function removeRosterEntry(id) {
  const users = await readUsersFile();
  const next = users.filter(u => u.id !== id);
  if (next.length === users.length) return false;
  await writeUsersFile(next);
  return true;
}
