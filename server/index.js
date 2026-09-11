// Express server: static frontend + JSON API. Runs locally; nothing leaves the machine except claude CLI calls.
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { Chess } from 'chess.js';
import { parsePgnGames, parseGame, splitPgn, detectPlayerColor } from './pgn.js';
import { getSettings, saveSettings, listGames, listAllGames, getGame, saveGame, deleteGame, getDrills, getPatternNotes, savePatternNotes, getPrepSheets, savePrepSheets, getScoutBook, saveScoutBook, listScoutBooks, getPlayers, getClashStore, getClashNotes, saveClashNotes, DEFAULT_SETTINGS, DEFAULT_USER, DATA_DIR } from './store.js';
import { parseFideFromFilename, buildScoutBook, scoutDossier } from './scoutbook.js';
import { loadKaiGames, buildKaiIndex, assembleClashForest, extendClashLeaves, clashPrincipalLines } from './clash.js';
import { assocsFromHeaders, recordAssociations, lookupFideId } from './players.js';
import { searchFide, fideProfileName } from './fide.js';
import { enqueue, listJobs, cancelJobs } from './jobs.js';
import { findStockfish, getSparringEngine } from './engine.js';
import { probeHosts, remoteHostList, getEnginePool } from './enginepool.js';
import { checkClaudeCli, complete } from './llm.js';
import { buildReport, buildPrepCard } from './report.js';
import { buildRepertoire } from './repertoire.js';
import { scoreToCp, winProb, summarize } from './analyze.js';
import { dueDrills, visitorDrills, reviewDrill, undoReview, suspendDrill, restoreSuspended, removeDrillsForGame, syncDrillsForGame, syncAllDrills, recordGuess, recordFeedback, clearFeedback, recordDecoy } from './drills.js';
import { buildPuzzles } from './puzzles.js';
import { momentPrompt, systemPrompt, scoutMomentPrompt, scoutSystemPrompt, prepSheetPrompt, prepSheetVersion, clashLinePrompt, clashNarrationVersion, patternSynthesisPrompt, reExplainSuffix, EXPLANATION_SCHEMA, SCOUT_EXPLANATION_SCHEMA, PREP_SHEET_SCHEMA, CLASH_NARRATION_SCHEMA, PATTERN_SYNTH_SCHEMA, CATEGORIES } from './prompts.js';
import { knownPatterns } from './jobs.js';
import { authMiddleware, loginRoute, meRoute, logoutRoute, currentUser } from './auth.js';
import { getUser, listMembers, isVisitor } from './users.js';
import { googleStartRoute, googleCallbackRoute } from './googleauth.js';
import { magicRequestRoute, magicVerifyRoute } from './magiclink.js';

// Repo root = the working directory for every supported entry (npm start via
// server/serve.js, tests, and the bundled Netlify function). Using cwd keeps
// this file free of import.meta, which the CJS function bundle leaves empty and
// warns about. On the hosted mirror ROOT is unused: the CDN serves the static
// assets and DATA_DIR comes from the environment.
const ROOT = process.cwd();
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.text({ limit: '20mb', type: ['application/x-chess-pgn', 'text/plain'] }));

app.use(authMiddleware);
app.post('/api/login', (req, res) => loginRoute(req, res).catch(err => {
  console.error(err);
  res.status(500).json({ error: err.message });
}));
// Identity endpoints (exempt from the auth gate and the read-only gate below, so
// the frontend can ask who it is and log out even on the mirror).
app.get('/api/auth/me', (req, res) => meRoute(req, res).catch(err => {
  console.error(err);
  res.status(500).json({ error: err.message });
}));
app.post('/api/auth/logout', (req, res) => logoutRoute(req, res));
// Google sign-in (OAuth2 code flow). Both are exempt from the auth gate above.
app.get('/api/auth/google', (req, res) => { try { googleStartRoute(req, res); } catch (err) { console.error(err); res.status(500).send('sign-in failed'); } });
app.get('/api/auth/google/callback', (req, res) => googleCallbackRoute(req, res).catch(err => {
  console.error(err);
  res.status(500).send('sign-in failed');
}));
// Magic-link sign-in (request emails a one-time link; verify sets the session).
app.post('/api/auth/magic/request', (req, res) => magicRequestRoute(req, res).catch(err => {
  console.error(err);
  res.status(500).json({ error: 'could not send link' });
}));
app.get('/api/auth/magic/verify', (req, res) => magicVerifyRoute(req, res).catch(err => {
  console.error(err);
  res.status(500).send('sign-in failed');
}));

