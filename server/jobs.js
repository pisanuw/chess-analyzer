// Sequential job queue: engine analysis, then LLM explanations. Progress is polled by the UI.
import { getEnginePool } from './enginepool.js';
import { analyseGame, summarize } from './analyze.js';
import { getGame, saveGame, getSettings, listGames } from './store.js';
import { complete, LlmError } from './llm.js';
import { flushCache } from './evalcache.js';
import { systemPrompt, momentPrompt, momentsBatchPrompt, gameSummaryPrompt, gameSummarySystemPrompt, scoutSystemPrompt, scoutMomentPrompt, scoutMomentsBatchPrompt, scoutGameSummaryPrompt, batchExplanationSchema, EXPLANATION_SCHEMA, SCOUT_EXPLANATION_SCHEMA, SUMMARY_SCHEMA, CATEGORIES } from './prompts.js';
import { syncDrillsForGame } from './drills.js';

const jobs = new Map();
let seq = 0;
let running = false;
const pending = [];

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
  pending.push(job);
  pump();
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
  for (const g of await listGames()) {
    if (!g.playerColor) continue;
    if (g.status === 'imported' || g.status === 'analysing') { enqueue('analyse', g.id); analyse++; }
    else if (g.status === 'analysed' && settings.autoExplain && settings.llmProvider !== 'manual') { enqueue('explain', g.id); explain++; }
  }
  if (analyse || explain) console.log(`resumed unfinished work: ${analyse} to analyse, ${explain} to explain`);
}

