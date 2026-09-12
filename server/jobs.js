// Sequential job queue: engine analysis, then LLM explanations. Progress is polled by the UI.
import { getEnginePool } from './enginepool.js';
import { analyseGame, summarize } from './analyze.js';
import { getGame, saveGame, getSettings, listAllGames, listScoutBooks, DEFAULT_USER } from './store.js';
import { ensureClashIndex } from './clash.js';
import { LlmError, completeRetry } from './llm.js';
import { flushCache } from './evalcache.js';
import { systemPrompt, momentPrompt, momentsBatchPrompt, gameSummaryPrompt, gameSummarySystemPrompt, scoutSystemPrompt, scoutMomentPrompt, scoutMomentsBatchPrompt, scoutGameSummaryPrompt, batchExplanationSchema, EXPLANATION_SCHEMA, SCOUT_EXPLANATION_SCHEMA, SUMMARY_SCHEMA, CATEGORIES, timePressureOf } from './prompts.js';
import { syncDrillsForGame } from './drills.js';
import { getUser } from './users.js';
import { normalizeKey } from '../public/shared.js';

/** The rating the coach prompts assume for a game's tracked player: the
 * player's own Elo header in that game, then the owner's roster rating, then the
 * global setting. Scout games keep the setting: the student there is whoever
 * reads the shared dossier, not the game's subject. */
export async function playerRatingFor(game, settings) {
  const fallback = settings.playerRating || 2000;
  if ((game.purpose || 'own') === 'scout') return fallback;
  const own = Number(game.headers?.[game.playerColor === 'white' ? 'WhiteElo' : 'BlackElo']);
  if (own >= 400 && own <= 3500) return Math.round(own);
  const owner = await getUser(game.owner || DEFAULT_USER).catch(() => null);
  return owner?.rating || fallback;
}

const jobs = new Map();
let seq = 0;

// Two independent lanes, each its own FIFO with its own runner, so a member's
// own analyse/explain work is never stuck behind another member's (or an
// admin prebuild's) long-running opponent-book parse. 'analyse' and 'explain'
// are the interactive lane: a member is looking at the Games page waiting on
// them. 'clash' (an opponent's whole-book index) is the bulk lane: it can take
// much longer and nobody is watching a spinner for it specifically.
const LANE = { analyse: 'interactive', explain: 'interactive', clash: 'bulk' };
const pending = { interactive: [], bulk: [] };
const running = { interactive: false, bulk: false };

const isActive = j => j.status === 'queued' || j.status === 'running';

export function listJobs() {
  // Cap only finished jobs: active ones must always be visible, or the UI shows
  // a long queue with no running progress bar (the runner is the oldest job).
  const all = [...jobs.values()].sort((a, b) => b.id - a.id);
  return all.filter(isActive).concat(all.filter(j => !isActive(j)).slice(0, 50)).sort((a, b) => b.id - a.id);
}

export function enqueue(kind, gameId) {
  const dup = [...jobs.values()].find(j => j.gameId === gameId && j.kind === kind
    && isActive(j) && !(j.status === 'running' && j.cancelled));
  if (dup) return dup;
  const job = { id: ++seq, kind, gameId, status: 'queued', progress: 0, total: 0, stage: '', error: null, createdAt: new Date().toISOString(), costUsd: 0 };
  jobs.set(job.id, job);
  const lane = LANE[kind];
  pending[lane].push(job);
  pump(lane);
  return job;
}

/** Cancel queued jobs for a game; a running job is flagged and stops at its
 * next checkpoint without writing results. Used by delete and force-reanalyse
 * so a stale in-flight job cannot resurrect or overwrite the game. */
export function cancelJobs(gameId, kind = null) {
  for (const j of jobs.values()) {
    if (j.gameId !== gameId || (kind && j.kind !== kind)) continue;
    if (j.status === 'queued') j.status = 'cancelled';
    else if (j.status === 'running') j.cancelled = true;
  }
}

/** Re-read the game and apply `mutate` to the fresh copy, so a job never saves
 * a whole object it has held across minutes of awaits (that would silently undo
 * concurrent edits, and recreate the file if the game was deleted mid-job). */
async function updateGame(id, mutate) {
  const g = await getGame(id);
  if (!g) throw new Error('game deleted during job');
  mutate(g);
  await saveGame(g);
  return g;
}

/** Re-queue work that was pending when the server last stopped. The queue is
 * in-memory, but game status on disk records how far each game got. */
