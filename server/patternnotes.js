// Pattern study notes: one transferable lesson per recurring pattern,
// synthesized by the coach model from the stored explanations of that
// pattern's instances. Engine-grounded like every other prompt: the model
// sees FENs, played and best moves, judgments, and its own earlier
// explanations, and distills a rule; it never evaluates a position.
//
// Notes are written two ways: the admin's per-pattern button on the Report
// page (always re-synthesizes), and automatically at the end of each explain
// job for the game's owner (syncPatternNotes). The automatic pass synthesizes
// any pattern that newly reached MIN_INSTANCES and refreshes a note once its
// pattern has gained REFRESH_GROWTH instances since the note was written
// (report moments are newest first, so new evidence enters the prompt). The
// growth threshold keeps a backlog of explain jobs from re-buying the same
// note after every game.
import { getGame, getSettings, getPatternNotes, savePatternNotes, DEFAULT_USER } from './store.js';
import { buildReport } from './report.js';
import { completeRetry } from './llm.js';
import { systemPrompt, patternSynthesisPrompt, PATTERN_SYNTH_SCHEMA } from './prompts.js';
import { getUser } from './users.js';
import { normalizeKey } from '../public/shared.js';

export const MIN_INSTANCES = 2;  // fewer is an anecdote, not a pattern
export const REFRESH_GROWTH = 2; // new instances before a note is re-synthesized
const MAX_INSTANCES = 8;         // instances shown to the model (newest first)

/** Which patterns need a (re)synthesis, given the report's patterns and the
 * stored notes. Pure, exported for the tests. */
export function notesNeeded(patterns, notes) {
  return (patterns || []).filter(p => {
    if (p.count < MIN_INSTANCES) return false;
    const note = notes[normalizeKey(p.pattern)];
    return !note || (note.count ?? 0) + REFRESH_GROWTH <= p.count;
  });
}

/** Synthesize and store the note for one report pattern entry. Returns the
 * note, or null when fewer than MIN_INSTANCES explained instances survive the
 * re-read (a game deleted since the report was built). */
export async function synthesizeNote(pat, userId = DEFAULT_USER, settings = null, rating = null) {
  settings = settings || await getSettings();
  rating = rating || (await getUser(userId).catch(() => null))?.rating || settings.playerRating;
  const instances = [];
  for (const ref of pat.moments.slice(0, MAX_INSTANCES)) {
    const g = await getGame(ref.gameId);
    const m = g?.analysis?.moves[ref.ply - 1];
    const e = g?.explanations?.[ref.ply];
    if (m && e) instances.push({ label: ref.label, date: ref.date, fen: m.fenBefore, san: m.san, bestSan: m.bestSan, judgment: m.judgment, explanation: e.explanation, key_question: e.key_question });
  }
  if (instances.length < MIN_INSTANCES) return null;
  const { output, costUsd, model } = await completeRetry(settings, {
    system: systemPrompt(rating),
    prompt: patternSynthesisPrompt(pat.pattern, instances),
    schema: PATTERN_SYNTH_SCHEMA,
  });
  const notes = await getPatternNotes(userId);
  const key = normalizeKey(pat.pattern);
  notes[key] = { pattern: pat.pattern, ...output, count: pat.count, model, costUsd, createdAt: new Date().toISOString() };
  await savePatternNotes(notes, userId);
  return notes[key];
}

/** Bring a member's notes up to date with their report: synthesize new
 * eligible patterns, refresh grown ones. One pattern failing does not stop
 * the rest. Returns { synthesized, costUsd, failed }. */
export async function syncPatternNotes(userId = DEFAULT_USER, { cancelled = () => false } = {}) {
  const settings = await getSettings();
  if (settings.llmProvider === 'manual') return { synthesized: 0, costUsd: 0, failed: 0 };
  const report = await buildReport({ userId });
  const notes = await getPatternNotes(userId);
  const todo = notesNeeded(report.patterns, notes);
  const rating = (await getUser(userId).catch(() => null))?.rating || settings.playerRating;
  let synthesized = 0, costUsd = 0, failed = 0;
  for (const pat of todo) {
    if (cancelled()) break;
    try {
      const note = await synthesizeNote(pat, userId, settings, rating);
      if (note) { synthesized++; costUsd += note.costUsd || 0; }
    } catch (err) {
      failed++;
      console.error(`pattern note "${pat.pattern}" (${userId}) failed: ${err.message}`);
    }
  }
  return { synthesized, costUsd, failed };
}
