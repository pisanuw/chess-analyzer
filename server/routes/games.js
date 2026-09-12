// Status and settings, the game store (import, colour, names, analysis and
// explanation jobs), the per-moment guess/eval/explanation routes, play-it-out,
// and the job list.
import { Chess } from 'chess.js';
import { parsePgnGames, splitPgn, detectPlayerColor, fideIdFromHeaders } from '../pgn.js';
import { subjectFideId, predictionFor } from '../subjects.js';
import { getSettings, saveSettings, listGames, listAllGames, getGame, saveGame, deleteGame, getDrills, DEFAULT_SETTINGS, DEFAULT_USER, DATA_DIR } from '../store.js';
import { assocsFromHeaders, recordAssociations } from '../players.js';
import { enqueue, listJobs, cancelJobs, knownPatterns, canonicalPattern } from '../jobs.js';
import { findStockfish, getSparringEngine } from '../engine.js';
import { probeHosts, remoteHostList } from '../enginepool.js';
import { checkClaudeCli, completeRetry } from '../llm.js';
import { scoreToCp, winProb, summarize } from '../analyze.js';
import { removeDrillsForGame, syncDrillsForGame, syncAllDrills, recordGuess, recordFeedback, clearFeedback } from '../drills.js';
import { momentPrompt, systemPrompt, scoutMomentPrompt, scoutSystemPrompt, reExplainSuffix, timePressureOf, EXPLANATION_SCHEMA, SCOUT_EXPLANATION_SCHEMA, CATEGORIES } from '../prompts.js';
import { currentUser } from '../auth.js';
import { getUser, listMembers, isVisitor, publicUser } from '../users.js';
import { READONLY, wrap, effectiveUser, requireAdmin, studentRating } from '../http.js';

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

const ELO_LIMITS = [1320, 3190]; // Stockfish UCI_Elo range

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