export async function resumeInterrupted() {
  const settings = await getSettings();
  let analyse = 0, explain = 0;
  for (const g of await listAllGames()) {
    if (!g.playerColor) continue;
    if (g.status === 'imported' || g.status === 'analysing') { enqueue('analyse', g.id); analyse++; }
    else if (g.status === 'analysed' && settings.autoExplain && settings.llmProvider !== 'manual') { enqueue('explain', g.id); explain++; }
  }
  if (analyse || explain) console.log(`resumed unfinished work: ${analyse} to analyse, ${explain} to explain`);
}

async function pump(lane) {
  if (running[lane]) return;
  running[lane] = true;
  const queue = pending[lane];
  while (queue.length) {
    const job = queue.shift();
    if (job.status === 'cancelled') continue;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      if (job.kind === 'analyse') await runAnalyse(job);
      else if (job.kind === 'explain') await runExplain(job);
      else if (job.kind === 'clash') await runClash(job);
      job.status = job.cancelled ? 'cancelled' : 'done';
    } catch (err) {
      if (job.cancelled) {
        job.status = 'cancelled';
      } else {
        job.status = 'failed';
        job.error = err.message;
        console.error(`[job ${job.id} ${job.kind} ${job.gameId}] ${err.message}`);
        try {
          const g = await getGame(job.gameId);
          if (g) { g.lastError = err.message; await saveGame(g); }
        } catch {}
      }
    }
    job.finishedAt = new Date().toISOString();
    // Keep memory bounded on a long-running server: cap finished-job history.
    const finished = [...jobs.values()].filter(j => !isActive(j)).sort((a, b) => a.id - b.id);
    for (const j of finished.slice(0, Math.max(0, finished.length - 200))) jobs.delete(j.id);
  }
  running[lane] = false;
}

async function runAnalyse(job) {
  const settings = await getSettings();
  const game = await getGame(job.gameId);
  if (!game) throw new Error('game not found');
  if (!game.playerColor) throw new Error('player colour not set for this game');
  job.stage = 'engine';
  job.total = game.moves.length + 1;
  job.depthTarget = settings.engineDepth || 18;
  const pool = await getEnginePool(settings);
  job.engines = pool.engines.length; // lets the UI show that work is distributed
  if (pool.warning) { job.warning = pool.warning; console.warn(pool.warning); }
  await updateGame(job.gameId, g => { g.status = 'analysing'; g.lastError = null; });
  const { moves, summary } = await analyseGame(pool, game, settings, (done, total, depth) => {
    job.progress = done; job.total = total;
    if (depth !== undefined) { job.depth = depth; return; } // live update from the engine's stdout handler: must not throw
    job.depth = null;
    if (job.cancelled) throw new Error('cancelled');
  });
  if (job.cancelled) throw new Error('cancelled');
  const rating = await playerRatingFor(game, settings);
  const saved = await updateGame(job.gameId, g => {
    if (g.playerColor !== game.playerColor) {
      // Colour changed while the engine ran; re-derive the colour-dependent bits.
      moves.forEach(m => { m.isPlayer = m.color === g.playerColor; });
      Object.assign(summary, summarize(moves, g.playerColor, settings.momentThreshold));
    }
    g.analysis = { moves, summary, analysedAt: new Date().toISOString() };
    g.playerRating = rating;
    g.explanations = g.explanations || {};
    // A game with no critical moments has nothing to explain, so it is already
    // done: mark it 'explained' rather than leaving it stuck looking pending.
    g.status = summary.moments.length ? 'analysed' : 'explained';
  });
  await syncDrillsForGame(saved, settings, saved.owner || DEFAULT_USER); // drills belong to the game's owner
  await flushCache(); // persist opening evals gathered this job (debounced otherwise)
  if (settings.autoExplain && settings.llmProvider !== 'manual') {
    await runExplain(job);
  }
}

/** Validate one explanation object from a batch reply (the CLI enforces the
 * schema on single calls, but batch entries are matched to plies by hand).
 * Returns the clean entry or null. */
export function sanitizeExplanation(e, known = []) {
  if (!e) return null;
  for (const k of ['pattern', 'category', 'explanation', 'key_question']) if (typeof e[k] !== 'string' || !e[k]) return null;
  if (!CATEGORIES.includes(e.category)) return null;
  // time_pressure is not taken from the reply: the job stamps it from the clock.
  return {
    pattern: canonicalPattern(e.pattern, known), category: e.category,
    explanation: e.explanation, key_question: e.key_question,
    concept: typeof e.concept === 'string' ? e.concept : '',
  };
}

