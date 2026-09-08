// Express server: static frontend + JSON API. Runs locally; nothing leaves the machine except claude CLI calls.
import express from 'express';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Chess } from 'chess.js';
import { parsePgnFile, detectPlayerColor } from './pgn.js';
import { getSettings, saveSettings, listGames, getGame, saveGame, deleteGame, getDrills, getPatternNotes, savePatternNotes, getPrepSheets, savePrepSheets, sweepTmpFiles, ensureDataIgnores, DEFAULT_SETTINGS, DATA_DIR } from './store.js';
import { enqueue, listJobs, resumeInterrupted, cancelJobs } from './jobs.js';
import { findStockfish, getSparringEngine } from './engine.js';
import { probeHosts, remoteHostList } from './enginepool.js';
import { checkClaudeCli, complete } from './llm.js';
import { buildReport, buildPrepCard } from './report.js';
import { buildRepertoire } from './repertoire.js';
import { scoreToCp, winProb, summarize } from './analyze.js';
import { dueDrills, reviewDrill, undoReview, suspendDrill, restoreSuspended, removeDrillsForGame, syncDrillsForGame, syncAllDrills, recordGuess, recordFeedback, clearFeedback } from './drills.js';
import { momentPrompt, systemPrompt, scoutMomentPrompt, scoutSystemPrompt, prepSheetPrompt, patternSynthesisPrompt, reExplainSuffix, EXPLANATION_SCHEMA, SCOUT_EXPLANATION_SCHEMA, PREP_SHEET_SCHEMA, PATTERN_SYNTH_SCHEMA, CATEGORIES } from './prompts.js';
import { knownPatterns } from './jobs.js';
import { authMiddleware, loginRoute } from './auth.js';

// import.meta.url is undefined when bundled to CJS (Netlify function); there,
// static assets come from the CDN and DATA_DIR from the environment, so cwd is fine.
const ROOT = import.meta.url ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') : process.cwd();
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.text({ limit: '20mb', type: ['application/x-chess-pgn', 'text/plain'] }));

app.use(authMiddleware);
app.post('/api/login', loginRoute);

// Read-only mirror (hosted copy): game data is managed on the analysing machine
// and published; only training state (drill reviews, guesses) is writable.
const READONLY = !!process.env.READONLY_DATA;
const RO_ALLOW = [/^\/api\/login$/, /^\/api\/drills\/restore-suspended$/, /^\/api\/drills\/[^/]+\/(review|suspend|undo)$/, /^\/api\/games\/[a-f0-9]{12}\/moments\/\d+\/(guess|eval|feedback)$/];
app.use((req, res, next) => {
  if (!READONLY || req.method === 'GET' || RO_ALLOW.some(re => re.test(req.path))) return next();
  res.status(405).json({ error: 'read-only mirror: manage games on the analysing machine, then publish' });
});

app.use('/vendor/chessground', express.static(path.join(ROOT, 'node_modules/chessground/dist')));
app.use('/vendor/chessground/assets', express.static(path.join(ROOT, 'node_modules/chessground/assets')));
app.use('/vendor/chess.js', express.static(path.join(ROOT, 'node_modules/chess.js/dist/esm')));
app.use(express.static(path.join(ROOT, 'public')));

// Bounds for numeric settings; out-of-range values are clamped, non-numbers rejected.
// A cleared field must not slip through as 0 (a 0 threshold drills every move).
const NUMERIC_LIMITS = {
  playerRating: [400, 3500], engineDepth: [4, 40], engineMultiPv: [1, 6],
  engineThreads: [0, 64], engineHash: [16, 8192], remoteThreads: [1, 64],
  momentThreshold: [1, 100], drillThreshold: [1, 100],
};

// Explanations and the game summary depend on analysis and colour; clear together.
const clearExplanations = g => { g.explanations = {}; g.gameSummary = null; };

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message });
});

// --- status & settings -------------------------------------------------------
app.get('/api/status', wrap(async (req, res) => {
  const settings = await getSettings();
  const enginePath = findStockfish(settings.enginePath);
  const claude = settings.llmProvider === 'claude-cli' ? await checkClaudeCli() : { ok: true, skipped: true };
  res.json({ enginePath, engineOk: !!enginePath, claude, dataDir: DATA_DIR, categories: CATEGORIES, readonly: READONLY });
}));

