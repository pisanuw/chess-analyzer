// Express server: static frontend + JSON API. Runs locally; nothing leaves the machine except claude CLI calls.
import express from 'express';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Chess } from 'chess.js';
import { parsePgnFile, detectPlayerColor } from './pgn.js';
import { getSettings, saveSettings, listGames, getGame, saveGame, deleteGame, getPatternNotes, savePatternNotes, DEFAULT_SETTINGS, DATA_DIR } from './store.js';
import { enqueue, listJobs, resumeInterrupted, cancelJobs } from './jobs.js';
import { findStockfish, getEngine } from './engine.js';
import { checkClaudeCli, complete } from './llm.js';
import { buildReport } from './report.js';
import { buildRepertoire } from './repertoire.js';
import { scoreToCp } from './analyze.js';
import { dueDrills, reviewDrill, removeDrillsForGame, syncDrillsForGame, syncAllDrills, recordGuess } from './drills.js';
import { momentPrompt, systemPrompt, patternSynthesisPrompt, EXPLANATION_SCHEMA, PATTERN_SYNTH_SCHEMA, CATEGORIES } from './prompts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.text({ limit: '20mb', type: ['application/x-chess-pgn', 'text/plain'] }));

app.use('/vendor/chessground', express.static(path.join(ROOT, 'node_modules/chessground/dist')));
app.use('/vendor/chessground/assets', express.static(path.join(ROOT, 'node_modules/chessground/assets')));
app.use('/vendor/chess.js', express.static(path.join(ROOT, 'node_modules/chess.js/dist/esm')));
app.use(express.static(path.join(ROOT, 'public')));

// Bounds for numeric settings; out-of-range values are clamped, non-numbers rejected.
// A cleared field must not slip through as 0 (a 0 threshold drills every move).
const NUMERIC_LIMITS = {
  playerRating: [400, 3500], engineDepth: [4, 40], engineMultiPv: [1, 6],
  engineThreads: [0, 64], engineHash: [16, 8192], momentThreshold: [1, 100], drillThreshold: [1, 100],
};

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message });
});

// --- status & settings -------------------------------------------------------
app.get('/api/status', wrap(async (req, res) => {
  const settings = await getSettings();
  const enginePath = findStockfish(settings.enginePath);
  const claude = settings.llmProvider === 'claude-cli' ? await checkClaudeCli() : { ok: true, skipped: true };
  res.json({ enginePath, engineOk: !!enginePath, claude, dataDir: DATA_DIR, categories: CATEGORIES });
}));

app.get('/api/settings', wrap(async (req, res) => res.json({ settings: await getSettings(), defaults: DEFAULT_SETTINGS })));
app.put('/api/settings', wrap(async (req, res) => {
  const allowed = Object.keys(DEFAULT_SETTINGS);
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if (patch.playerNames && typeof patch.playerNames === 'string') patch.playerNames = patch.playerNames.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
  for (const [k, [min, max]] of Object.entries(NUMERIC_LIMITS)) {
    if (!(k in patch)) continue;
    const n = Number(patch[k]);
    if (patch[k] === '' || !Number.isFinite(n)) return res.status(400).json({ error: `${k} must be a number` });
    patch[k] = Math.min(max, Math.max(min, n));
  }
  res.json({ settings: await saveSettings(patch) });
}));

// --- games -------------------------------------------------------------------
app.get('/api/games', wrap(async (req, res) => res.json({ games: await listGames() })));

app.post('/api/games/import', wrap(async (req, res) => {
  const pgn = typeof req.body === 'string' ? req.body : req.body?.pgn;
  if (!pgn || !pgn.trim()) return res.status(400).json({ error: 'No PGN provided' });
  const purpose = req.body?.purpose === 'scout' ? 'scout' : 'own';
  const subject = String(req.body?.subject || '').trim();
  if (purpose === 'scout' && !subject) return res.status(400).json({ error: 'scouting needs the opponent name (subject)' });
  const settings = await getSettings();
  const parsed = parsePgnFile(pgn);
  const imported = [], skipped = [], failed = [];
  for (const r of parsed) {
    if (!r.ok) { failed.push({ error: r.error, snippet: r.snippet }); continue; }
    const g = r.game;
    if (!g.moves.length) { failed.push({ error: 'no moves', snippet: g.pgn.slice(0, 120) }); continue; }
    if (await getGame(g.id)) { skipped.push(g.id); continue; }
    const game = {
      id: g.id, headers: g.headers, moves: g.moves, pgn: g.pgn,
      // For scouting, the studied side is the subject, matched the same way as the player.
      playerColor: detectPlayerColor(g.headers, purpose === 'scout' ? [subject] : settings.playerNames),
      purpose, subject: purpose === 'scout' ? subject : null,
      status: 'imported', importedAt: new Date().toISOString(),
    };
    await saveGame(game);
    imported.push(game.id);
    if (game.playerColor && req.body?.analyse !== false) enqueue('analyse', game.id);
  }
  res.json({ imported, skipped, failed });
}));