/** Moments per batch call. A whole game in one prompt shares the context, but
 * a game with 15 moments would be one 20-minute call whose failure loses all
 * of it; chunks of this size keep each call bounded and the loss small. */
export const BATCH_MAX = 8;
const chunk = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

async function runExplain(job) {
  const settings = await getSettings();
  const game = await getGame(job.gameId);
  if (!game?.analysis) throw new Error('game is not analysed yet');
  if (settings.llmProvider === 'manual') throw new LlmError('LLM provider is manual; use the prompt copy/paste flow in the game view.');
  job.stage = 'explain';
  const todo = game.analysis.summary.moments.filter(ply => !game.explanations?.[ply]);
  job.total = todo.length + 1;
  job.progress = 0;
  game.explanations = game.explanations || {};
  // Scout games get exploitation-framed prompts; the schema shape is identical.
  const scout = (game.purpose || 'own') === 'scout';
  const rating = game.playerRating || await playerRatingFor(game, settings);
  const system = scout ? scoutSystemPrompt(settings.playerRating) : systemPrompt(rating);
  const schema = scout ? SCOUT_EXPLANATION_SCHEMA : EXPLANATION_SCHEMA;
  const known = await knownPatterns(game);
  let remaining = [...todo];

  // The moments in batches first: they share their context and each per-moment
  // CLI call costs about a minute of wall time. Anything missing or invalid in
  // a reply falls through to the per-moment loop, which is also the retry path
  // when a batch call itself fails. Batches are capped at BATCH_MAX moments so
  // one call stays a few minutes long and a failure loses at most one chunk.
  if (remaining.length >= 2) {
    for (const plies of chunk(remaining, BATCH_MAX)) {
      if (job.cancelled) throw new Error('cancelled');
      job.itemStartedAt = new Date().toISOString();
      try {
        const args = [game, plies, [...known.patterns], [...known.concepts]];
        const prompt = scout ? scoutMomentsBatchPrompt(...args) : momentsBatchPrompt(...args);
        // Prompt size grows with the moments and the pattern library; log it so
        // a runaway game shows up in the server log before it shows up as cost.
        console.log(`[job ${job.id}] batch of ${plies.length} moment${plies.length === 1 ? '' : 's'}: prompt ${prompt.length} chars (about ${Math.round(prompt.length / 4)} tokens)`);
        const { output, costUsd, model } = await completeRetry(settings, {
          system, prompt, schema: batchExplanationSchema(scout),
          timeoutMs: 240000 + 60000 * plies.length,
        });
        const byPly = new Map((output?.explanations || []).map(e => [Number(e?.ply), e]));
        const saved = [];
        for (const ply of plies) {
          const e = sanitizeExplanation(byPly.get(ply), known.patterns);
          if (!e) continue;
          const entry = { ...e, time_pressure: timePressureOf(game, ply), model, costUsd: null, createdAt: new Date().toISOString() };
          game.explanations[ply] = entry; // keep the held copy current for later prompts
          if (entry.pattern) known.patterns.add(entry.pattern);
          if (entry.concept) known.concepts.add(entry.concept);
          saved.push([ply, entry]);
        }
        // Only bill a batch that produced usable explanations; a zero-match reply
        // (all plies mislabelled) is wasted spend, and it silently degraded to a
        // full per-moment re-explain, so make that visible in the log.
        if (saved.length) job.costUsd += costUsd || 0;
        if (saved.length < plies.length) console.warn(`[job ${job.id}] batch matched ${saved.length}/${plies.length} moments${saved.length ? '' : ' (0: not billed)'}; the rest fall back per moment`);
        if (saved.length) {
          await updateGame(job.gameId, g => { g.explanations = g.explanations || {}; for (const [ply, entry] of saved) g.explanations[ply] = entry; });
          job.progress += saved.length;
        }
      } catch (err) {
        if (job.cancelled || !(err instanceof LlmError)) throw err;
        console.error(`[job ${job.id}] batch explanation failed, falling back per moment: ${err.message}`);
      }
    }
    remaining = remaining.filter(ply => !game.explanations[ply]);
  }

  for (const ply of remaining) {
    if (job.cancelled) throw new Error('cancelled');
    job.itemStartedAt = new Date().toISOString(); // lets the UI show elapsed time on the current explanation
    const args = [game, ply, [...known.patterns], [...known.concepts]];
    const { output, costUsd, model } = await completeRetry(settings, { system, prompt: scout ? scoutMomentPrompt(...args) : momentPrompt(...args), schema });
    const entry = { ...output, pattern: canonicalPattern(output.pattern, known.patterns), time_pressure: timePressureOf(game, ply), model, costUsd, createdAt: new Date().toISOString() };
    game.explanations[ply] = entry; // keep the held copy current for later prompts
    await updateGame(job.gameId, g => { g.explanations = g.explanations || {}; g.explanations[ply] = entry; });
    if (output.pattern) known.patterns.add(output.pattern);
    if (output.concept) known.concepts.add(output.concept);
    job.costUsd += costUsd || 0;
    job.progress++;
  }
  if (job.cancelled) throw new Error('cancelled');
  if (!game.gameSummary) {
    job.itemStartedAt = new Date().toISOString();
    // The whole-game debrief is a different task from a single-moment
    // explanation, so it gets its own system prompt (own games only; the scout
    // persona already frames the whole-opponent view correctly).
    const summarySystem = scout ? system : gameSummarySystemPrompt(rating);
    const { output, costUsd, model } = await completeRetry(settings, { system: summarySystem, prompt: scout ? scoutGameSummaryPrompt(game) : gameSummaryPrompt(game), schema: SUMMARY_SCHEMA });
    const gs = { ...output, model, costUsd, createdAt: new Date().toISOString() };
    job.costUsd += costUsd || 0;
    await updateGame(job.gameId, g => { if (!g.gameSummary) g.gameSummary = gs; });
  }
  job.progress = job.total;
  const done = await updateGame(job.gameId, g => { g.status = 'explained'; });
  await syncDrillsForGame(done, settings, done.owner || DEFAULT_USER); // copy fresh categories/patterns onto the owner's drills
}

