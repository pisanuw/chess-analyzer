import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempData } from './helpers.js';

process.env.DATA_DIR = tempData();
const { notesNeeded, synthesizeNote, MIN_INSTANCES, REFRESH_GROWTH } = await import('../server/patternnotes.js');
const { normalizeKey } = await import('../public/shared.js');

test('notesNeeded: new eligible patterns and grown notes, nothing else', () => {
  const pats = [
    { pattern: 'Hanging piece', count: MIN_INSTANCES - 1 },              // below the bar
    { pattern: 'Back rank', count: MIN_INSTANCES },                      // eligible, no note yet
    { pattern: 'Fork after capture', count: 2 + REFRESH_GROWTH - 1 },    // note still fresh
    { pattern: 'Pin pressure', count: 2 + REFRESH_GROWTH },              // grew enough since the note
  ];
  const notes = {
    [normalizeKey('Fork after capture')]: { count: 2 },
    [normalizeKey('Pin pressure')]: { count: 2 },
  };
  assert.deepEqual(notesNeeded(pats, notes).map(p => p.pattern), ['Back rank', 'Pin pressure']);
  assert.deepEqual(notesNeeded([], {}), []);
  assert.deepEqual(notesNeeded(undefined, {}), []);
});

test('a legacy note without a count refreshes once its pattern qualifies', () => {
  const pats = [{ pattern: 'Loose queen', count: MIN_INSTANCES }];
  assert.equal(notesNeeded(pats, { [normalizeKey('Loose queen')]: {} }).length, 1);
});

test('synthesizeNote returns null when the instances are gone from disk', async () => {
  const pat = { pattern: 'Ghost', count: 2, moments: [{ gameId: 'aaaaaaaaaa90', ply: 1 }, { gameId: 'aaaaaaaaaa91', ply: 1 }] };
  const note = await synthesizeNote(pat, 'kai', { llmProvider: 'claude', playerRating: 2000 }, 2000);
  assert.equal(note, null, 'no surviving instances: no LLM call, no note');
});