app.get('/api/games/:id', wrap(async (req, res) => {
  const game = await getGame(req.params.id);
  if (!game) return res.status(404).json({ error: 'not found' });
  res.json({ game });
}));

app.delete('/api/games/:id', wrap(async (req, res) => {
  cancelJobs(req.params.id);
  await deleteGame(req.params.id);
  await removeDrillsForGame(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/games/:id/player', wrap(async (req, res) => {
  const game = await getGame(req.params.id);
  if (!game) return res.status(404).json({ error: 'not found' });
  const color = req.body?.color;
  if (!['white', 'black'].includes(color)) return res.status(400).json({ error: 'color must be white or black' });
  game.playerColor = color;
  if (game.analysis) {
    // Player flags and moments depend on colour; recompute cheaply from stored moves.
    const { summarize } = await import('./analyze.js');
    const settings = await getSettings();
    game.analysis.moves.forEach(m => { m.isPlayer = m.color === color; });
    game.analysis.summary = { ...game.analysis.summary, ...summarize(game.analysis.moves, color, settings.momentThreshold) };
    game.explanations = {};
    game.gameSummary = null;
    game.status = 'analysed';
    await removeDrillsForGame(game.id);
    await syncDrillsForGame(game, settings);
  }
  await saveGame(game);
  if (req.body?.analyse && !game.analysis) enqueue('analyse', game.id);
  res.json({ game });
}));

app.post('/api/games/:id/analyse', wrap(async (req, res) => {
  const game = await getGame(req.params.id);
  if (!game) return res.status(404).json({ error: 'not found' });
  if (!game.playerColor) return res.status(400).json({ error: 'set the player colour first' });
  if (req.body?.force) {
    cancelJobs(game.id); // a live job would restore the wiped analysis and shadow the re-run
    game.analysis = null; game.explanations = {}; game.gameSummary = null; game.status = 'imported'; await saveGame(game);
  }
  res.json({ job: enqueue('analyse', game.id) });
}));

app.post('/api/games/:id/explain', wrap(async (req, res) => {
  const game = await getGame(req.params.id);
  if (!game?.analysis) return res.status(400).json({ error: 'analyse the game first' });
  res.json({ job: enqueue('explain', game.id) });
}));

app.post('/api/games/analyse-all', wrap(async (req, res) => {
  const games = await listGames();
  const queued = [];
  for (const g of games) {
    if (!g.playerColor) continue;
    if (g.status === 'imported' || g.status === 'analysing') queued.push(enqueue('analyse', g.id).id);
    else if (g.status === 'analysed' && req.body?.explain !== false) queued.push(enqueue('explain', g.id).id);
  }
  res.json({ queued });
}));

// Manual LLM flow: get the prompt, post the answer.
app.get('/api/games/:id/moments/:ply/prompt', wrap(async (req, res) => {
  const game = await getGame(req.params.id);
  const ply = Number(req.params.ply);
  if (!game?.analysis || !game.analysis.moves[ply - 1]) return res.status(404).json({ error: 'not found' });
  const settings = await getSettings();
  res.json({ system: systemPrompt(settings.playerRating), prompt: momentPrompt(game, ply), schema: EXPLANATION_SCHEMA });
}));

app.put('/api/games/:id/moments/:ply/explanation', wrap(async (req, res) => {
  const game = await getGame(req.params.id);
  const ply = Number(req.params.ply);
  if (!game?.analysis || !game.analysis.moves[ply - 1]) return res.status(404).json({ error: 'not found' });
  const e = req.body || {};
  for (const k of ['pattern', 'category', 'explanation', 'key_question']) if (typeof e[k] !== 'string') return res.status(400).json({ error: `missing ${k}` });
  if (!CATEGORIES.includes(e.category)) return res.status(400).json({ error: 'unknown category' });
  game.explanations = game.explanations || {};
  game.explanations[ply] = { pattern: e.pattern, category: e.category, time_pressure: !!e.time_pressure, explanation: e.explanation, key_question: e.key_question, concept: e.concept || '', model: 'manual', createdAt: new Date().toISOString() };
  if (game.analysis.summary.moments.every(p => game.explanations[p])) game.status = 'explained';
  await saveGame(game);
  res.json({ game });
}));

// Guess-first attempts: recorded per machine (drill store), seeds and boosts drills.
app.post('/api/games/:id/moments/:ply/guess', wrap(async (req, res) => {
  const game = await getGame(req.params.id);
  const ply = Number(req.params.ply);
  if (!game?.analysis || !game.analysis.summary.moments.includes(ply)) return res.status(404).json({ error: 'not a moment' });
  const settings = await getSettings();
  const result = await recordGuess(game, ply, String(req.body?.uci || ''), !!req.body?.correct, settings);
  res.json(result);
}));

// Quick engine evaluation of a move the stored MultiPV lines do not cover.
app.post('/api/games/:id/moments/:ply/eval', wrap(async (req, res) => {
  const game = await getGame(req.params.id);
  const ply = Number(req.params.ply);
  const m = game?.analysis?.moves[ply - 1];
  if (!m) return res.status(404).json({ error: 'not found' });
  const uci = String(req.body?.uci || '');
  const chess = new Chess(m.fenBefore);
  let mv;
  try { mv = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch { mv = null; }
  if (!mv) return res.status(400).json({ error: 'illegal move' });
  const settings = await getSettings();
  const engine = await getEngine(settings);
  const r = await engine.analyse(chess.fen(), { depth: 12, multipv: 1, movetimeMs: 2000 });
  const sign = m.color === 'white' ? 1 : -1;
  const moverCp = -scoreToCp(r.lines[0]); // reply eval is from the opponent's perspective
  const bestCp = (m.lines[0]?.cp ?? m.evalBefore) * sign;
  res.json({ san: mv.san, cp: moverCp, bestCp, diff: +((bestCp - moverCp) / 100).toFixed(2) });
}));

// --- jobs, report, drills ----------------------------------------------------
app.get('/api/jobs', (req, res) => res.json({ jobs: listJobs() }));
app.get('/api/report', wrap(async (req, res) => res.json({ report: await buildReport() })));
app.get('/api/repertoire', wrap(async (req, res) => res.json({ repertoire: await buildRepertoire() })));

// --- scouting ----------------------------------------------------------------
app.get('/api/scout', wrap(async (req, res) => {
  const subjects = new Map();
  for (const g of await listGames()) {
    if (g.purpose !== 'scout' || !g.subject) continue;
    const s = subjects.get(g.subject) || { subject: g.subject, games: 0, analysed: 0 };
    s.games++;
    if (g.status === 'analysed' || g.status === 'explained') s.analysed++;
    subjects.set(g.subject, s);
  }
  res.json({ subjects: [...subjects.values()].sort((a, b) => b.games - a.games) });
}));

app.get('/api/scout/:subject', wrap(async (req, res) => {
  const subject = req.params.subject;
  const report = await buildReport({ purpose: 'scout', subject });
  if (!report.games) return res.status(404).json({ error: 'no analysed games for this subject' });
  const repertoire = await buildRepertoire({ purpose: 'scout', subject });
  res.json({ subject, report, repertoire });
}));

// --- pattern study notes -----------------------------------------------------
app.get('/api/patterns', wrap(async (req, res) => res.json({ notes: await getPatternNotes() })));
app.post('/api/patterns/synthesize', wrap(async (req, res) => {
  const name = String(req.body?.pattern || '').trim();
  if (!name) return res.status(400).json({ error: 'pattern required' });
  const settings = await getSettings();
  const report = await buildReport();
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const pat = report.patterns.find(p => p.pattern.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === key);
  if (!pat) return res.status(404).json({ error: 'pattern not found' });
  const instances = [];
  for (const ref of pat.moments.slice(0, 8)) {
    const g = await getGame(ref.gameId);
    const m = g?.analysis?.moves[ref.ply - 1];
    const e = g?.explanations?.[ref.ply];
    if (m && e) instances.push({ label: ref.label, date: ref.date, fen: m.fenBefore, san: m.san, bestSan: m.bestSan, judgment: m.judgment, explanation: e.explanation, key_question: e.key_question });
  }
  if (instances.length < 2) return res.status(400).json({ error: 'need at least 2 explained instances' });
  const { output, costUsd, model } = await complete(settings, {
    system: systemPrompt(settings.playerRating),
    prompt: patternSynthesisPrompt(pat.pattern, instances),
    schema: PATTERN_SYNTH_SCHEMA,
  });
  const notes = await getPatternNotes();
  notes[key] = { pattern: pat.pattern, ...output, count: pat.count, model, costUsd, createdAt: new Date().toISOString() };
  await savePatternNotes(notes);
  res.json({ note: notes[key] });
}));
app.get('/api/drills', wrap(async (req, res) => res.json(await dueDrills(Number(req.query.limit) || 20))));
app.post('/api/drills/:id/review', wrap(async (req, res) => {
  res.json({ drill: await reviewDrill(req.params.id, req.body?.grade || 'good', req.body?.correct) });
}));

app.get(/^\/(?!api|vendor).*/, (req, res) => res.sendFile(path.join(ROOT, 'public/index.html')));

export { app };

// Listen only when run directly; tests import { app } and listen on an ephemeral port.
const PORT = Number(process.env.PORT) || 3210;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(PORT, process.env.HOST || '127.0.0.1', () => {
    console.log(`chess-analyzer running at http://localhost:${PORT}  (data: ${DATA_DIR})`);
    syncAllDrills().catch(err => console.error(`drill sync failed: ${err.message}`));
    resumeInterrupted().catch(err => console.error(`resume failed: ${err.message}`));
  });
}
