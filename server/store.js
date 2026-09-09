// JSON file storage under data/. One file per game, plus settings.json and drills.json.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The repo root. Every supported entry point (npm start, tests, and the bundled
// Netlify function) runs with the working directory at the repo root, so cwd is
// correct here and we avoid import.meta, which the CJS function bundle leaves empty.
const ROOT = process.cwd();
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const GAMES_DIR = path.join(DATA_DIR, 'games');

export const DEFAULT_SETTINGS = {
  playerNames: [],          // substrings matched against White/Black headers, case-insensitive
  playerRating: 2000,
  enginePath: '',           // blank = auto-detect
  engineDepth: 18,
  engineMultiPv: 3,
  engineThreads: 0,         // 0 = cpus - 1
  engineHash: 256,
  remoteHosts: [],          // ssh hosts that run Stockfish for distributed analysis (no daemon: ssh host stockfish IS a UCI engine)
  remoteEnginePath: '~/stockfish', // Stockfish on the remote hosts: the binary, or a directory containing one
  remoteThreads: 4,         // threads per remote engine; modest by default, the hosts are shared machines
  useLocalEngine: true,     // false = keep this machine out of the analysis pool (offload all engine work to remotes); it still coordinates and runs explanations
  momentThreshold: 12,      // win-probability drop (0..100) that makes a player move a critical moment
  drillThreshold: 20,       // moments with at least this loss become drills
  llmProvider: 'claude-cli', // 'claude-cli' | 'manual'
  claudeModel: '',          // blank = CLI default
  autoExplain: true,        // run LLM explanations right after engine analysis
};

async function ensureDirs() {
  await fs.mkdir(GAMES_DIR, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// Writes to the same file are serialized and use a unique tmp path, so two
// concurrent saves (job step vs HTTP route) can never splice or race a rename.
// Exported for sibling stores (evalcache.js) that keep their own files.
let tmpSeq = 0;
const writeQueues = new Map();
export function writeJson(file, value) {
  const prev = writeQueues.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    await ensureDirs();
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2));
    await fs.rename(tmp, file);
  });
  writeQueues.set(file, next);
  next.catch(() => {}).finally(() => { if (writeQueues.get(file) === next) writeQueues.delete(file); });
  return next;
}

/** Remove leftover atomic-write temp files. A crash between writeFile and
 * rename strands them, and the data repo's `git add -A` (push-data) would
 * sync the partial file to every machine. Called once at startup. */
export async function sweepTmpFiles() {
  await ensureDirs();
  let removed = 0;
  for (const dir of [DATA_DIR, GAMES_DIR]) {
    for (const f of await fs.readdir(dir).catch(() => [])) {
      if (!f.endsWith('.tmp')) continue;
      await fs.rm(path.join(dir, f), { force: true });
      removed++;
    }
  }
  return removed;
}

/** When data/ is its own git repo, make sure purely-local files never sync:
 * crash leftovers and the per-machine engine eval cache. */
export async function ensureDataIgnores(lines = ['*.tmp', 'evalcache.json']) {
  try { await fs.stat(path.join(DATA_DIR, '.git')); } catch { return; }
  const file = path.join(DATA_DIR, '.gitignore');
  const current = await fs.readFile(file, 'utf8').catch(() => '');
  const have = new Set(current.split('\n').map(s => s.trim()));
  const missing = lines.filter(l => !have.has(l));
  if (!missing.length) return;
  await fs.writeFile(file, (!current || current.endsWith('\n') ? current : current + '\n') + missing.join('\n') + '\n');
}

export async function getSettings() {
  const saved = await readJson(path.join(DATA_DIR, 'settings.json'), {});
  const s = { ...DEFAULT_SETTINGS, ...saved };
  if (process.env.READONLY_DATA) { s.llmProvider = 'manual'; s.autoExplain = false; }
  return s;
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await writeJson(path.join(DATA_DIR, 'settings.json'), next);
  return next;
}

// listGames() backs every view, report, and job lookup; parsing each full game
// file (MultiPV lines included) on every call is the entire cost of those
// endpoints once the collection grows. Cache the small index entry per file,
// keyed by mtime and size, and invalidate on our own writes; external writers
// (git pull in the data repo) produce new mtimes and fall through the cache.
const indexCache = new Map(); // absolute path -> { mtimeMs, size, entry }

