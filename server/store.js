// JSON file storage under data/. One file per game, plus settings.json and drills.json.
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fideIdFromHeaders } from './pgn.js';
import { pgnDateKey } from '../public/shared.js';

// The repo root. Every supported entry point (npm start, tests, and the bundled
// Netlify function) runs with the working directory at the repo root, so cwd is
// correct here and we avoid import.meta, which the CJS function bundle leaves empty.
const ROOT = process.cwd();
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const GAMES_DIR = path.join(DATA_DIR, 'games');
// Scout "book" tier: one compact file per opponent, keyed by FIDE id. Kept out
// of GAMES_DIR so hundreds of an opponent's games never mix into the player's
// own game list or the analysis queue.
const SCOUTS_DIR = path.join(DATA_DIR, 'scouts');

// Per-user ownership. own-purpose games belong to one member; scout-purpose
// games are shared (the scouting library that every member sees). Ownership is a
// field on the record, not a directory, so GAMES_DIR, the Netlify bundle, and
// the existing tooling are all untouched, and a game a member played against
// another member never collides on the content-hash id across two dirs. Legacy
// own games written before this (no owner) belong to the original single user
// (DEFAULT_USER). Pass userId '*' (ALL_USERS) to bypass the filter for admin or
// genuinely global work (learning FIDE ids, the analysis queue).
export const DEFAULT_USER = process.env.DEFAULT_USER || 'kai';
export const ALL_USERS = '*';

/** True when a game (or its index entry) is visible to userId: scout games are
 * shared with everyone; own games match their owner, and a missing owner is the
 * original user. userId '*' sees everything. */
export function ownsGame(game, userId = DEFAULT_USER) {
  if (!game) return false;
  if (userId === ALL_USERS) return true;
  if ((game.purpose || 'own') === 'scout') return true;
  return (game.owner || DEFAULT_USER) === userId;
}

// A member's private per-machine data (drill ladder + review history, pattern
// study notes) lives under data/users/<id>/. Own games themselves stay in
// GAMES_DIR keyed by owner (see ownsGame); only the derived per-user state is
// namespaced by directory. The id is validated so it can never escape the dir.
const USERS_DIR = path.join(DATA_DIR, 'users');
const isUserId = id => /^[a-z0-9][a-z0-9_-]{0,39}$/i.test(String(id || ''));
export function userDir(userId = DEFAULT_USER) {
  if (!isUserId(userId)) throw new Error(`bad user id: ${userId}`);
  return path.join(USERS_DIR, userId);
}

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
  // Opponent scouting from a large per-player export (book tier). Recency and
  // rating bound which games describe the opponent you will actually face.
  scoutMaxAgeYears: 3,      // games older than this are dropped (the player is a different one)
  scoutEloBand: 200,        // games more than this below/above current strength are off-profile
  scoutHalfLifeDays: 540,   // recency weight halves every this many days (~18 months)
  scoutAnalyseCount: 50,    // how many recent, on-strength games to promote for the engine dossier
  llmProvider: 'claude-cli', // 'claude-cli' | 'manual'
  claudeModel: '',          // blank = CLI default
  autoExplain: true,        // run LLM explanations right after engine analysis
};

async function ensureDirs() {
  await fs.mkdir(GAMES_DIR, { recursive: true });
}

// A FIDE id is the book filename; validate before touching the filesystem so a
// crafted id cannot escape the scouts directory.
const isFideId = id => /^\d{3,}$/.test(String(id || ''));

export async function listScoutBooks() {
  await fs.mkdir(SCOUTS_DIR, { recursive: true });
  const out = [];
  for (const f of (await fs.readdir(SCOUTS_DIR).catch(() => [])).filter(f => f.endsWith('.json'))) {
    const b = await readJson(path.join(SCOUTS_DIR, f), null).catch(() => null);
    if (b?.fideId) out.push(b);
  }
  return out;
}

export async function getScoutBook(fideId) {
  if (!isFideId(fideId)) return null;
  return readJson(path.join(SCOUTS_DIR, fideId + '.json'), null);
}