// Read-only mirror (hosted copy): game data is managed on the analysing machine
// and published; only training state (drill reviews, guesses) is writable.
const READONLY = !!process.env.READONLY_DATA;
const RO_ALLOW = [/^\/api\/login$/, /^\/api\/drills\/decoy$/, /^\/api\/drills\/restore-suspended$/, /^\/api\/drills\/[^/]+\/(review|suspend|undo)$/, /^\/api\/games\/[a-f0-9]{12}\/moments\/\d+\/(guess|eval|feedback)$/];
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
  scoutMaxAgeYears: [1, 20], scoutEloBand: [50, 1000], scoutHalfLifeDays: [30, 3650], scoutAnalyseCount: [1, 100],
};

// Explanations and the game summary depend on analysis and colour; clear together.
const clearExplanations = g => { g.explanations = {}; g.gameSummary = null; };

// One import parses (synchronously, blocking the event loop) and enqueues one
// analyse job per game. The 20mb body cap alone allows thousands of games, so a
// single large paste could freeze the server and flood the sequential queue.
// Reject anything past a sane season-sized bound.
const MAX_IMPORT_GAMES = 500;

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message });
});

// The member whose private data a request acts on (report, repertoire, games,
// drills, puzzles, pattern notes). A member is locked to themselves; an admin
// (or the local operator, when auth is off) may target any member via ?user=,
// defaulting to the primary member. Scout data is shared, so it ignores this.
async function effectiveUser(req) {
  const u = await currentUser(req);
  if (u && u.role !== 'admin') return u.id;
  const q = typeof req.query.user === 'string' ? req.query.user : '';
  return q && (await getUser(q)) ? q : DEFAULT_USER;
}

// Gate for management routes (import, analysis, settings, users, scouting
// imports): only an admin or the local operator may pass.
async function requireAdmin(req, res) {
  const u = await currentUser(req);
  if (u && u.role === 'admin') return true;
  res.status(403).json({ error: 'admin only' });
  return false;
}