async function pump() {
  if (running) return;
  running = true;
  while (pending.length) {
    const job = pending.shift();
    if (job.status === 'cancelled') continue;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      if (job.kind === 'analyse') await runAnalyse(job);
      else if (job.kind === 'explain') await runExplain(job);
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
  running = false;
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
  const saved = await updateGame(job.gameId, g => {
    if (g.playerColor !== game.playerColor) {
      // Colour changed while the engine ran; re-derive the colour-dependent bits.
      moves.forEach(m => { m.isPlayer = m.color === g.playerColor; });
      Object.assign(summary, summarize(moves, g.playerColor, settings.momentThreshold));
    }
    g.analysis = { moves, summary, analysedAt: new Date().toISOString() };
    g.playerRating = settings.playerRating;
    g.explanations = g.explanations || {};
    g.status = 'analysed';
  });
  await syncDrillsForGame(saved, settings);
  await flushCache(); // persist opening evals gathered this job (debounced otherwise)
  if (settings.autoExplain && settings.llmProvider !== 'manual') {
    await runExplain(job);
  }
}

/** Validate one explanation object from a batch reply (the CLI enforces the
 * schema on single calls, but batch entries are matched to plies by hand).
 * Returns the clean entry or null. */
export function sanitizeExplanation(e) {
  if (!e) return null;
  for (const k of ['pattern', 'category', 'explanation', 'key_question']) if (typeof e[k] !== 'string' || !e[k]) return null;
  if (!CATEGORIES.includes(e.category)) return null;
  return {
    pattern: e.pattern, category: e.category, time_pressure: !!e.time_pressure,
    explanation: e.explanation, key_question: e.key_question,
    concept: typeof e.concept === 'string' ? e.concept : '',
  };
}

/** One retry for transient CLI failures (timeout, malformed output); anything
 * else propagates. A minute-long call failing at moment 5 of 6 should not
 * fail the whole job when a second attempt would do. */
async function completeRetry(settings, req) {
  try { return await complete(settings, req); } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    // Back off longer for a rate/usage limit than for a transient timeout or a
    // one-off malformed reply, so the single retry is not wasted racing a cap.
    const limited = /limit|rate|quota|overloaded|429|529/i.test(err.message || '');
    await new Promise(r => setTimeout(r, limited ? 30000 : 2000));
    return complete(settings, req);
  }
}

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
  const system = scout ? scoutSystemPrompt(settings.playerRating) : systemPrompt(settings.playerRating);
  const schema = scout ? SCOUT_EXPLANATION_SCHEMA : EXPLANATION_SCHEMA;
  const known = await knownPatterns(game);
  let remaining = [...todo];

  // Whole game in one call first: the moments share their context and each
  // per-moment CLI call costs about a minute of wall time. Anything missing
  // or invalid in the reply falls through to the per-moment loop, which is
  // also the retry path when the batch call itself fails.
  if (remaining.length >= 2) {
    if (job.cancelled) throw new Error('cancelled');
    job.itemStartedAt = new Date().toISOString();
    try {
      const args = [game, remaining, [...known.patterns], [...known.concepts]];
      const asked = remaining.length;
      const { output, costUsd, model } = await completeRetry(settings, {
        system,
        prompt: scout ? scoutMomentsBatchPrompt(...args) : momentsBatchPrompt(...args),
        schema: batchExplanationSchema(scout),
        timeoutMs: 240000 + 60000 * remaining.length,
      });
      const byPly = new Map((output?.explanations || []).map(e => [Number(e?.ply), e]));
      const saved = [];
      for (const ply of remaining) {
        const e = sanitizeExplanation(byPly.get(ply));
        if (!e) continue;
        const entry = { ...e, model, costUsd: null, createdAt: new Date().toISOString() };
        game.explanations[ply] = entry; // keep the held copy current for later prompts
        if (entry.pattern) known.patterns.add(entry.pattern);
        if (entry.concept) known.concepts.add(entry.concept);
        saved.push([ply, entry]);
      }
      // Only bill a batch that produced usable explanations; a zero-match reply
      // (all plies mislabelled) is wasted spend, and it silently degraded to a
      // full per-moment re-explain, so make that visible in the log.
      if (saved.length) job.costUsd += costUsd || 0;
      if (saved.length < asked) console.warn(`[job ${job.id}] batch matched ${saved.length}/${asked} moments${saved.length ? '' : ' (0: not billed)'}; the rest fall back per moment`);
      if (saved.length) {
        await updateGame(job.gameId, g => { g.explanations = g.explanations || {}; for (const [ply, entry] of saved) g.explanations[ply] = entry; });
        job.progress += saved.length;
        remaining = remaining.filter(ply => !game.explanations[ply]);
      }
    } catch (err) {
      if (job.cancelled || !(err instanceof LlmError)) throw err;
      console.error(`[job ${job.id}] batch explanation failed, falling back per moment: ${err.message}`);
    }
  }

  for (const ply of remaining) {
    if (job.cancelled) throw new Error('cancelled');
    job.itemStartedAt = new Date().toISOString(); // lets the UI show elapsed time on the current explanation
    const args = [game, ply, [...known.patterns], [...known.concepts]];
    const { output, costUsd, model } = await completeRetry(settings, { system, prompt: scout ? scoutMomentPrompt(...args) : momentPrompt(...args), schema });
    const entry = { ...output, model, costUsd, createdAt: new Date().toISOString() };
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
    const summarySystem = scout ? system : gameSummarySystemPrompt(settings.playerRating);
    const { output, costUsd, model } = await completeRetry(settings, { system: summarySystem, prompt: scout ? scoutGameSummaryPrompt(game) : gameSummaryPrompt(game), schema: SUMMARY_SCHEMA });
    const gs = { ...output, model, costUsd, createdAt: new Date().toISOString() };
    job.costUsd += costUsd || 0;
    await updateGame(job.gameId, g => { if (!g.gameSummary) g.gameSummary = gs; });
  }
  job.progress = job.total;
  const done = await updateGame(job.gameId, g => { g.status = 'explained'; });
  await syncDrillsForGame(done, settings); // copy fresh categories/patterns onto drills
}

/** Pattern and concept names used so far (most frequent first, capped), so the
 * model reuses them and recurring themes aggregate instead of fragmenting.
 * Exported for the re-explain route. */
export async function knownPatterns(currentGame) {
  const patterns = new Map(), concepts = new Map();
  const add = (map, key) => { if (key) map.set(key, (map.get(key) || 0) + 1); };
  for (const entry of await listGames()) {
    if (!entry.explained) continue;
    // Pattern libraries do not mix: the player's own patterns stay separate from
    // each scouted subject's patterns.
    if (entry.purpose !== (currentGame.purpose || 'own') || entry.subject !== (currentGame.subject || null)) continue;
    const g = entry.id === currentGame.id ? currentGame : await getGame(entry.id);
    for (const e of Object.values(g?.explanations || {})) { add(patterns, e?.pattern); add(concepts, e?.concept); }
  }
  const top = (map, n) => new Set([...map.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, n));
  return { patterns: top(patterns, 40), concepts: top(concepts, 25) };
}