export async function listGames() {
  await ensureDirs();
  const files = (await fs.readdir(GAMES_DIR)).filter(f => f.endsWith('.json'));
  const games = await Promise.all(files.map(async f => {
    const file = path.join(GAMES_DIR, f);
    let stat;
    try { stat = await fs.stat(file); } catch { return null; } // deleted between readdir and stat
    const hit = indexCache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.entry;
    // One corrupt file must not take down every list-based endpoint; skip and
    // warn (once per version of the file, thanks to the cache).
    const g = await readJson(file, null).catch(err => {
      console.error(`skipping unreadable game file ${f}: ${err.message}`);
      return null;
    });
    const entry = g ? gameIndexEntry(g) : null;
    indexCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entry });
    return entry;
  }));
  return games.filter(Boolean).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.importedAt.localeCompare(a.importedAt));
}

export function gameIndexEntry(g) {
  const s = g.analysis?.summary;
  const p = g.playerColor && s ? s[g.playerColor] : null;
  return {
    id: g.id,
    white: g.headers.White || '?',
    black: g.headers.Black || '?',
    whiteElo: g.headers.WhiteElo || null,
    blackElo: g.headers.BlackElo || null,
    event: g.headers.Event || '',
    date: g.headers.Date || '',
    round: g.headers.Round || '',
    result: g.headers.Result || '*',
    eco: g.headers.ECO || '',
    plies: g.moves.length,
    playerColor: g.playerColor,
    purpose: g.purpose || 'own',
    subject: g.subject || null,
    status: g.status,
    importedAt: g.importedAt,
    accuracy: p ? p.accuracy : null,
    acpl: p ? p.acpl : null,
    mistakes: p ? p.mistakes : null,
    blunders: p ? p.blunders : null,
    moments: s ? s.moments.length : null,
    explained: g.explanations ? Object.keys(g.explanations).length : 0,
  };
}

const isValidId = id => /^[a-f0-9]{12}$/.test(id);

export async function getGame(id) {
  if (!isValidId(id)) return null;
  return readJson(path.join(GAMES_DIR, id + '.json'), null);
}

export async function saveGame(game) {
  const file = path.join(GAMES_DIR, game.id + '.json');
  await writeJson(file, game);
  indexCache.delete(file);
  return game;
}

export async function deleteGame(id) {
  if (!isValidId(id)) return;
  const file = path.join(GAMES_DIR, id + '.json');
  await fs.rm(file, { force: true });
  indexCache.delete(file);
}

// Drill/guess state is per machine. The hosted copy has no persistent disk, so
// when SUPABASE_URL is set the whole store lives as one jsonb row in Supabase
// (table chess_kv). The in-process drill mutation lock serializes one instance,
// but concurrent function instances share nothing, so hosted writes are
// compare-and-swap on a revision counter kept inside the value.
const sb = () => process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? { url: process.env.SUPABASE_URL, headers: { apikey: process.env.SUPABASE_SERVICE_KEY, authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'content-type': 'application/json' } }
  : null;

/** A hosted drill write lost the compare-and-swap race; the caller re-reads and reapplies. */
export class DrillConflict extends Error {}

/** True when the hosted key-value store (Supabase) is configured. Callers that
 * have a local fallback use this to decide whether to bother with the network. */
export function kvEnabled() {
  return !!sb();
}

/** Read one jsonb value from the shared chess_kv table (hosted only), or null
 * when Supabase is not configured. Throws on a transport/HTTP error so callers
 * can fall back. Used for cross-instance state that is not the drill store,
 * e.g. the login throttle counter. */
export async function kvGet(key) {
  const s = sb();
  if (!s) return null;
  const r = await fetch(`${s.url}/rest/v1/chess_kv?key=eq.${encodeURIComponent(key)}&select=value`, { headers: s.headers });
  if (!r.ok) throw new Error(`kv read failed (${r.status})`);
  return (await r.json())[0]?.value ?? null;
}

/** Upsert one jsonb value into chess_kv (hosted only); no-op without Supabase.
 * Best-effort last-writer-wins (unlike the drill store's CAS): callers here
 * tolerate a small race, e.g. an under-count on the login throttle. */