/** Build one opponent's clash index (the synthetic gameId "clash:<fideId>" keys
 * the dedup guard per opponent). The parse yields to the event loop as it goes,
 * and ensureClashIndex skips it entirely when the stored index is already fresh,
 * so a pre-build pass over unchanged books is near-instant. */
async function runClash(job) {
  const fideId = job.gameId.replace(/^clash:/, '');
  job.stage = 'parse';
  const entry = await ensureClashIndex(fideId, {
    onProgress: (done, total) => { job.progress = done; job.total = total; },
    cancelled: () => job.cancelled,
  });
  if (!entry && !job.cancelled) throw new Error('no scout book for this FIDE id');
}

/** Warm every opponent's clash index at startup so the Scouting page shows the
 * clash immediately (no button) and the published mirror bundles a current
 * index. Non-blocking: each is a queued job that no-ops when already fresh. */
export async function prebuildClashes() {
  const books = await listScoutBooks();
  for (const b of books) if (b.fideId) enqueue('clash', 'clash:' + b.fideId);
  return books.length;
}

/** Pattern and concept names used so far (most frequent first, capped), so the
 * model reuses them and recurring themes aggregate instead of fragmenting.
 * Exported for the re-explain route. */
export async function knownPatterns(currentGame) {
  const patterns = new Map(), concepts = new Map();
  const add = (map, key, n = 1) => { if (key) map.set(key, (map.get(key) || 0) + n); };
  // Name counts come off the game index (gameIndexEntry keeps them), so this
  // costs no full reads; the current game is taken from memory since the job
  // may hold explanations not yet on disk.
  for (const entry of await listAllGames()) {
    if (!entry.explained) continue;
    // Pattern libraries do not mix: the player's own patterns stay separate from
    // each scouted subject's patterns.
    if (entry.purpose !== (currentGame.purpose || 'own') || entry.subject !== (currentGame.subject || null)) continue;
    if (entry.id === currentGame.id) continue;
    for (const [k, n] of Object.entries(entry.patterns || {})) add(patterns, k, n);
    for (const [k, n] of Object.entries(entry.concepts || {})) add(concepts, k, n);
  }
  for (const e of Object.values(currentGame.explanations || {})) { add(patterns, e?.pattern); add(concepts, e?.concept); }
  const top = (map, n) => new Set([...map.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, n));
  return { patterns: top(patterns, 40), concepts: top(concepts, 25) };
}

/** The library's spelling of a pattern name when one matches up to case,
 * spacing, and punctuation, so "hanging piece after exchanges" is stored as
 * the existing "Hanging piece after exchange" and aggregates from the moment it
 * is written, not only when the report normalises. Unknown names pass through. */
export function canonicalPattern(name, known = []) {
  if (typeof name !== 'string' || !name) return name;
  const key = normalizeKey(name);
  for (const k of known) if (normalizeKey(k) === key) return k;
  return name;
}