export async function saveScoutBook(book) {
  if (!isFideId(book?.fideId)) throw new Error('scout book needs a numeric FIDE id');
  await fs.mkdir(SCOUTS_DIR, { recursive: true });
  await writeJson(path.join(SCOUTS_DIR, book.fideId + '.json'), book);
  return book;
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
    await fs.mkdir(path.dirname(file), { recursive: true }); // works for GAMES_DIR, per-user dirs, and the root alike
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2));
    await fs.rename(tmp, file);
  });
  writeQueues.set(file, next);
  next.catch(() => {}).finally(() => { if (writeQueues.get(file) === next) writeQueues.delete(file); });
  return next;
}

/** Remove leftover atomic-write temp files, anywhere under DATA_DIR (games/,
 * scouts/, users/<id>/, and the root alike: writeJson's tmp path always sits
 * next to its target file, so a crash strands one whichever directory that
 * is in). A crash between writeFile and rename strands them, and the data
 * repo's `git add -A` (push-data) would sync the partial file to every
 * machine. Called once at startup. Never descends into `.git`: data/ can be
 * its own git repo, and that tree is not this sweep's business. */
export async function sweepTmpFiles() {
  await ensureDirs();
  let removed = 0;
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (e.name.endsWith('.tmp')) { await fs.rm(full, { force: true }); removed++; }
    }
  }
  await walk(DATA_DIR);
  return removed;
}

/** When data/ is its own git repo, make sure purely-local files never sync:
 * crash leftovers, the per-machine engine eval cache, and the scout book blobs
 * (each holds hundreds of games' PGN; they are rebuilt locally from the export,
 * and the analysed subset syncs as normal game files). */
export async function ensureDataIgnores(lines = ['*.tmp', 'evalcache.json', 'scouts/', 'clash.json', 'clashnotes.json']) {
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

export async function listGames(userId = DEFAULT_USER) {
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
    // fileRev names this version of the file: the aggregate readers key their
    // parsed-game cache and their memoised results on it (see indexFingerprint).
    const entry = g ? { ...gameIndexEntry(g), fileRev: `${stat.mtimeMs}:${stat.size}` } : null;
    indexCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entry });
    return entry;
  }));
  return games.filter(Boolean)
    .filter(e => ownsGame(e, userId))
    .sort((a, b) => pgnDateKey(b.date) - pgnDateKey(a.date) || b.importedAt.localeCompare(a.importedAt));
}

/** A short hash of which game files are in a list and which version of each:
 * the memo key for everything derived from those games (reports, repertoires,
 * puzzle pools, the student's clash index). Order-independent. */
export function indexFingerprint(entries) {
  const h = createHash('sha1');
  for (const s of entries.map(e => `${e.id}:${e.fileRev || ''}`).sort()) h.update(s + '\n');
  return h.digest('hex').slice(0, 16);
}

// Full parsed games for the aggregate readers (report, repertoire, puzzles,
// clash, decoys, drill sync), each of which used to read and parse every own
// game file per call. Keyed by file and version like the index cache, capped
// so a large collection cannot pin unbounded memory. The objects are SHARED
// between callers and must be treated as read-only: anything that mutates and
// saves a game keeps using getGame, and our own writes evict the entry.
const gameCache = new Map(); // absolute path -> { rev, game }
const GAME_CACHE_MAX = 400;

/** The full game for one index entry (from listGames), served from the parsed
 * cache when the file is unchanged. Null when the file is gone or unreadable. */
export async function getGameCached(entry) {
  if (!entry?.id || !isValidId(entry.id)) return null;
  const file = path.join(GAMES_DIR, entry.id + '.json');
  let rev = entry.fileRev;
  if (!rev) {
    try { const st = await fs.stat(file); rev = `${st.mtimeMs}:${st.size}`; } catch { return null; }
  }
  const hit = gameCache.get(file);
  if (hit && hit.rev === rev) { gameCache.delete(file); gameCache.set(file, hit); return hit.game; } // refresh LRU order
  const game = await readJson(file, null).catch(() => null);
  if (game) {
    gameCache.set(file, { rev, game });
    while (gameCache.size > GAME_CACHE_MAX) gameCache.delete(gameCache.keys().next().value);
  }
  return game;
}

