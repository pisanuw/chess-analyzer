// A member's upcoming games: who, which colour, when, what time control. The
// list drives the "Prepare for a game" flow and the Home page's next-game line.
// Per member, stored like drills: a file under data/users/<id>/ locally, a
// chess_kv row (upcoming:<id>) on the hosted mirror, where there is no disk.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { userDir, writeJson, kvEnabled, kvGet, kvPut } from './store.js';

const FILE = uid => path.join(userDir(uid), 'upcoming.json');
const KEY = uid => `upcoming:${uid}`;

async function read(uid) {
  if (kvEnabled()) { try { return (await kvGet(KEY(uid))) || []; } catch { return []; } }
  try { return JSON.parse(await fs.readFile(FILE(uid), 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}

async function write(uid, list) {
  if (kvEnabled()) { try { await kvPut(KEY(uid), list); return; } catch { /* fall through to the file */ } }
  await writeJson(FILE(uid), list);
}

/** Soonest first; undated entries last. */
export async function listUpcoming(uid) {
  return (await read(uid)).sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.createdAt || '').localeCompare(b.createdAt || ''));
}

export async function addUpcoming(uid, { subject, fideId = null, color, date = '', timeControl = 'all', round = '' }) {
  const name = String(subject || '').trim().slice(0, 120);
  if (!name) throw Object.assign(new Error('an opponent name is required'), { status: 400 });
  if (!['white', 'black'].includes(color)) throw Object.assign(new Error('colour must be white or black (the colour you will have)'), { status: 400 });
  const when = String(date || '').trim();
  if (when && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(when)) throw Object.assign(new Error('date must be YYYY-MM-DD, optionally with THH:MM'), { status: 400 });
  const entry = {
    id: crypto.randomBytes(6).toString('hex'), subject: name,
    fideId: /^\d{3,}$/.test(String(fideId || '')) ? String(fideId) : null,
    color, date: when, timeControl: ['classical', 'rapid', 'blitz'].includes(timeControl) ? timeControl : 'all',
    round: String(round || '').trim().slice(0, 40), createdAt: new Date().toISOString(),
  };
  const list = await read(uid);
  list.push(entry);
  await write(uid, list);
  return entry;
}

export async function removeUpcoming(uid, id) {
  const list = await read(uid);
  const next = list.filter(e => e.id !== id);
  if (next.length === list.length) return false;
  await write(uid, next);
  return true;
}