export async function kvPut(key, value) {
  const s = sb();
  if (!s) return;
  const r = await fetch(`${s.url}/rest/v1/chess_kv?on_conflict=key`, {
    method: 'POST',
    headers: { ...s.headers, prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ key, value }]),
  });
  if (!r.ok) throw new Error(`kv write failed (${r.status})`);
}

export async function getDrills() {
  const s = sb();
  let store;
  if (s) {
    const r = await fetch(`${s.url}/rest/v1/chess_kv?key=eq.drills&select=value`, { headers: s.headers });
    if (!r.ok) throw new Error(`drill store read failed (${r.status})`);
    store = (await r.json())[0]?.value || { drills: [] };
  } else {
    store = await readJson(path.join(DATA_DIR, 'drills.json'), { drills: [] });
  }
  store.guesses = store.guesses || {};   // guess-first attempts, keyed gameId:ply
  store.feedback = store.feedback || {}; // explanation feedback, keyed gameId:ply
  store.decoys = store.decoys || { seen: 0, right: 0 }; // quiet-position detection tally
  store.rev = store.rev || 0;            // CAS revision (0 = new store or legacy row)
  return store;
}

// drills.json itself is per-machine and never synced (each machine keeps its
// own ladder), but the review HISTORY inside it is worth preserving: it will
// feed the per-drill ease fit, and a dead laptop should not erase months of
// it. Every local save therefore also mirrors the store to drills-<host>.json,
// which the data repo DOES sync; other machines read those files as foreign,
// read-only history for report stats.
const HOST = os.hostname().split('.')[0].replace(/[^a-zA-Z0-9_-]+/g, '-') || 'machine';
const mirrorFile = () => path.join(DATA_DIR, `drills-${HOST}.json`);

/** Drill stores mirrored from OTHER machines: [{ machine, drills }]. */
export async function getForeignDrillStores() {
  await ensureDirs();
  const out = [];
  for (const f of await fs.readdir(DATA_DIR).catch(() => [])) {
    const m = f.match(/^drills-(.+)\.json$/);
    if (!m || m[1] === HOST) continue;
    const store = await readJson(path.join(DATA_DIR, f), null).catch(() => null);
    if (Array.isArray(store?.drills)) out.push({ machine: m[1], drills: store.drills });
  }
  return out;
}

export async function getPrepSheets() {
  return readJson(path.join(DATA_DIR, 'prepsheets.json'), {});
}

export async function savePrepSheets(sheets) {
  await writeJson(path.join(DATA_DIR, 'prepsheets.json'), sheets);
  return sheets;
}

export async function getPatternNotes() {
  return readJson(path.join(DATA_DIR, 'patterns.json'), {});
}

export async function savePatternNotes(notes) {
  await writeJson(path.join(DATA_DIR, 'patterns.json'), notes);
  return notes;
}

export async function saveDrills(value) {
  const s = sb();
  if (!s) {
    await writeJson(path.join(DATA_DIR, 'drills.json'), value);
    await writeJson(mirrorFile(), value).catch(() => {}); // best effort: the mirror is derived history
    return value;
  }
  // Claim the next revision only if the row still holds the one we read; an
  // empty result means another instance wrote first (throw DrillConflict so
  // the drill lock re-reads and reapplies). rev 0 matches a legacy row that
  // predates the counter, or no row at all.
  const prevRev = value.rev || 0;
  const next = { ...value, rev: prevRev + 1 };
  const filter = prevRev ? `value->>rev=eq.${prevRev}` : 'value->>rev=is.null';
  const patch = await fetch(`${s.url}/rest/v1/chess_kv?key=eq.drills&${filter}`, {
    method: 'PATCH',
    headers: { ...s.headers, prefer: 'return=representation' },
    body: JSON.stringify({ value: next }),
  });
  if (!patch.ok) throw new Error(`drill store write failed (${patch.status})`);
  if ((await patch.json()).length) return next;
  if (!prevRev) {
    // No row matched: usually the first ever write. Insert without clobbering
    // a row another instance created in the meantime.
    const post = await fetch(`${s.url}/rest/v1/chess_kv`, {
      method: 'POST',
      headers: { ...s.headers, prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify([{ key: 'drills', value: next }]),
    });
    if (!post.ok) throw new Error(`drill store write failed (${post.status})`);
    if ((await post.json()).length) return next;
  }
  throw new DrillConflict('drill store was updated by another writer');
}