// Visitors (allowlisted guests) can browse the shared scouting library and
// practice drills/puzzles, but see no report or repertoire and record nothing.
// Returns true (and sends 403) when the caller is a visitor.
async function blockVisitor(req, res) {
  if (isVisitor(await currentUser(req))) { res.status(403).json({ error: 'not available to visitors' }); return true; }
  return false;
}

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
  if (!(await requireAdmin(req, res))) return;
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
  for (const entry of await listAllGames()) { // admin threshold change re-scores every member's games
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
  if (!(await requireAdmin(req, res))) return;
  const allowed = Object.keys(DEFAULT_SETTINGS);
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if (patch.playerNames && typeof patch.playerNames === 'string') patch.playerNames = patch.playerNames.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
  if (patch.remoteHosts !== undefined && typeof patch.remoteHosts === 'string') patch.remoteHosts = patch.remoteHosts.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  // Cap array sizes and element lengths: these get embedded in prompts and ssh
  // argv, and are read-modify-written whole, so an accidental (or hostile) huge
  // list should not bloat every file and prompt.
  if (Array.isArray(patch.playerNames)) patch.playerNames = patch.playerNames.slice(0, 20).map(s => String(s).slice(0, 80));
  if (Array.isArray(patch.remoteHosts)) patch.remoteHosts = patch.remoteHosts.slice(0, 50).map(s => String(s).slice(0, 255));
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
app.get('/api/games', wrap(async (req, res) => res.json({ games: await listGames(await effectiveUser(req)) })));

app.post('/api/games/import', wrap(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const pgn = typeof req.body === 'string' ? req.body : req.body?.pgn;
  if (!pgn || !pgn.trim()) return res.status(400).json({ error: 'No PGN provided' });
  const purpose = req.body?.purpose === 'scout' ? 'scout' : 'own';
  const subject = String(req.body?.subject || '').trim();
  if (purpose === 'scout' && !subject) return res.status(400).json({ error: 'scouting needs the opponent name (subject)' });
  // Split first (cheap line scan) and bound the count before the expensive
  // synchronous parse, so an oversized paste is rejected without blocking.
  const chunks = splitPgn(pgn);
  if (chunks.length > MAX_IMPORT_GAMES) {
    return res.status(413).json({ error: `too many games in one import (${chunks.length}); split into files of at most ${MAX_IMPORT_GAMES} games` });
  }
  const settings = await getSettings();
  const parsed = parsePgnGames(chunks);
  const imported = [], skipped = [], failed = [], assocs = [];
  for (const r of parsed) {
    if (!r.ok) { failed.push({ error: r.error, snippet: r.snippet }); continue; }
    const g = r.game;
    if (!g.moves.length) { failed.push({ error: 'no moves', snippet: g.pgn.slice(0, 120) }); continue; }
    assocs.push(...assocsFromHeaders(g.headers)); // learn FIDE ids from tags, even for duplicates
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
  await recordAssociations(assocs).catch(() => {}); // best effort: never fail an import on the players map
  res.json({ imported, skipped, failed });
}));

app.get('/api/games/:id', wrap(async (req, res) => {
  const uid = await effectiveUser(req);
  const game = await getGame(req.params.id, uid); // members see only their own games (scout games are shared)
  if (!game) return res.status(404).json({ error: 'not found' });
  // Explanation feedback lives in the per-machine drill store; hand this game's
  // slice to the view so the thumbs reflect earlier votes.
  const all = (await getDrills(uid)).feedback;
  const feedback = {};
  for (const ply of game.analysis?.summary?.moments || []) {
    if (all[`${game.id}:${ply}`]) feedback[ply] = all[`${game.id}:${ply}`];
  }
  res.json({ game, feedback });
}));

app.delete('/api/games/:id', wrap(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  cancelJobs(req.params.id);
  await deleteGame(req.params.id);
  await removeDrillsForGame(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/games/:id/player', wrap(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
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
  if (!(await requireAdmin(req, res))) return;
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
  if (!(await requireAdmin(req, res))) return;
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
  if (!(await requireAdmin(req, res))) return;
  const game = await getGame(req.params.id);
  if (!game?.analysis) return res.status(400).json({ error: 'analyse the game first' });
  res.json({ job: enqueue('explain', game.id) });
}));

app.post('/api/games/analyse-all', wrap(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const games = await listAllGames(); // admin bulk action across every member's games
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
  if (!(await requireAdmin(req, res))) return;
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
  if (!(await requireAdmin(req, res))) return;
  const game = await getGame(req.params.id);
  const ply = Number(req.params.ply);
  if (!game?.analysis || !game.analysis.moves[ply - 1]) return res.status(404).json({ error: 'not found' });
  const e = req.body || {};
  for (const k of ['pattern', 'category', 'explanation', 'key_question']) if (typeof e[k] !== 'string') return res.status(400).json({ error: `missing ${k}` });
  if (!CATEGORIES.includes(e.category)) return res.status(400).json({ error: 'unknown category' });
  // Clamp lengths: this text is stored and later re-embedded into prompts, and
  // the body limit alone would allow a multi-megabyte paste.
  const clip = (s, n) => String(s).slice(0, n);
  game.explanations = game.explanations || {};
  game.explanations[ply] = { pattern: clip(e.pattern, 120), category: e.category, time_pressure: !!e.time_pressure, explanation: clip(e.explanation, 2000), key_question: clip(e.key_question, 500), concept: clip(e.concept || '', 200), model: 'manual', createdAt: new Date().toISOString() };
  if (game.analysis.summary.moments.every(p => game.explanations[p])) game.status = 'explained';
  await saveGame(game);
  res.json({ game });
}));

// Guess-first attempts: recorded per machine (drill store), seeds and boosts drills.
app.post('/api/games/:id/moments/:ply/guess', wrap(async (req, res) => {
  if (isVisitor(await currentUser(req))) return res.json({ ok: true, ephemeral: true }); // visitors record nothing
  const uid = await effectiveUser(req);
  const game = await getGame(req.params.id, uid);
  const ply = Number(req.params.ply);
  if (!game?.analysis || !game.analysis.summary.moments.includes(ply)) return res.status(404).json({ error: 'not a moment' });
  const settings = await getSettings();
  const result = await recordGuess(game, ply, String(req.body?.uci || ''), !!req.body?.correct, settings, uid);
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
  if (!(await requireAdmin(req, res))) return;
  const uid = await effectiveUser(req);
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
  await clearFeedback(game.id, ply, uid);
  await syncDrillsForGame(fresh, settings, uid);
  res.json({ game: fresh });
}));

