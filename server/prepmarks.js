// Prep-deck marks: a per-drill seen/right tally for the cards worked from the
// Prepare page, outside the drill ladder. Their own small store, like the
// upcoming list (a file under data/users/<id>/ locally, a chess_kv row
// prep:<id> on the hosted mirror), so a deck answer from a phone is a
// row-sized write, not a rewrite of the whole drill store with its
// compare-and-swap race. Marks written before this store lived inside the
// drill store; they are read from there until the first write here copies
// them over.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { userDir, writeJson, kvEnabled, kvGet, kvPut, getDrills, DEFAULT_USER } from './store.js';

const FILE = uid => path.join(userDir(uid), 'prep.json');
const KEY = uid => `prep:${uid}`;
const MAX_MARKS = 2000; // the oldest marks fall out past this

async function readOwn(uid) {
  if (kvEnabled()) { try { return await kvGet(KEY(uid)); } catch { return null; } }
  try { return JSON.parse(await fs.readFile(FILE(uid), 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

async function write(uid, marks) {
  if (kvEnabled()) { try { await kvPut(KEY(uid), marks); return; } catch { /* fall through to the file */ } }
  await writeJson(FILE(uid), marks);
}

/** Every mark for a member: { [drillId]: { seen, right, lastAt } }. */
export async function getPrepMarks(uid = DEFAULT_USER) {
  const own = await readOwn(uid);
  if (own) return own;
  return (await getDrills(uid)).prep || {}; // legacy: marks kept inside the drill store
}

// Writes are read-modify-write of one small object; serialise them per process.
let chain = Promise.resolve();

/** A deck item was attempted. Returns the item's updated tally. */
export function markPrep(id, correct, uid = DEFAULT_USER) {
  const run = async () => {
    const marks = await getPrepMarks(uid);
    const m = marks[id] || { seen: 0, right: 0 };
    m.seen++;
    if (correct) m.right++;
    m.lastAt = new Date().toISOString();
    marks[id] = m;
    const ids = Object.keys(marks);
    if (ids.length > MAX_MARKS) for (const k of ids.sort((a, b) => (marks[a].lastAt || '').localeCompare(marks[b].lastAt || '')).slice(0, ids.length - MAX_MARKS)) delete marks[k];
    await write(uid, marks);
    return m;
  };
  const p = chain.then(run, run);
  chain = p.then(() => {}, () => {});
  return p;
}
