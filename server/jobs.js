// Sequential job queue: engine analysis, then LLM explanations. Progress is polled by the UI.
import { getEngine } from './engine.js';
import { analyseGame } from './analyze.js';
import { getGame, saveGame, getSettings, listGames } from './store.js';
import { complete, LlmError } from './llm.js';
import { systemPrompt, momentPrompt, gameSummaryPrompt, EXPLANATION_SCHEMA, SUMMARY_SCHEMA } from './prompts.js';
import { syncDrillsForGame } from './drills.js';

const jobs = new Map();
let seq = 0;
let running = false;
const pending = [];

export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.id - a.id).slice(0, 50);
}

export function enqueue(kind, gameId) {
  const dup = [...jobs.values()].find(j => j.gameId === gameId && j.kind === kind && (j.status === 'queued' || j.status === 'running'));
  if (dup) return dup;
  const job = { id: ++seq, kind, gameId, status: 'queued', progress: 0, total: 0, stage: '', error: null, createdAt: new Date().toISOString(), costUsd: 0 };
  jobs.set(job.id, job);
  pending.push(job);
  pump();
  return job;
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
      job.status = 'done';
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
      console.error(`[job ${job.id} ${job.kind} ${job.gameId}] ${err.message}`);
      try {
        const g = await getGame(job.gameId);
        if (g) { g.lastError = err.message; await saveGame(g); }
      } catch {}
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
  const engine = await getEngine(settings);
  game.status = 'analysing';
  game.lastError = null;
  await saveGame(game);
  const { moves, summary } = await analyseGame(engine, game, settings, (done, total) => { job.progress = done; job.total = total; });
  game.analysis = { moves, summary, analysedAt: new Date().toISOString() };
  game.playerRating = settings.playerRating;
  game.explanations = game.explanations || {};
  game.status = 'analysed';
  await saveGame(game);
  await syncDrillsForGame(game, settings);
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
  const system = systemPrompt(settings.playerRating);
  const known = await knownPatterns(game);
  for (const ply of todo) {
    const { output, costUsd, model } = await complete(settings, { system, prompt: momentPrompt(game, ply, [...known]), schema: EXPLANATION_SCHEMA });
    game.explanations[ply] = { ...output, model, costUsd, createdAt: new Date().toISOString() };
    if (output.pattern) known.add(output.pattern);
    job.costUsd += costUsd || 0;
    job.progress++;
    await saveGame(game);
  }
  if (!game.gameSummary) {
    const { output, costUsd, model } = await complete(settings, { system, prompt: gameSummaryPrompt(game), schema: SUMMARY_SCHEMA });
    game.gameSummary = { ...output, model, costUsd, createdAt: new Date().toISOString() };
    job.costUsd += costUsd || 0;
  }
  job.progress = job.total;
  game.status = 'explained';
  await saveGame(game);
}

/** Pattern names used so far across all games (most frequent first, capped), so the model can reuse them. */
async function knownPatterns(currentGame) {
  const counts = new Map();
  const add = e => { if (e?.pattern) counts.set(e.pattern, (counts.get(e.pattern) || 0) + 1); };
  for (const entry of await listGames()) {
    if (!entry.explained) continue;
    const g = entry.id === currentGame.id ? currentGame : await getGame(entry.id);
    for (const e of Object.values(g?.explanations || {})) add(e);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p).slice(0, 40);
  return new Set(sorted);
}