// Was the explanation useful? Per-machine, like drill reviews; the report
// aggregates it so prompt wording can be tuned from real use.
app.post('/api/games/:id/moments/:ply/feedback', wrap(async (req, res) => {
  if (isVisitor(await currentUser(req))) return res.json({ ok: true, ephemeral: true }); // visitors record nothing
  const uid = await effectiveUser(req);
  const game = await getGame(req.params.id, uid);
  const ply = Number(req.params.ply);
  if (!game?.explanations?.[ply]) return res.status(404).json({ error: 'no explanation for this moment' });
  await recordFeedback(game.id, ply, !!req.body?.helpful, uid);
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
app.get('/api/report', wrap(async (req, res) => {
  if (await blockVisitor(req, res)) return;
  res.json({ report: await buildReport({ userId: await effectiveUser(req) }) });
}));

// One-page markdown card: focus areas, synthesized rules, clock line, study list.
app.get('/api/report/card', wrap(async (req, res) => {
  if (await blockVisitor(req, res)) return;
  const uid = await effectiveUser(req);
  const report = await buildReport({ userId: uid });
  if (!report.games) return res.status(400).json({ error: 'no analysed games yet' });
  res.type('text/markdown').send(buildPrepCard(report, await getPatternNotes(uid), await getSettings()));
}));

app.get('/api/repertoire', wrap(async (req, res) => {
  if (await blockVisitor(req, res)) return;
  res.json({ repertoire: await buildRepertoire({ userId: await effectiveUser(req) }) });
}));

// --- scouting ----------------------------------------------------------------
const SCOUT_MAX_GAMES = 2000; // book tier: no per-game jobs, but bound the one-shot parse

// Recency/rating knobs that bound which of an opponent's games still describe
// the player you will face. Shared by the dossier view and promotion.
const dossierOpts = settings => ({
  maxAgeYears: settings.scoutMaxAgeYears, eloBand: settings.scoutEloBand,
  halfLifeDays: settings.scoutHalfLifeDays, analyseCount: settings.scoutAnalyseCount,
});

app.get('/api/scout', wrap(async (req, res) => {
  // Subjects = FIDE book imports, scouted single games, and every opponent from
  // the player's own games. Each is keyed by FIDE id when one is known (from a
  // PGN tag, a book, or the players map), so a book and the own-game opponent it
  // describes merge into one entry even when the engine data came in by name.
  const players = await getPlayers();
  const books = await listScoutBooks();
  const sheets = await getPrepSheets(); // keyed by subject name: lets the UI colour prep readiness
  const norm = s => (s || '').trim().toLowerCase();
  const bookIdByName = new Map(books.map(b => [norm(b.name), b.fideId]));
  const resolve = (name, tagId) => tagId || bookIdByName.get(norm(name)) || lookupFideId(players, name);

  const byKey = new Map();
  const ensure = (name, fideId) => {
    const key = fideId || 'n:' + norm(name);
    let s = byKey.get(key);
    if (!s) { s = { subject: name, fideId: fideId || null, names: new Set(), games: 0, analysed: 0, scoutGames: 0, ownGames: 0, bookGames: 0 }; byKey.set(key, s); }
    s.names.add(name);
    return s;
  };
  const add = (name, analysed, kind, tagId) => {
    if (!name || name === '?') return;
    const s = ensure(name, resolve(name, tagId));
    s.games++;
    if (analysed) s.analysed++;
    s[kind]++;
  };
  const ownerCount = new Map(); // member id -> own-game counts, for their own prep-subject entry
  for (const g of await listAllGames()) { // scouting library is shared: draw opponents from every member's games
    const analysed = g.status === 'analysed' || g.status === 'explained';
    if (g.purpose === 'scout' && g.subject) add(g.subject, analysed, 'scoutGames', g.subjectId);
    else if (g.purpose !== 'scout' && g.playerColor) {
      const oppName = g.playerColor === 'white' ? g.black : g.white;
      add(oppName, analysed, 'ownGames', g.playerColor === 'white' ? g.blackFideId : g.whiteFideId);
      if (g.owner) { const o = ownerCount.get(g.owner) || { games: 0, analysed: 0 }; o.games++; if (analysed) o.analysed++; ownerCount.set(g.owner, o); }
    }
  }
  for (const b of books) {
    const s = ensure(b.name, b.fideId);
    s.subject = b.name; // the book name is the canonical display name
    s.bookGames = b.total || (b.games || []).length;
  }
  // Members are prep subjects too (shared library): everyone can prep against
  // them. Keyed by FIDE id, so a member who also has a book merges into it; a
  // member with no book (e.g. Kai) is scouted from their own games.
  for (const m of await listMembers()) {
    const s = ensure(m.displayName, m.fideId);
    s.member = true;
    const o = ownerCount.get(m.id) || { games: 0, analysed: 0 };
    s.selfGames = o.games;
    s.games = Math.max(s.games, o.games);
    s.analysed = Math.max(s.analysed, o.analysed);
  }
  const subjects = [...byKey.values()].map(s => ({
    ...s, names: undefined, aliases: [...s.names].filter(n => n !== s.subject),
    // Prep-sheet readiness for the UI: the sheet plus the analysed-game count it
    // was built from, so the client can tell fresh (green) from missing/stale (yellow).
    prep: sheets[s.subject] ? { games: sheets[s.subject].games ?? 0, createdAt: sheets[s.subject].createdAt || '' } : null,
  }));
  res.json({ subjects: subjects.sort((a, b) => (b.bookGames + b.games) - (a.bookGames + a.games) || a.subject.localeCompare(b.subject)) });
}));

// The learned name <-> FIDE id map. Read-only; associations are learned at
// import from PGN tags and book imports, and by the opt-in FIDE lookup below.
app.get('/api/players', wrap(async (req, res) => {
  const map = await getPlayers();
  const players = Object.values(map).sort((a, b) => (a.names[0] || '').localeCompare(b.names[0] || ''));
  res.json({ players });
}));

// Opt-in FIDE lookup: an explicit user action searches the official rating site
// by name and returns candidates to confirm. This is the only third-party call
// besides the claude CLI, and it never runs automatically.
app.get('/api/fide/search', wrap(async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'enter at least two characters to search FIDE' });
  res.json(await searchFide(name));
}));

