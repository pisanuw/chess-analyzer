// Display profile (name, picture) captured from Google sign-in, so the top bar
// can show who is signed in. Kept out of the roster (which is identity only) and
// stored where the deployment can write: Supabase on the hosted mirror (no disk),
// a JSON file locally. The session cookie stays a bare signed user id.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, writeJson, kvEnabled, kvGet, kvPut } from './store.js';

const FILE = () => path.join(DATA_DIR, 'profiles.json');
const kvKey = userId => `profile:${userId}`;

export async function getProfile(userId) {
  if (!userId) return null;
  if (kvEnabled()) { try { return await kvGet(kvKey(userId)); } catch { /* fall through to file */ } }
  try { return JSON.parse(await fs.readFile(FILE(), 'utf8'))[userId] || null; }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

export async function saveProfile(userId, profile) {
  const value = { name: profile.name || null, picture: profile.picture || null, updatedAt: new Date().toISOString() };
  if (kvEnabled()) { try { await kvPut(kvKey(userId), value); return value; } catch { /* fall through to file */ } }
  let all = {};
  try { all = JSON.parse(await fs.readFile(FILE(), 'utf8')); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  all[userId] = value;
  await writeJson(FILE(), all);
  return value;
}
