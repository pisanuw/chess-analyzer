// JSON file storage under data/. One file per game, plus settings.json and drills.json.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = import.meta.url ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') : process.cwd();
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
let tmpSeq = 0;
const writeQueues = new Map();
function writeJson(file, value) {
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

export async function listGames() {
  await ensureDirs();
  const files = (await fs.readdir(GAMES_DIR)).filter(f => f.endsWith('.json'));
  // One corrupt file must not take down every list-based endpoint; skip and warn.
  const games = await Promise.all(files.map(f => readJson(path.join(GAMES_DIR, f), null).catch(err => {
    console.error(`skipping unreadable game file ${f}: ${err.message}`);
    return null;
  })));
  return games.filter(Boolean).map(gameIndexEntry).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.importedAt.localeCompare(a.importedAt));
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
  await writeJson(path.join(GAMES_DIR, game.id + '.json'), game);
  return game;
}

export async function deleteGame(id) {
  if (!isValidId(id)) return;
  await fs.rm(path.join(GAMES_DIR, id + '.json'), { force: true });
}

// Drill/guess state is per machine. The hosted copy has no persistent disk, so
// when SUPABASE_URL is set the whole store lives as one jsonb row in Supabase
// (table chess_kv); our drill mutation lock already serializes access.
const sb = () => process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? { url: process.env.SUPABASE_URL, headers: { apikey: process.env.SUPABASE_SERVICE_KEY, authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'content-type': 'application/json' } }
  : null;

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
  store.guesses = store.guesses || {}; // guess-first attempts, keyed gameId:ply
  return store;
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
  if (s) {
    const r = await fetch(`${s.url}/rest/v1/chess_kv`, {
      method: 'POST',
      headers: { ...s.headers, prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify([{ key: 'drills', value }]),
    });
    if (!r.ok) throw new Error(`drill store write failed (${r.status})`);
    return value;
  }
  await writeJson(path.join(DATA_DIR, 'drills.json'), value);
  return value;
}