// Confirm a match: record the chosen id against the local name (and the FIDE
// canonical name) so it resolves everywhere afterward. Optionally verify the id
// against its FIDE profile first.
app.post('/api/players/link', wrap(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const fideId = String(req.body?.fideId || '').trim();
  if (!/^\d{3,}$/.test(fideId)) return res.status(400).json({ error: 'a numeric FIDE id is required' });
  const names = [req.body?.name, req.body?.fideName].filter(n => typeof n === 'string' && n.trim());
  if (!names.length) return res.status(400).json({ error: 'a name to link is required' });
  if (req.body?.verify) {
    const canonical = await fideProfileName(fideId);
    if (!canonical) return res.status(404).json({ error: `no FIDE profile for id ${fideId}` });
    if (!names.some(n => n.trim().toLowerCase() === canonical.toLowerCase())) names.push(canonical);
  }
  const federation = typeof req.body?.federation === 'string' ? req.body.federation : undefined;
  await recordAssociations(names.map(n => ({ fideId, name: n.trim(), federation })));
  res.json({ player: (await getPlayers())[fideId] });
}));

// Ingest a large per-opponent export into the book tier: parse every game,
// derive the recency/rating-weighted dossier, store one compact file. No engine
// and no LLM here; this is instant and covers the opponent's whole history.
app.post('/api/scout/import', wrap(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const pgn = typeof req.body === 'string' ? req.body : req.body?.pgn;
  if (!pgn || !pgn.trim()) return res.status(400).json({ error: 'No PGN provided' });
  // FIDE id from the body, or parsed from the uploaded filename the client sends.
  const fideId = String(req.body?.fideId || parseFideFromFilename(req.body?.filename) || '').trim();
  if (!/^\d{3,}$/.test(fideId)) return res.status(400).json({ error: 'a numeric FIDE id is required (from the filename, e.g. _FIDE30958130_)' });
  const chunks = splitPgn(pgn);
  if (chunks.length > SCOUT_MAX_GAMES) return res.status(413).json({ error: `too many games in one file (${chunks.length}); the book tier caps at ${SCOUT_MAX_GAMES}` });
  const parsed = parsePgnGames(chunks);
  const ok = parsed.filter(r => r.ok && r.game.moves.length).map(r => r.game);
  const failed = parsed.length - ok.length;
  // Subject name: explicit, else the player present in the most games (a clean
  // per-player export has exactly one).
  let name = String(req.body?.name || '').trim();
  if (!name) {
    const counts = new Map();
    for (const g of ok) for (const n of [g.headers.White, g.headers.Black]) if (n) counts.set(n, (counts.get(n) || 0) + 1);
    name = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  }
  if (!name) return res.status(400).json({ error: 'could not determine the opponent name; pass name explicitly' });
  const aliases = Array.isArray(req.body?.aliases) ? req.body.aliases.slice(0, 10).map(s => String(s).slice(0, 80)) : [];
  const book = buildScoutBook(ok, { fideId, name, aliases });
  if (!book.total) return res.status(400).json({ error: `no games for "${name}" found in the file (check the name matches the PGN headers)` });
  await saveScoutBook(book);
  // The filename FIDE id names the subject; also learn any ids the games' tags carry.
  await recordAssociations([{ fideId, name }, ...ok.flatMap(g => assocsFromHeaders(g.headers))]).catch(() => {});
  const dossier = scoutDossier(book, dossierOpts(await getSettings()));
  // Chess960 ("Freestyle") games and odd PGNs are the usual skips; surface the count.
  res.json({ fideId, name, imported: book.total, skipped: failed, dossier });
}));