app.get('/api/settings', wrap(async (req, res) => res.json({ settings: await getSettings(), defaults: DEFAULT_SETTINGS })));

// Probe every configured remote engine host over ssh (parallel, ~5s timeout
// each) and keep the successful connections warm for the next analysis job.
// vpnHint flags the everything-unreachable case, which usually means the VPN
// is down rather than every machine being off.
app.post('/api/engine/hosts/test', wrap(async (req, res) => {
  const settings = await getSettings();
  if (!remoteHostList(settings).length) return res.status(400).json({ error: 'no remote hosts configured' });
  res.json(await probeHosts(settings));
}));

/** Re-derive critical moments from stored analysis after a threshold change:
 * no engine, no LLM. Explanations are keyed by ply and kept even for plies
 * that stop being moments (harmless, and they come straight back if the
 * threshold is lowered again). Status drops to 'analysed' when a new moment
 * has no explanation yet, so the explain flow picks it up. */
async function resummarizeGames(settings) {
  let changed = 0;
  for (const entry of await listGames()) {
    if (entry.status !== 'analysed' && entry.status !== 'explained') continue;
    const g = await getGame(entry.id);
    if (!g?.analysis || !g.playerColor) continue;
    const before = g.analysis.summary.moments.join(',');
    const summary = { ...g.analysis.summary, ...summarize(g.analysis.moves, g.playerColor, settings.momentThreshold) };
    if (summary.moments.join(',') === before) continue;
    g.analysis.summary = summary;
    g.status = summary.moments.every(p => g.explanations?.[p]) ? 'explained' : 'analysed';
    await saveGame(g);
    changed++;
  }
  return changed;
}

app.put('/api/settings', wrap(async (req, res) => {
  const allowed = Object.keys(DEFAULT_SETTINGS);
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if (patch.playerNames && typeof patch.playerNames === 'string') patch.playerNames = patch.playerNames.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
  if (patch.remoteHosts !== undefined && typeof patch.remoteHosts === 'string') patch.remoteHosts = patch.remoteHosts.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  for (const [k, [min, max]] of Object.entries(NUMERIC_LIMITS)) {
    if (!(k in patch)) continue;
    const n = Number(patch[k]);
    if (patch[k] === '' || !Number.isFinite(n)) return res.status(400).json({ error: `${k} must be a number` });
    patch[k] = Math.min(max, Math.max(min, n));
  }
  const before = await getSettings();
  const settings = await saveSettings(patch);
  // Tuning a threshold must not require re-analysis (that would also wipe and
  // re-buy every explanation): moments and drill tiers re-derive from stored
  // moves. New unexplained moments surface via "Analyse and explain everything
  // pending" or the next startup resume.
  let recomputed = 0;
  if (settings.momentThreshold !== before.momentThreshold) recomputed = await resummarizeGames(settings);
  if (recomputed || settings.drillThreshold !== before.drillThreshold) await syncAllDrills();
  res.json({ settings, recomputed });
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
  // Explanation feedback lives in the per-machine drill store; hand this game's
  // slice to the view so the thumbs reflect earlier votes.
  const all = (await getDrills()).feedback;
  const feedback = {};
  for (const ply of game.analysis?.summary?.moments || []) {
    if (all[`${game.id}:${ply}`]) feedback[ply] = all[`${game.id}:${ply}`];
  }
  res.json({ game, feedback });
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
    clearExplanations(game);
    game.status = 'analysed';
    await removeDrillsForGame(game.id);
    await syncDrillsForGame(game, settings);
  }
  await saveGame(game);
  if (req.body?.analyse && !game.analysis) enqueue('analyse', game.id);
  res.json({ game });
}));

// Fix wrong or inconsistent player names (PGN headers vary in spelling); the
// game id stays as imported, so re-importing the same PGN is still a no-op.
app.post('/api/games/:id/names', wrap(async (req, res) => {
  const game = await getGame(req.params.id);
  if (!game) return res.status(404).json({ error: 'not found' });
  const white = String(req.body?.white ?? '').trim();
  const black = String(req.body?.black ?? '').trim();
  if (!white || !black) return res.status(400).json({ error: 'both names are required' });
  game.headers.White = white;
  game.headers.Black = black;
  if (game.purpose === 'scout' && 'subject' in (req.body || {})) {
    const subject = String(req.body.subject || '').trim();
    if (!subject) return res.status(400).json({ error: 'scout games need a subject' });
    game.subject = subject;
  }
  await saveGame(game);
  if (game.analysis) await syncDrillsForGame(game, await getSettings()); // refresh drill labels
  res.json({ game });
}));

