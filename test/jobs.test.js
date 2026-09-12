import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempData } from './helpers.js';

process.env.DATA_DIR = tempData();
const { sanitizeExplanation, playerRatingFor } = await import('../server/jobs.js');

test('playerRatingFor: the game Elo header, then the roster rating, then the setting', async () => {
  const s = { playerRating: 1800 };
  assert.equal(await playerRatingFor({ purpose: 'own', playerColor: 'white', headers: { WhiteElo: '2143' }, owner: 'kai' }, s), 2143);
  assert.equal(await playerRatingFor({ purpose: 'own', playerColor: 'black', headers: { WhiteElo: '2143' }, owner: 'kai' }, s), 2000, "kai's roster rating");
  assert.equal(await playerRatingFor({ purpose: 'own', playerColor: 'white', headers: {}, owner: 'nikash' }, s), 1800, 'no roster rating: the setting');
  assert.equal(await playerRatingFor({ purpose: 'scout', playerColor: 'white', headers: { WhiteElo: '2400' } }, s), 1800, 'scout games keep the setting');
});

test('sanitizeExplanation accepts only complete entries with known categories', () => {
  const good = { ply: 3, pattern: 'Wrong rook', category: 'calculation', time_pressure: 'yes', explanation: 'because', key_question: 'what?', concept: 'rook endings' };
  assert.deepEqual(sanitizeExplanation(good), {
    pattern: 'Wrong rook', category: 'calculation',
    explanation: 'because', key_question: 'what?', concept: 'rook endings',
  }, 'time_pressure is not taken from the model: the job stamps it from the clock');
  assert.equal(sanitizeExplanation({ ...good, pattern: 'wrong  ROOK.' }, ['Wrong rook']).pattern, 'Wrong rook', 'a known name is folded onto the library spelling');
  assert.equal(sanitizeExplanation(null), null);
  assert.equal(sanitizeExplanation({ ...good, category: 'made-up' }), null, 'unknown category rejected');
  assert.equal(sanitizeExplanation({ ...good, explanation: '' }), null, 'empty field rejected');
  assert.equal(sanitizeExplanation({ ...good, key_question: 7 }), null, 'wrong type rejected');
  assert.equal(sanitizeExplanation({ ...good, concept: undefined }).concept, '', 'missing concept defaults to empty');
});