app.get('/api/scout/book/:fideId', wrap(async (req, res) => {
  const book = await getScoutBook(req.params.fideId);
  if (!book) return res.status(404).json({ error: 'no scout book for this FIDE id' });
  const dossier = scoutDossier(book, dossierOpts(await getSettings()));
  res.json({ fideId: book.fideId, name: book.name, importedAt: book.importedAt, dossier, promote: await promoteStatus(book, dossier) });
}));

// How much of the recent, on-strength analysis subset is already in the pipeline,
// so the UI can hide a promote that would queue nothing. A game is "queueable"
// only if it has PGN and no record yet; games already imported (whatever their
// status) or lacking PGN cannot be newly queued.
async function promoteStatus(book, dossier) {
  const status = new Map((await listAllGames()).map(g => [g.id, g.status]));
  const byId = new Map(book.games.map(g => [g.id, g]));
  let present = 0, analysed = 0, queueable = 0;
  for (const id of dossier.analysisSet) {
    const st = status.get(id);
    if (st) { present++; if (st === 'analysed') analysed++; }
    else if (byId.get(id)?.pgn) queueable++;
  }
  return { total: dossier.analysisSet.length, present, analysed, queueable };
}

// Promote the recent, on-strength subset into the engine/LLM dossier: create
// scout game records (matched to the existing name-keyed scout machinery) and
// queue analysis. This is the only step that needs Stockfish.
app.post('/api/scout/book/:fideId/promote', wrap(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const book = await getScoutBook(req.params.fideId);
  if (!book) return res.status(404).json({ error: 'no scout book for this FIDE id' });
  const settings = await getSettings();
  const dossier = scoutDossier(book, dossierOpts(settings));
  const wanted = new Set(dossier.analysisSet);
  const byId = new Map(book.games.map(g => [g.id, g]));
  const queued = [], already = [];
  for (const id of wanted) {
    const bg = byId.get(id);
    if (!bg?.pgn) continue;
    if (await getGame(id)) { already.push(id); continue; }
    const g = parseGame(bg.pgn);
    const game = {
      id: g.id, headers: g.headers, moves: g.moves, pgn: g.pgn,
      playerColor: detectPlayerColor(g.headers, [book.name, ...(book.aliases || [])]) || bg.color,
      purpose: 'scout', subject: book.name, subjectId: book.fideId,
      status: 'imported', importedAt: new Date().toISOString(),
    };
    await saveGame(game);
    if (game.playerColor) { enqueue('analyse', game.id); queued.push(game.id); }
  }
  res.json({ subject: book.name, fideId: book.fideId, queued: queued.length, already: already.length, analysisSet: dossier.analysisSet.length });
}));

// Seed a member's OWN games from their scout book: import the recent, on-strength
// subset (the same set promote uses) as purpose='own' owned by the member, so the
// member gets a private report, repertoire, drills, and puzzles from their own
// play. The id is namespaced by member, so a game the shared scouting library
// already holds as a scout copy is never overwritten (both coexist). Needs
// Stockfish, like promote; body { analyse: false } seeds the records without
// queueing analysis (a dry run, and how the tests exercise it).
const seededOwnGameId = (memberId, gameId) => crypto.createHash('sha1').update(`${memberId}:${gameId}`).digest('hex').slice(0, 12);

app.post('/api/users/:id/seed', wrap(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const member = await getUser(req.params.id);
  if (!member || member.role !== 'member') return res.status(404).json({ error: 'unknown member' });
  if (!member.fideId) return res.status(400).json({ error: `${member.id} has no FIDE id to seed from` });
  const book = await getScoutBook(member.fideId);
  if (!book) return res.status(404).json({ error: `no scout book for ${member.displayName} (FIDE ${member.fideId}); import it first` });
  const settings = await getSettings();
  const dossier = scoutDossier(book, dossierOpts(settings));
  const byId = new Map(book.games.map(g => [g.id, g]));
  const names = [book.name, ...(book.aliases || []), ...(member.playerNames || [])];
  const seeded = [], queued = [], already = [];
  for (const bookId of dossier.analysisSet) {
    const bg = byId.get(bookId);
    if (!bg?.pgn) continue;
    const g = parseGame(bg.pgn);
    const id = seededOwnGameId(member.id, g.id);
    if (await getGame(id)) { already.push(id); continue; }
    const game = {
      id, headers: g.headers, moves: g.moves, pgn: g.pgn,
      playerColor: detectPlayerColor(g.headers, names) || bg.color,
      purpose: 'own', owner: member.id, seededFrom: { fideId: book.fideId, gameId: g.id },
      status: 'imported', importedAt: new Date().toISOString(),
    };
    await saveGame(game, member.id);
    seeded.push(id);
    if (game.playerColor && req.body?.analyse !== false) { enqueue('analyse', id); queued.push(id); }
  }
  res.json({ member: member.id, fideId: member.fideId, analysisSet: dossier.analysisSet.length, seeded: seeded.length, queued: queued.length, already: already.length });
}));