app.post('/api/games/:id/analyse', wrap(async (req, res) => {
  const game = await getGame(req.params.id);
  if (!game) return res.status(404).json({ error: 'not found' });
  if (!game.playerColor) return res.status(400).json({ error: 'set the player colour first' });
  if (req.body?.force) {
    cancelJobs(game.id); // a live job would restore the wiped analysis and shadow the re-run
    game.analysis = null; clearExplanations(game); game.status = 'imported'; await saveGame(game);
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
  const settings = await getSettings();
  const queued = [];
  for (const g of games) {
    if (!g.playerColor) continue;
    if (g.status === 'imported' || g.status === 'analysing') queued.push(enqueue('analyse', g.id).id);
    // In manual mode an explain job can only fail; do not queue guaranteed failures.
    else if (g.status === 'analysed' && req.body?.explain !== false && settings.llmProvider !== 'manual') queued.push(enqueue('explain', g.id).id);
  }
  res.json({ queued });
}));

// Manual LLM flow: get the prompt, post the answer.
app.get('/api/games/:id/moments/:ply/prompt', wrap(async (req, res) => {
  const game = await getGame(req.params.id);
  const ply = Number(req.params.ply);
  if (!game?.analysis || !game.analysis.moves[ply - 1]) return res.status(404).json({ error: 'not found' });
  const settings = await getSettings();
  const scout = (game.purpose || 'own') === 'scout';
  res.json(scout
    ? { system: scoutSystemPrompt(settings.playerRating), prompt: scoutMomentPrompt(game, ply), schema: SCOUT_EXPLANATION_SCHEMA }
    : { system: systemPrompt(settings.playerRating), prompt: momentPrompt(game, ply), schema: EXPLANATION_SCHEMA });
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
// The guess and the stored best move are searched together (searchmoves, same
// depth, one search) so the verdict compares like with like; a shallow eval of
// the guess is never measured against the stored deep eval of the best move.
// Runs on the sparring process: on the shared engine a drill answer would
// queue behind a background analysis job's current deep search (and then the
// job behind the answer). LimitStrength is forced off because a play-out may
// have left the sparring process capped.
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
  const engine = await getSparringEngine(settings);
  const sign = m.color === 'white' ? 1 : -1;
  let moverCp, bestCp; // both from the mover's perspective
  if (m.bestUci && m.bestUci !== uci) {
    const r = await engine.analyse(m.fenBefore, {
      depth: 12, multipv: 2, movetimeMs: 3000, searchMoves: [m.bestUci, uci],
      options: { UCI_LimitStrength: 'false' },
    });
    const lineFor = u => r.lines.find(l => l.pv[0] === u);
    const guessLine = lineFor(uci), bestLine = lineFor(m.bestUci);
    if (!guessLine || !bestLine) throw new Error('engine did not evaluate both moves');
    moverCp = scoreToCp(guessLine);
    bestCp = scoreToCp(bestLine);
  } else {
    moverCp = bestCp = (m.lines[0]?.cp ?? m.evalBefore) * sign;
  }
  const wpDiff = Math.max(0, winProb(bestCp) - winProb(moverCp));
  res.json({ san: mv.san, cp: moverCp, bestCp, diff: +((bestCp - moverCp) / 100).toFixed(2), wpDiff: +wpDiff.toFixed(1) });
}));

// A "not really" vote should be actionable: re-run the moment with the
// rejected text quoted in the prompt and replace the explanation. The vote is
// cleared so the new text starts unrated; drills re-sync because the category
// (and with it a threat drill) may change. Synchronous like the prep sheet:
// the caller shows "about a minute".
app.post('/api/games/:id/moments/:ply/reexplain', wrap(async (req, res) => {
  const game = await getGame(req.params.id);
  const ply = Number(req.params.ply);
  if (!game?.analysis || !game.analysis.summary.moments.includes(ply)) return res.status(404).json({ error: 'not a moment' });
  const prior = game.explanations?.[ply];
  if (!prior) return res.status(400).json({ error: 'no explanation to redo; run the explain flow first' });
  const settings = await getSettings();
  if (settings.llmProvider === 'manual') return res.status(400).json({ error: 'manual provider: copy the prompt and paste a new explanation instead' });
  const scout = (game.purpose || 'own') === 'scout';
  const known = await knownPatterns(game);
  const args = [game, ply, [...known.patterns], [...known.concepts]];
  const { output, costUsd, model } = await complete(settings, {
    system: scout ? scoutSystemPrompt(settings.playerRating) : systemPrompt(settings.playerRating),
    prompt: (scout ? scoutMomentPrompt(...args) : momentPrompt(...args)) + reExplainSuffix(prior.explanation),
    schema: scout ? SCOUT_EXPLANATION_SCHEMA : EXPLANATION_SCHEMA,
  });
  const fresh = await getGame(game.id);
  if (!fresh) return res.status(404).json({ error: 'game deleted' });
  fresh.explanations = fresh.explanations || {};
  fresh.explanations[ply] = { ...output, model, costUsd, createdAt: new Date().toISOString(), redone: true };
  await saveGame(fresh);
  await clearFeedback(game.id, ply);
  await syncDrillsForGame(fresh, settings);
  res.json({ game: fresh });
}));

// Was the explanation useful? Per-machine, like drill reviews; the report
// aggregates it so prompt wording can be tuned from real use.
app.post('/api/games/:id/moments/:ply/feedback', wrap(async (req, res) => {
  const game = await getGame(req.params.id);
  const ply = Number(req.params.ply);
  if (!game?.explanations?.[ply]) return res.status(404).json({ error: 'no explanation for this moment' });
  await recordFeedback(game.id, ply, !!req.body?.helpful);
  res.json({ ok: true });
}));

// --- play it out: finish a critical position against a limited engine --------
const ELO_LIMITS = [1320, 3190]; // Stockfish UCI_Elo range

app.post('/api/playout/move', wrap(async (req, res) => {
  let chess;
  try { chess = new Chess(String(req.body?.fen || '')); } catch { return res.status(400).json({ error: 'bad fen' }); }
  if (chess.isGameOver()) return res.status(400).json({ error: 'game is over' });
  const elo = Math.min(ELO_LIMITS[1], Math.max(ELO_LIMITS[0], Number(req.body?.elo) || 2000));
  const engine = await getSparringEngine(await getSettings());
  const r = await engine.analyse(chess.fen(), {
    depth: 12, multipv: 1, movetimeMs: 700,
    options: { UCI_LimitStrength: 'true', UCI_Elo: elo },
  });
  if (!r.bestmove) return res.status(400).json({ error: 'no move available' });
  const mv = chess.move({ from: r.bestmove.slice(0, 2), to: r.bestmove.slice(2, 4), promotion: r.bestmove[4] });
  res.json({ uci: r.bestmove, san: mv.san, fen: chess.fen() });
}));

app.post('/api/playout/assess', wrap(async (req, res) => {
  let chess;
  try { chess = new Chess(String(req.body?.fen || '')); } catch { return res.status(400).json({ error: 'bad fen' }); }
  const stmWhite = chess.turn() === 'w';
  if (chess.isCheckmate()) { const cp = stmWhite ? -10000 : 10000; return res.json({ cp, wp: +winProb(cp).toFixed(1), over: 'checkmate' }); }
  if (chess.isGameOver()) return res.json({ cp: 0, wp: 50, over: 'draw' });
  const engine = await getSparringEngine(await getSettings());
  // Full strength for the verdict; the sparring cap only applies while playing.
  const r = await engine.analyse(chess.fen(), {
    depth: 14, multipv: 1, movetimeMs: 3000,
    options: { UCI_LimitStrength: 'false' },
  });
  const cp = scoreToCp(r.lines[0]) * (stmWhite ? 1 : -1); // White perspective
  res.json({ cp, wp: +winProb(cp).toFixed(1), bestUci: r.bestmove });
}));

// --- jobs, report, drills ----------------------------------------------------
app.get('/api/jobs', (req, res) => res.json({ jobs: listJobs() }));
app.get('/api/report', wrap(async (req, res) => res.json({ report: await buildReport() })));

// One-page markdown card: focus areas, synthesized rules, clock line, study list.
app.get('/api/report/card', wrap(async (req, res) => {
  const report = await buildReport();
  if (!report.games) return res.status(400).json({ error: 'no analysed games yet' });
  res.type('text/markdown').send(buildPrepCard(report, await getPatternNotes(), await getSettings()));
}));

app.get('/api/repertoire', wrap(async (req, res) => res.json({ repertoire: await buildRepertoire() })));

// --- scouting ----------------------------------------------------------------
app.get('/api/scout', wrap(async (req, res) => {
  // Subjects = scouted imports plus every opponent from the player's own games.
  const subjects = new Map();
  const add = (name, analysed, kind) => {
    if (!name || name === '?') return;
    const s = subjects.get(name) || { subject: name, games: 0, analysed: 0, scoutGames: 0, ownGames: 0 };
    s.games++;
    if (analysed) s.analysed++;
    s[kind]++;
    subjects.set(name, s);
  };
  for (const g of await listGames()) {
    const analysed = g.status === 'analysed' || g.status === 'explained';
    if (g.purpose === 'scout' && g.subject) add(g.subject, analysed, 'scoutGames');
    else if (g.purpose !== 'scout' && g.playerColor) add(g.playerColor === 'white' ? g.black : g.white, analysed, 'ownGames');
  }
  res.json({ subjects: [...subjects.values()].sort((a, b) => b.games - a.games || a.subject.localeCompare(b.subject)) });
}));

app.get('/api/scout/:subject', wrap(async (req, res) => {
  const subject = req.params.subject;
  const report = await buildReport({ purpose: 'scout', subject });
  if (!report.games) return res.status(404).json({ error: 'no analysed games for this subject' });
  const repertoire = await buildRepertoire({ purpose: 'scout', subject });
  const prepSheet = (await getPrepSheets())[subject] || null;
  res.json({ subject, report, repertoire, prepSheet });
}));

app.post('/api/scout/:subject/prepsheet', wrap(async (req, res) => {
  const subject = req.params.subject;
  const report = await buildReport({ purpose: 'scout', subject });
  if (!report.games) return res.status(404).json({ error: 'no analysed games for this subject' });
  const repertoire = await buildRepertoire({ purpose: 'scout', subject });
  const settings = await getSettings();
  const { output, costUsd, model } = await complete(settings, {
    system: scoutSystemPrompt(settings.playerRating),
    prompt: prepSheetPrompt(subject, report, repertoire),
    schema: PREP_SHEET_SCHEMA,
  });
  const sheets = await getPrepSheets();
  sheets[subject] = { ...output, games: report.games, model, costUsd, createdAt: new Date().toISOString() };
  await savePrepSheets(sheets);
  res.json({ prepSheet: sheets[subject] });
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
app.get('/api/drills', wrap(async (req, res) => res.json(await dueDrills(Number(req.query.limit) || 20, {
  pattern: req.query.pattern || null,
  category: req.query.category || null,
  session: req.query.session === '1', // a real training session (not the badge poll): may mix in decoys
}))));
app.post('/api/drills/restore-suspended', wrap(async (req, res) => res.json({ restored: await restoreSuspended() })));
app.post('/api/drills/:id/review', wrap(async (req, res) => {
  res.json({ drill: await reviewDrill(req.params.id, req.body?.grade || 'good', req.body?.correct, !!req.body?.practice, Number(req.body?.ms)) });
}));
app.post('/api/drills/:id/suspend', wrap(async (req, res) => {
  res.json({ drill: await suspendDrill(req.params.id, req.body?.suspended !== false) });
}));
app.post('/api/drills/:id/undo', wrap(async (req, res) => {
  res.json({ drill: await undoReview(req.params.id) });
}));

app.get(/^\/(?!api|vendor).*/, (req, res) => res.sendFile(path.join(ROOT, 'public/index.html')));

export { app };

// Listen only when run directly; tests import { app } and listen on an ephemeral port.
const PORT = Number(process.env.PORT) || 3210;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(PORT, process.env.HOST || '127.0.0.1', () => {
    console.log(`chess-analyzer running at http://localhost:${PORT}  (data: ${DATA_DIR})`);
    sweepTmpFiles().then(n => { if (n) console.log(`removed ${n} leftover .tmp file${n === 1 ? '' : 's'}`); }).catch(() => {});
    ensureDataIgnores().catch(() => {});
    syncAllDrills().catch(err => console.error(`drill sync failed: ${err.message}`));
    resumeInterrupted().catch(err => console.error(`resume failed: ${err.message}`));
  });
}
