// A small audit log so the admin can see who signed in from where and what
// material actions were taken. Best-effort and capped: the most recent CAP
// events, stored where the deployment can write (Supabase on the hosted mirror,
// a JSON file locally). Never throws into a request path.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, writeJson, kvEnabled, kvGet, kvPut } from './store.js';

const FILE = () => path.join(DATA_DIR, 'audit.json');
const CAP = 500;

async function read() {
  if (kvEnabled()) { try { return (await kvGet('audit')) || []; } catch { /* fall through */ } }
  try { return JSON.parse(await fs.readFile(FILE(), 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}

// Appends are a read-modify-write of the whole log, so they run one at a time:
// two admin mutations landing together would otherwise drop one event.
let chain = Promise.resolve();

/** Append one event: { action, userId, name, role, ip, detail }. Fire and
 * forget from request handlers; failures are logged, never thrown. */
export function logEvent(event) {
  const run = async () => {
    try {
      const log = await read();
      log.push({ at: new Date().toISOString(), ...event });
      const capped = log.slice(-CAP);
      if (kvEnabled()) { try { await kvPut('audit', capped); return; } catch { /* fall through to file */ } }
      await writeJson(FILE(), capped);
    } catch (err) {
      console.error(`audit log write failed: ${err.message}`);
    }
  };
  const p = chain.then(run, run);
  chain = p;
  return p;
}

/** Most recent events first, capped at `limit`. */
export async function readAudit(limit = 200) {
  const log = await read();
  return log.slice(-limit).reverse();
}

/** The requesting client's IP (same rule the login throttle uses: the CDN-set
 * peer header on the mirror, the socket address locally; XFF is ignored). */
export const eventIp = req => String(req.headers['x-nf-client-connection-ip'] || req.ip || '').trim();
