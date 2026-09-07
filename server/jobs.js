// Sequential job queue: engine analysis, then LLM explanations. Progress is polled by the UI.
import { getEngine } from './engine.js';
import { analyseGame, summarize } from './analyze.js';
import { getGame, saveGame, getSettings, listGames } from './store.js';
import { complete, LlmError } from './llm.js';
import { systemPrompt, momentPrompt, gameSummaryPrompt, scoutSystemPrompt, scoutMomentPrompt, scoutGameSummaryPrompt, EXPLANATION_SCHEMA, SCOUT_EXPLANATION_SCHEMA, SUMMARY_SCHEMA } from './prompts.js';
import { syncDrillsForGame } from './drills.js';

const jobs = new Map();
let seq = 0;
let running = false;
const pending = [];

export function listJobs() {
  // Cap only finished jobs: active ones must always be visible, or the UI shows
  // a long queue with no running progress bar (the runner is the oldest job).
  const all = [...jobs.values()].sort((a, b) => b.id - a.id);
  const isActive = j => j.status === 'queued' || j.status === 'running';
  return all.filter(isActive).concat(all.filter(j => !isActive(j)).slice(0, 50)).sort((a, b) => b.id - a.id);
}

export function enqueue(kind, gameId) {
  const dup = [...jobs.values()].find(j => j.gameId === gameId && j.kind === kind
    && (j.status === 'queued' || (j.status === 'running' && !j.cancelled)));
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
  const engine = await getEngine(settings);
  await updateGame(job.gameId, g => { g.status = 'analysing'; g.lastError = null; });
  const { moves, summary } = await analyseGame(engine, game, settings, (done, total, depth) => {
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
  if (settings.autoExplain && settings.llmProvider !== 'manual') {
    await runExplain(job);
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
  for (const ply of todo) {
    if (job.cancelled) throw new Error('cancelled');
    job.itemStartedAt = new Date().toISOString(); // lets the UI show elapsed time on the current explanation
    const { output, costUsd, model } = await complete(settings, { system, prompt: scout ? scoutMomentPrompt(game, ply, [...known]) : momentPrompt(game, ply, [...known]), schema });
    const entry = { ...output, model, costUsd, createdAt: new Date().toISOString() };
    game.explanations[ply] = entry; // keep the held copy current for later prompts
    await updateGame(job.gameId, g => { g.explanations = g.explanations || {}; g.explanations[ply] = entry; });
    if (output.pattern) known.add(output.pattern);
    job.costUsd += costUsd || 0;
    job.progress++;
  }
  if (job.cancelled) throw new Error('cancelled');
  if (!game.gameSummary) {
    job.itemStartedAt = new Date().toISOString();
    const { output, costUsd, model } = await complete(settings, { system, prompt: scout ? scoutGameSummaryPrompt(game) : gameSummaryPrompt(game), schema: SUMMARY_SCHEMA });
    const gs = { ...output, model, costUsd, createdAt: new Date().toISOString() };
    job.costUsd += costUsd || 0;
    await updateGame(job.gameId, g => { if (!g.gameSummary) g.gameSummary = gs; });
  }
  job.progress = job.total;
  const done = await updateGame(job.gameId, g => { g.status = 'explained'; });
  await syncDrillsForGame(done, settings); // copy fresh categories/patterns onto drills
}

/** Pattern names used so far across all games (most frequent first, capped), so the model can reuse them. */
async function knownPatterns(currentGame) {
  const counts = new Map();
  const add = e => { if (e?.pattern) counts.set(e.pattern, (counts.get(e.pattern) || 0) + 1); };
  for (const entry of await listGames()) {
    if (!entry.explained) continue;
    // Pattern libraries do not mix: the player's own patterns stay separate from
    // each scouted subject's patterns.
    if (entry.purpose !== (currentGame.purpose || 'own') || entry.subject !== (currentGame.subject || null)) continue;
    const g = entry.id === currentGame.id ? currentGame : await getGame(entry.id);
    for (const e of Object.values(g?.explanations || {})) add(e);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p).slice(0, 40);
  return new Set(sorted);
}