/** Every full game for a list of index entries, cache-backed, unreadable ones dropped. */
export async function loadGames(entries) {
  return (await Promise.all(entries.map(getGameCached))).filter(Boolean);
}

/** Every game regardless of owner (own of all members plus the shared scout
 * library): for admin views and global work. Shorthand for listGames('*'). */
export function listAllGames() {
  return listGames(ALL_USERS);
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
    whiteFideId: fideIdFromHeaders(g.headers, 'white'),
    blackFideId: fideIdFromHeaders(g.headers, 'black'),
    event: g.headers.Event || '',
    date: g.headers.Date || '',
    round: g.headers.Round || '',
    result: g.headers.Result || '*',
    eco: g.headers.ECO || '',
    plies: g.moves.length,
    playerColor: g.playerColor,
    purpose: g.purpose || 'own',
    owner: (g.purpose || 'own') === 'scout' ? null : (g.owner || DEFAULT_USER),
    subject: g.subject || null,
    subjectId: g.subjectId || null,
    status: g.status,
    importedAt: g.importedAt,
    accuracy: p ? p.accuracy : null,
    acpl: p ? p.acpl : null,
    mistakes: p ? p.mistakes : null,
    blunders: p ? p.blunders : null,
    moments: s ? s.moments.length : null,
    explained: g.explanations ? Object.keys(g.explanations).length : 0,
    // Pattern and concept names with counts, so the explain job's "known
    // patterns" list comes off the index instead of a full read per game.
    patterns: countNames(g.explanations, 'pattern'),
    concepts: countNames(g.explanations, 'concept'),
  };
}

function countNames(explanations, field) {
  const out = {};
  for (const e of Object.values(explanations || {})) {
    const v = e?.[field];
    if (typeof v === 'string' && v) out[v] = (out[v] || 0) + 1;
  }
  return out;
}

const isValidId = id => /^[a-f0-9]{12}$/.test(id);

// userId defaults to ALL_USERS (no ownership check) so existing by-id lookups are
// unchanged; pass a member id to enforce that they may see this game.
export async function getGame(id, userId = ALL_USERS) {
  if (!isValidId(id)) return null;
  const g = await readJson(path.join(GAMES_DIR, id + '.json'), null);
  if (g && !ownsGame(g, userId)) return null;
  return g;
}

// Stamp the owner on an own-purpose game that has none, so it belongs to the
// member who saved it. Scout games stay unowned (shared). An existing owner is
// never overwritten (re-saving another member's game keeps its owner).
export async function saveGame(game, userId = DEFAULT_USER) {
  if ((game.purpose || 'own') !== 'scout' && !game.owner) game.owner = userId;
  const file = path.join(GAMES_DIR, game.id + '.json');
  await writeJson(file, game);
  indexCache.delete(file);
  gameCache.delete(file);
  return game;
}

export async function deleteGame(id, userId = ALL_USERS) {
  if (!isValidId(id)) return;
  if (userId !== ALL_USERS) {
    const g = await readJson(path.join(GAMES_DIR, id + '.json'), null);
    if (g && !ownsGame(g, userId)) return; // not this member's game to delete
  }
  const file = path.join(GAMES_DIR, id + '.json');
  await fs.rm(file, { force: true });
  indexCache.delete(file);
  gameCache.delete(file);
}

// Drill/guess state is per machine. The hosted copy has no persistent disk, so
// when SUPABASE_URL is set the whole store lives as one jsonb row in Supabase
// (table chess_kv). The in-process drill mutation lock serializes one instance,
// but concurrent function instances share nothing, so hosted writes are
// compare-and-swap on a revision counter kept inside the value.
const sb = () => process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? { url: process.env.SUPABASE_URL, headers: { apikey: process.env.SUPABASE_SERVICE_KEY, authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'content-type': 'application/json' } }
  : null;

// Every Supabase call carries a timeout: a stalled connection used to hang a
// publish (or a function invocation) forever. A stall is retried once; every
// write here is safe to repeat (GET, an upsert, an insert that ignores
// duplicates, or the CAS PATCH, whose revision filter turns a replay of an
// already-applied write into a DrillConflict that the drill lock re-reads).
const sbTimeoutMs = () => Number(process.env.SUPABASE_TIMEOUT_MS) || 15000;
const isStall = err => err?.name === 'TimeoutError' || err?.name === 'AbortError';

