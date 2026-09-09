import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fideIdFromHeaders } from '../server/pgn.js';
import { indexByName, lookupFideId, assocsFromHeaders, mergeAssociations } from '../server/players.js';

test('fideIdFromHeaders reads tags case- and punctuation-insensitively', () => {
  assert.equal(fideIdFromHeaders({ White: 'A', WhiteFideId: '30958130' }, 'white'), '30958130');
  assert.equal(fideIdFromHeaders({ Black: 'B', BlackFIDEId: '12345' }, 'black'), '12345');
  assert.equal(fideIdFromHeaders({ 'White FideId': '999' }, 'white'), '999');
  assert.equal(fideIdFromHeaders({ WhiteElo: '2200' }, 'white'), null, 'Elo is not an id');
  assert.equal(fideIdFromHeaders({ WhiteFideId: '' }, 'white'), null);
  assert.equal(fideIdFromHeaders({ WhiteFideId: 'abc' }, 'white'), null, 'non-numeric ignored');
});

test('assocsFromHeaders pairs each tagged player with their name', () => {
  const h = { White: 'Harish, Neeraj', WhiteFideId: '30958130', Black: 'Foe, F' };
  assert.deepEqual(assocsFromHeaders(h), [{ fideId: '30958130', name: 'Harish, Neeraj' }]);
  assert.deepEqual(assocsFromHeaders({ White: 'A', Black: 'B' }), [], 'no tags, no associations');
});

test('mergeAssociations learns new names and dedupes; lookup is unambiguous-only', () => {
  const map = {};
  const now = '2026-09-09T00:00:00.000Z';
  assert.equal(mergeAssociations(map, [{ fideId: '100', name: 'Harish, Neeraj' }], now), 1);
  assert.equal(mergeAssociations(map, [{ fideId: '100', name: 'Harish, Neeraj' }], now), 0, 'same pair is not relearned');
  assert.equal(mergeAssociations(map, [{ fideId: '100', name: 'Neeraj Harish' }], now), 1, 'an alias spelling is learned');
  assert.deepEqual(map['100'].names, ['Harish, Neeraj', 'Neeraj Harish']);

  assert.equal(lookupFideId(map, 'harish, neeraj'), '100', 'case-insensitive name lookup');
  assert.equal(lookupFideId(map, 'Neeraj Harish'), '100', 'resolves via the alias');
  assert.equal(lookupFideId(map, 'Unknown, U'), null);

  // Homonym: one name, two ids -> not auto-resolvable.
  mergeAssociations(map, [{ fideId: '200', name: 'Harish, Neeraj' }], now);
  assert.equal(lookupFideId(map, 'Harish, Neeraj'), null, 'ambiguous names must not resolve');
  assert.equal(lookupFideId(map, 'Neeraj Harish'), '100', 'the unique alias still resolves');
});

test('indexByName maps each normalized name to its id set', () => {
  const idx = indexByName({ '100': { fideId: '100', names: ['Carlsen, M'] }, '200': { fideId: '200', names: ['So, W', 'Wesley So'] } });
  assert.deepEqual([...idx.get('carlsen, m')], ['100']);
  assert.deepEqual([...idx.get('wesley so')], ['200']);
});