export function registerGameRoutes(app) {
  // --- status & settings -----------------------------------------------------
  app.get('/api/status', wrap(async (req, res) => {
    const settings = await getSettings();
    const enginePath = findStockfish(settings.enginePath);
    const claude = settings.llmProvider === 'claude-cli' ? await checkClaudeCli() : { ok: true, skipped: true };
    res.json({ enginePath, engineOk: !!enginePath, claude, dataDir: DATA_DIR, categories: CATEGORIES, readonly: READONLY });
  }));

  app.get('/api/settings', wrap(async (req, res) => res.json({ settings: await getSettings(), defaults: DEFAULT_SETTINGS })));

  // The member roster for the frontend (filing an import, the admin's member
  // switcher): public fields plus the PGN-name substrings, never emails.
  app.get('/api/members', wrap(async (req, res) => {
    res.json({ members: (await listMembers()).map(u => ({ ...publicUser(u), playerNames: u.playerNames || [] })) });
  }));

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
    // Every member's ladder re-derives from the re-scored games, not only the
    // primary member's (the startup sync in serve.js loops the same way).
    if (recomputed || settings.drillThreshold !== before.drillThreshold) {
      for (const m of await listMembers()) await syncAllDrills(m.id);
    }
    res.json({ settings, recomputed });
  }));

  // --- games -----------------------------------------------------------------
  app.get('/api/games', wrap(async (req, res) => res.json({ games: await listGames(await effectiveUser(req)) })));

  app.post('/api/games/import', wrap(async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const pgn = typeof req.body === 'string' ? req.body : req.body?.pgn;
    if (!pgn || !pgn.trim()) return res.status(400).json({ error: 'No PGN provided' });
    const purpose = req.body?.purpose === 'scout' ? 'scout' : 'own';
    const subject = String(req.body?.subject || '').trim();
    if (purpose === 'scout' && !subject) return res.status(400).json({ error: 'scouting needs the opponent name (subject)' });
    // Own games are filed under a member (default: the primary member) and that
    // member's own PGN-name substrings decide the colour, so another member's
    // games never need the operator's names to match. The primary member also
    // keeps the global setting's names (a single-user install configures only those).
    const ownerId = String(req.body?.owner || '').trim() || DEFAULT_USER;
    const owner = purpose === 'own' ? await getUser(ownerId) : null;
    if (purpose === 'own' && (!owner || owner.role !== 'member')) return res.status(400).json({ error: `unknown member: ${ownerId}` });
    // Split first (cheap line scan) and bound the count before the expensive
    // synchronous parse, so an oversized paste is rejected without blocking.
    const chunks = splitPgn(pgn);
    if (chunks.length > MAX_IMPORT_GAMES) {
      return res.status(413).json({ error: `too many games in one import (${chunks.length}); split into files of at most ${MAX_IMPORT_GAMES} games` });
    }
    const settings = await getSettings();
    const ownNames = [...(owner?.playerNames || []), ...(ownerId === DEFAULT_USER ? settings.playerNames : [])];
    const parsed = await parsePgnGames(chunks);
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
        playerColor: detectPlayerColor(g.headers, purpose === 'scout' ? [subject] : ownNames),
        purpose, subject: purpose === 'scout' ? subject : null,
        status: 'imported', importedAt: new Date().toISOString(),
      };
      await saveGame(game, ownerId);
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
    // For an own game against a booked opponent: how far the game followed the
    // opening clash the student would have prepared from (cheap: the index is
    // cached, the forest assembles in milliseconds).
    let prediction = null;
    if ((game.purpose || 'own') !== 'scout' && game.playerColor) {
      const oppName = game.playerColor === 'white' ? game.headers.Black : game.headers.White;
      const fideId = fideIdFromHeaders(game.headers, game.playerColor === 'white' ? 'black' : 'white') || (oppName ? await subjectFideId(oppName) : null);
      prediction = await predictionFor(game, uid, fideId).catch(() => null);
    }
    res.json({ game, feedback, prediction });
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
      const settings = await getSettings();
      game.analysis.moves.forEach(m => { m.isPlayer = m.color === color; });
      game.analysis.summary = { ...game.analysis.summary, ...summarize(game.analysis.moves, color, settings.momentThreshold) };
      clearExplanations(game);
      game.status = 'analysed';
      const owner = game.owner || DEFAULT_USER; // the drills belong to the game's owner, not the operator
      await removeDrillsForGame(game.id, owner);
      await syncDrillsForGame(game, settings, owner);
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
    if (game.analysis) await syncDrillsForGame(game, await getSettings(), game.owner || DEFAULT_USER); // refresh the owner's drill labels
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
      ? { system: scoutSystemPrompt(await studentRating(req, settings)), prompt: scoutMomentPrompt(game, ply), schema: SCOUT_EXPLANATION_SCHEMA }
      : { system: systemPrompt(game.playerRating || settings.playerRating), prompt: momentPrompt(game, ply), schema: EXPLANATION_SCHEMA });
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
    // The pattern name is folded onto the library's spelling and time pressure
    // comes from the clock, exactly as the explain job does it.
    const known = await knownPatterns(game);
    game.explanations[ply] = { pattern: canonicalPattern(clip(e.pattern, 120), known.patterns), category: e.category, time_pressure: timePressureOf(game, ply), explanation: clip(e.explanation, 2000), key_question: clip(e.key_question, 500), concept: clip(e.concept || '', 200), model: 'manual', createdAt: new Date().toISOString() };
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
    const game = await getGame(req.params.id, await effectiveUser(req)); // own games stay private; scout games are shared
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
    const { output, costUsd, model } = await completeRetry(settings, {
      system: scout ? scoutSystemPrompt(await studentRating(req, settings)) : systemPrompt(game.playerRating || settings.playerRating),
      prompt: (scout ? scoutMomentPrompt(...args) : momentPrompt(...args)) + reExplainSuffix(prior.explanation),
      schema: scout ? SCOUT_EXPLANATION_SCHEMA : EXPLANATION_SCHEMA,
    });
    const fresh = await getGame(game.id);
    if (!fresh) return res.status(404).json({ error: 'game deleted' });
    fresh.explanations = fresh.explanations || {};
    fresh.explanations[ply] = { ...output, pattern: canonicalPattern(output.pattern, known.patterns), time_pressure: timePressureOf(fresh, ply), model, costUsd, createdAt: new Date().toISOString(), redone: true };
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

  // --- play it out: finish a critical position against a limited engine ------
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

  app.get('/api/jobs', (req, res) => res.json({ jobs: listJobs() }));
}