export async function sbFetch(url, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    // An explicit (ref'd) timer rather than AbortSignal.timeout: that one is
    // unref'd, so in a publish script with nothing else pending the process
    // could exit before the deadline fired.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new DOMException(`timed out after ${sbTimeoutMs()}ms`, 'TimeoutError')), sbTimeoutMs());
    try {
      return await fetch(url, { ...opts, signal: ctl.signal });
    } catch (err) {
      if (isStall(err) && attempt < 1) continue;
      throw new Error(`supabase request ${isStall(err) ? `timed out after ${sbTimeoutMs()}ms` : 'failed'}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

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
  const r = await sbFetch(`${s.url}/rest/v1/chess_kv?key=eq.${encodeURIComponent(key)}&select=value`, { headers: s.headers });
  if (!r.ok) throw new Error(`kv read failed (${r.status})`);
  return (await r.json())[0]?.value ?? null;
}

/** Upsert one jsonb value into chess_kv (hosted only); no-op without Supabase.
 * Best-effort last-writer-wins (unlike the drill store's CAS): callers here
 * tolerate a small race, e.g. an under-count on the login throttle. */
export async function kvPut(key, value) {
  const s = sb();
  if (!s) return;
  const r = await sbFetch(`${s.url}/rest/v1/chess_kv?on_conflict=key`, {
    method: 'POST',
    headers: { ...s.headers, prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ key, value }]),
  });
  if (!r.ok) throw new Error(`kv write failed (${r.status})`);
}

export async function getDrills(userId = DEFAULT_USER) {
  const s = sb();
  let store;
  if (s) {
    const key = `drills:${userId}`;
    const r = await sbFetch(`${s.url}/rest/v1/chess_kv?key=eq.${encodeURIComponent(key)}&select=value`, { headers: s.headers });
    if (!r.ok) throw new Error(`drill store read failed (${r.status})`);
    store = (await r.json())[0]?.value || { drills: [] };
  } else {
    store = await readJson(path.join(userDir(userId), 'drills.json'), { drills: [] });
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
const mirrorFile = (userId = DEFAULT_USER) => path.join(userDir(userId), `drills-${HOST}.json`);

/** One member's drill stores mirrored from OTHER machines: [{ machine, drills }]. */
export async function getForeignDrillStores(userId = DEFAULT_USER) {
  const dir = userDir(userId);
  const out = [];
  for (const f of await fs.readdir(dir).catch(() => [])) {
    const m = f.match(/^drills-(.+)\.json$/);
    if (!m || m[1] === HOST) continue;
    const store = await readJson(path.join(dir, f), null).catch(() => null);
    if (Array.isArray(store?.drills)) out.push({ machine: m[1], drills: store.drills });
  }
  return out;
}

/** Move the original single user's per-machine files (drills.json, its
 * drills-<host>.json mirrors, patterns.json) from the DATA_DIR root into
 * data/users/<userId>/. Idempotent: skips a file once its destination exists.
 * Runs at startup so a machine that predates multi-user keeps its drill ladder,
 * review-history mirrors, and pattern notes. Returns the names moved. */
export async function migrateLegacyUserData(userId = DEFAULT_USER) {
  const dir = userDir(userId);
  await fs.mkdir(dir, { recursive: true });
  const moved = [];
  for (const f of await fs.readdir(DATA_DIR).catch(() => [])) {
    if (f !== 'drills.json' && f !== 'patterns.json' && !/^drills-.+\.json$/.test(f)) continue;
    const to = path.join(dir, f);
    try { await fs.stat(to); continue; } catch {}            // already migrated
    try {
      if (!(await fs.stat(path.join(DATA_DIR, f))).isFile()) continue;
      await fs.rename(path.join(DATA_DIR, f), to);
      moved.push(f);
    } catch {}
  }
  return moved;
}

export async function getPrepSheets() {
  return readJson(path.join(DATA_DIR, 'prepsheets.json'), {});
}

export async function savePrepSheets(sheets) {
  await writeJson(path.join(DATA_DIR, 'prepsheets.json'), sheets);
  return sheets;
}

// Cached opponent opening indexes for the clash feature, keyed by FIDE id. The
// expensive part (parsing hundreds of full PGNs) is done once per book import and
// stored here; the tree itself is assembled cheaply per request. Ignored by the
// data repo (like the eval cache and the book blobs): it is derived from a
// non-syncing book and cheap to rebuild, and a synced copy could point at a book
// the other machine lacks.
// The store holds every opponent's full index, so it is parsed once per file
// version rather than on every dossier, prep, or game view (each of which
// reads it, the head-to-head once per game). Our own save evicts the entry.
let clashCache = null; // { rev, store }
export async function getClashStore() {
  const file = path.join(DATA_DIR, 'clash.json');
  let rev = null;
  try { const st = await fs.stat(file); rev = `${st.mtimeMs}:${st.size}`; } catch { /* missing: an empty store */ }
  if (clashCache && clashCache.rev === rev) return clashCache.store;
  const store = await readJson(file, {});
  clashCache = { rev, store };
  return store;
}

export async function saveClashStore(store) {
  await writeJson(path.join(DATA_DIR, 'clash.json'), store);
  clashCache = null;
  return store;
}

// Optional coach narration of the clash lines, keyed by FIDE id. Derived from
// the non-syncing book (like the clash index), so it is gitignored too.
export async function getClashNotes() {
  return readJson(path.join(DATA_DIR, 'clashnotes.json'), {});
}

export async function saveClashNotes(notes) {
  await writeJson(path.join(DATA_DIR, 'clashnotes.json'), notes);
  return notes;
}

// Name <-> FIDE id map, keyed by id: { "<fideId>": { fideId, names: [], federation?, updatedAt } }.
// Small shared reference data, so it DOES sync between machines (not ignored).
export async function getPlayers() {
  return readJson(path.join(DATA_DIR, 'players.json'), {});
}

export async function savePlayers(map) {
  await writeJson(path.join(DATA_DIR, 'players.json'), map);
  return map;
}

export async function getPatternNotes(userId = DEFAULT_USER) {
  return readJson(path.join(userDir(userId), 'patterns.json'), {});
}

export async function savePatternNotes(notes, userId = DEFAULT_USER) {
  await writeJson(path.join(userDir(userId), 'patterns.json'), notes);
  return notes;
}

export async function saveDrills(value, userId = DEFAULT_USER) {
  const s = sb();
  if (!s) {
    await writeJson(path.join(userDir(userId), 'drills.json'), value);
    await writeJson(mirrorFile(userId), value).catch(() => {}); // best effort: the mirror is derived history
    return value;
  }
  // Each member's ladder is its own KV row (drills:<userId>), so their
  // compare-and-swap races are independent. Claim the next revision only if the
  // row still holds the one we read; an empty result means another instance
  // wrote first (throw DrillConflict so the drill lock re-reads and reapplies).
  // rev 0 matches a legacy row that predates the counter, or no row at all.
  const key = `drills:${userId}`;
  const prevRev = value.rev || 0;
  const next = { ...value, rev: prevRev + 1 };
  const filter = prevRev ? `value->>rev=eq.${prevRev}` : 'value->>rev=is.null';
  const patch = await sbFetch(`${s.url}/rest/v1/chess_kv?key=eq.${encodeURIComponent(key)}&${filter}`, {
    method: 'PATCH',
    headers: { ...s.headers, prefer: 'return=representation' },
    body: JSON.stringify({ value: next }),
  });
  if (!patch.ok) throw new Error(`drill store write failed (${patch.status})`);
  if ((await patch.json()).length) return next;
  if (!prevRev) {
    // No row matched: usually the first ever write. Insert without clobbering
    // a row another instance created in the meantime.
    const post = await sbFetch(`${s.url}/rest/v1/chess_kv`, {
      method: 'POST',
      headers: { ...s.headers, prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify([{ key, value: next }]),
    });
    if (!post.ok) throw new Error(`drill store write failed (${post.status})`);
    if ((await post.json()).length) return next;
  }
  throw new DrillConflict('drill store was updated by another writer');
}