// Opening clash: the predicted, branching, alternating tree of how this opponent
// would meet the player's own openings. The expensive part (parsing the whole
// book) is cached per FIDE id and rebuilt as a background job when the book has
// changed; the tree itself is assembled cheaply here from that cache plus the
// player's analysed games. GET so the read-only hosted mirror can serve a cached
// forest. Returns { clash } when ready, or { building, job } while the index is
// (re)built.
app.get('/api/scout/book/:fideId/clash', wrap(async (req, res) => {
  const book = await getScoutBook(req.params.fideId);
  if (!book) return res.status(404).json({ error: 'no scout book for this FIDE id' });
  const entry = (await getClashStore())[book.fideId];
  if (!entry || entry.bookImportedAt !== book.importedAt) {
    // The read-only mirror ships a pre-built index and cannot parse or run jobs;
    // if it is missing or stale there, say so rather than trying to build.
    if (READONLY) return res.json({ unavailable: true });
    const job = enqueue('clash', 'clash:' + book.fideId);
    return res.json({ building: true, job: { id: job.id, kind: job.kind, gameId: job.gameId } });
  }
  const kaiGames = await loadKaiGames();
  const kai = buildKaiIndex(kaiGames);
  const clash = assembleClashForest({ oppIndex: entry.index, coverage: entry.coverage, kai, book, params: req.query });
  // Optional, engine-grounded: fill prep-end leaves with Stockfish's best move
  // (candidate moves from the engine, never a model). Cache-first, so the many
  // shared opening positions are near free. Off on the read-only mirror (no engine).
  if (req.query.extend === '1' && !READONLY) {
    const settings = await getSettings();
    const pool = await getEnginePool(settings);
    if (!pool.engines.length) clash.engineWarning = pool.warning || 'No engine available to extend lines.';
    else { if (pool.warning) clash.engineWarning = pool.warning; await extendClashLeaves(clash, entry.index, settings, pool); }
  }
  clash.narration = (await getClashNotes())[book.fideId] || null;
  clash.narrationVersion = clashNarrationVersion();
  res.json({ clash });
}));

// Optional coach narration of the predicted lines: prose only, keyed to line ids
// the server produced. Engine-grounded (the model never picks or evaluates a
// move). Home machine only. Requires the clash index to be built first.
app.post('/api/scout/book/:fideId/clash/narrate', wrap(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (READONLY) return res.status(403).json({ error: 'narration is generated on the home machine' });
  const book = await getScoutBook(req.params.fideId);
  if (!book) return res.status(404).json({ error: 'no scout book for this FIDE id' });
  const entry = (await getClashStore())[book.fideId];
  if (!entry || entry.bookImportedAt !== book.importedAt) return res.status(409).json({ error: 'build the opening clash first' });
  const kai = buildKaiIndex(await loadKaiGames());
  const clash = assembleClashForest({ oppIndex: entry.index, coverage: entry.coverage, kai, book });
  const lines = clashPrincipalLines(clash);
  if (!lines.length) return res.status(400).json({ error: 'no predicted lines to narrate yet' });
  const settings = await getSettings();
  const { output, costUsd, model } = await complete(settings, {
    system: scoutSystemPrompt(settings.playerRating),
    prompt: clashLinePrompt(book.name, lines),
    schema: CLASH_NARRATION_SCHEMA,
  });
  const noteByIdx = new Map((output.notes || []).map(n => [n.index, n.note]));
  const narration = {
    headline: output.headline,
    lines: lines.map(l => ({ color: l.color, sanLine: l.sanLine, endReason: l.endReason, note: noteByIdx.get(l.idx) || '' })),
    version: clashNarrationVersion(), model, costUsd, createdAt: new Date().toISOString(),
  };
  const store = await getClashNotes();
  store[book.fideId] = narration;
  await saveClashNotes(store);
  res.json({ narration });
}));

