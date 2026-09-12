import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGame } from './helpers.js';
import {
  EXPLANATION_SCHEMA, SCOUT_EXPLANATION_SCHEMA, PREP_SHEET_SCHEMA,
  momentPrompt, scoutMomentPrompt, scoutGameSummaryPrompt, prepSheetPrompt, prepSheetVersion,
  momentsBatchPrompt, scoutMomentsBatchPrompt, batchExplanationSchema,
} from '../server/prompts.js';

test('scout explanation schema keeps the exact field names of the own schema', () => {
  // Storage and every UI reader depend on this invariant.
  assert.deepEqual(Object.keys(SCOUT_EXPLANATION_SCHEMA.properties), Object.keys(EXPLANATION_SCHEMA.properties));
  assert.deepEqual(SCOUT_EXPLANATION_SCHEMA.required, EXPLANATION_SCHEMA.required);
});

test('scoutMomentPrompt frames the subject and includes the punishment lines', () => {
  const g = makeGame({ purpose: 'scout', subject: 'Karpov, A', moments: [{ ply: 1, loss: 25 }], plies: 4 });
  g.playerRating = 2000;
  const p = scoutMomentPrompt(g, 1, ['Grabs poisoned pawns']);
  assert.ok(p.includes('Karpov, A'), 'names the subject');
  assert.ok(p.includes('played e4'), 'names the mistake');
  assert.ok(p.includes('AFTER the mistake'), 'includes the punishment lines section');
  assert.ok(p.includes('Grabs poisoned pawns'), 'passes the subject pattern library');
  assert.ok(!p.includes('—'), 'no em dashes (repo convention)');
  const own = momentPrompt(g, 1, []);
  assert.ok(own.includes('being coached'), 'own prompt still coaches the mover');
});

test('batch prompt states the game once and each moment under its ply', () => {
  const g = makeGame({ moments: [{ ply: 1, loss: 25 }, { ply: 3, loss: 22 }], plies: 4 });
  g.playerRating = 2000;
  const p = momentsBatchPrompt(g, [1, 3], ['Old pattern'], ['old concept']);
  assert.equal((p.match(/being coached/g) || []).length, 1, 'shared context appears once');
  assert.ok(p.includes('Moment 1 of 2 (ply 1)') && p.includes('Moment 2 of 2 (ply 3)'));
  assert.ok(p.includes('Old pattern') && p.includes('old concept'), 'libraries passed once for the whole batch');
  assert.ok(!p.includes('—'), 'no em dashes (repo convention)');

  const schema = batchExplanationSchema(false);
  assert.deepEqual(schema.required, ['explanations']);
  assert.ok(schema.properties.explanations.items.required.includes('ply'));
  assert.deepEqual(
    schema.properties.explanations.items.required.filter(k => k !== 'ply'),
    EXPLANATION_SCHEMA.required,
    'batch items require exactly the single-call fields plus ply');

  const sg = makeGame({ purpose: 'scout', subject: 'Karpov, A', moments: [{ ply: 1, loss: 25 }, { ply: 3, loss: 22 }], plies: 4 });
  const sp = scoutMomentsBatchPrompt(sg, [1, 3]);
  assert.ok(sp.includes('Karpov, A') && sp.includes('Mistake 2 of 2 (ply 3)'));
  assert.ok(!sp.includes('—'));
});

test('scoutGameSummaryPrompt and prepSheetPrompt are grounded in the dossier', () => {
  const g = makeGame({ purpose: 'scout', subject: 'Karpov, A' });
  const s = scoutGameSummaryPrompt(g);
  assert.ok(s.includes('scouting Karpov, A'));
  const report = {
    games: 3,
    byCategory: { calculation: { count: 3, weight: 6 } },
    byPhase: { opening: { accuracy: 90, momentsPer100: 1 }, middlegame: { accuracy: 80, momentsPer100: 5 }, endgame: { accuracy: 70, momentsPer100: 9 } },
    patterns: [{ pattern: 'Passive rook', count: 2 }],
    timeManagement: null,
  };
  const repertoire = [{ color: 'white', line: ['e4', 'e5'], eco: 'C20', count: 3, scorePct: 33, prepEndsPly: 9 }];
  const p = prepSheetPrompt('Karpov, A', report, repertoire);
  assert.ok(p.includes('calculation: 3 moments'));
  assert.ok(p.includes('Passive rook'));
  assert.ok(p.includes('1.e4 e5'));
  assert.ok(p.includes('on their own from move 5'));
  assert.ok(p.includes('preparation sheet'), 'the instructions from prompts/prep-sheet.md are included');
  assert.ok(!p.includes('—'), 'no em dashes in the instructions or the dossier');
  assert.deepEqual(PREP_SHEET_SCHEMA.required, ['headline', 'profile', 'exploit_plan', 'openings', 'watch_fors']);
  assert.deepEqual(PREP_SHEET_SCHEMA.properties.profile.required, ['style', 'strongest_phase', 'weakest_phase', 'main_errors', 'time_trouble']);
});

test('prepSheetVersion is a stable, non-empty fingerprint of the sheet format', () => {
  const v = prepSheetVersion();
  assert.match(v, /^[0-9a-f]{12}$/, 'a short hex fingerprint (instructions + schema)');
  assert.equal(v, prepSheetVersion(), 'stable across calls, so an unchanged format is not flagged as new');
});
