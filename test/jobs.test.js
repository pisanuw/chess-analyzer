import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempData } from './helpers.js';

process.env.DATA_DIR = tempData();
const { sanitizeExplanation } = await import('../server/jobs.js');

test('sanitizeExplanation accepts only complete entries with known categories', () => {
  const good = { ply: 3, pattern: 'Wrong rook', category: 'calculation', time_pressure: 'yes', explanation: 'because', key_question: 'what?', concept: 'rook endings' };
  assert.deepEqual(sanitizeExplanation(good), {
    pattern: 'Wrong rook', category: 'calculation', time_pressure: true,
    explanation: 'because', key_question: 'what?', concept: 'rook endings',
  });
  assert.equal(sanitizeExplanation(null), null);
  assert.equal(sanitizeExplanation({ ...good, category: 'made-up' }), null, 'unknown category rejected');
  assert.equal(sanitizeExplanation({ ...good, explanation: '' }), null, 'empty field rejected');
  assert.equal(sanitizeExplanation({ ...good, key_question: 7 }), null, 'wrong type rejected');
  assert.equal(sanitizeExplanation({ ...good, concept: undefined }).concept, '', 'missing concept defaults to empty');
});