app.get('/api/scout/:subject', wrap(async (req, res) => {
  const subject = req.params.subject;
  const report = await buildReport({ purpose: 'scout', subject });
  if (!report.games) return res.status(404).json({ error: 'no analysed games for this subject' });
  const repertoire = await buildRepertoire({ purpose: 'scout', subject });
  const prepSheet = (await getPrepSheets())[subject] || null;
  // The current format fingerprint lets the UI offer a regenerate when the sheet
  // style has changed, not only when new games arrive (null on the hosted mirror).
  res.json({ subject, report, repertoire, prepSheet, prepSheetVersion: prepSheetVersion() });
}));

app.post('/api/scout/:subject/prepsheet', wrap(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
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
  sheets[subject] = { ...output, games: report.games, version: prepSheetVersion(), model, costUsd, createdAt: new Date().toISOString() };
  await savePrepSheets(sheets);
  res.json({ prepSheet: sheets[subject] });
}));

// --- pattern study notes -----------------------------------------------------
app.get('/api/patterns', wrap(async (req, res) => {
  if (await blockVisitor(req, res)) return;
  res.json({ notes: await getPatternNotes(await effectiveUser(req)) });
}));
app.post('/api/patterns/synthesize', wrap(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const uid = await effectiveUser(req);
  const name = String(req.body?.pattern || '').trim();
  if (!name) return res.status(400).json({ error: 'pattern required' });
  const settings = await getSettings();
  const report = await buildReport({ userId: uid });
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
  const notes = await getPatternNotes(uid);
  notes[key] = { pattern: pat.pattern, ...output, count: pat.count, model, costUsd, createdAt: new Date().toISOString() };
  await savePatternNotes(notes, uid);
  res.json({ note: notes[key] });
}));
// Free-solve puzzles derived from analysed games (no schedule). GET, so it also
// works on the read-only mirror. source: tactics | moments | missed.
app.get('/api/puzzles', wrap(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  res.json(await buildPuzzles(req.query.source || 'tactics', limit, undefined, await effectiveUser(req)));
}));
app.get('/api/drills', wrap(async (req, res) => {
  // Visitors get an ephemeral scout-derived set; nothing is read from or written to a store.
  if (isVisitor(await currentUser(req))) return res.json(await visitorDrills(Number(req.query.limit) || 20));
  res.json(await dueDrills(Number(req.query.limit) || 20, {
    pattern: req.query.pattern || null,
    category: req.query.category || null,
    session: req.query.session === '1', // a real training session (not the badge poll): may mix in decoys
    userId: await effectiveUser(req),
  }));
}));
// A visitor records nothing: the drill-write routes no-op for them (their
// practice is ephemeral). The frontend also skips these calls for visitors.
const visitorNoop = async (req, res) => { if (isVisitor(await currentUser(req))) { res.json({ ok: true, ephemeral: true }); return true; } return false; };
app.post('/api/drills/restore-suspended', wrap(async (req, res) => { if (await visitorNoop(req, res)) return; res.json({ restored: await restoreSuspended(await effectiveUser(req)) }); }));
app.post('/api/drills/decoy', wrap(async (req, res) => { if (await visitorNoop(req, res)) return; res.json({ decoys: await recordDecoy(!!req.body?.correct, await effectiveUser(req)) }); }));
app.post('/api/drills/:id/review', wrap(async (req, res) => {
  if (await visitorNoop(req, res)) return;
  res.json({ drill: await reviewDrill(req.params.id, req.body?.grade || 'good', req.body?.correct, !!req.body?.practice, Number(req.body?.ms), await effectiveUser(req)) });
}));
app.post('/api/drills/:id/suspend', wrap(async (req, res) => {
  if (await visitorNoop(req, res)) return;
  res.json({ drill: await suspendDrill(req.params.id, req.body?.suspended !== false, await effectiveUser(req)) });
}));
app.post('/api/drills/:id/undo', wrap(async (req, res) => {
  if (await visitorNoop(req, res)) return;
  res.json({ drill: await undoReview(req.params.id, await effectiveUser(req)) });
}));

app.get(/^\/(?!api|vendor).*/, (req, res) => res.sendFile(path.join(ROOT, 'public/index.html')));

// This module only builds the app: tests import { app } and listen on an
// ephemeral port, and the Netlify function wraps it with serverless-http. The
// local server is started by server/serve.js (npm start), which owns the
// listen and the once-at-boot housekeeping.
export { app };
