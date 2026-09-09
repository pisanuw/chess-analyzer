import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFideSearchHtml } from '../server/fide.js';

// Mirrors the real ratings.fide.com XHR fragment: a count line, then rows whose
// cells are [id, name(link), title, wtitle, federation, std, rapid, blitz].
const HTML = `<div>&nbsp;&nbsp;2 record(s) found.</div><table>
<tr class="list4"><td>30958130</td><td><a href="/profile/30958130">Harish, Neeraj</a></td><td>CM</td><td></td><td>USA</td><td>2250</td><td>2120</td><td>2070</td></tr>
<tr class="list3"><td>1503014</td><td><a href="/profile/1503014">Carlsen, Magnus</a></td><td>GM</td><td></td><td>NOR</td><td>2823</td><td>2830</td><td>2886</td></tr>
</table>
<table><tr class="list4"><td>30958130</td><td><a href="/profile/30958130">Harish, Neeraj</a></td><td>CM</td><td></td><td>USA</td><td>2250</td><td>2120</td><td>2070</td></tr></table>`;

test('parseFideSearchHtml extracts candidates and dedupes repeated rows', () => {
  const c = parseFideSearchHtml(HTML);
  assert.equal(c.length, 2, 'the repeated pagination row is deduped');
  assert.deepEqual(c[0], { fideId: '30958130', name: 'Harish, Neeraj', title: 'CM', federation: 'USA', rating: 2250, rapid: 2120, blitz: 2070 });
  assert.equal(c[1].fideId, '1503014');
  assert.equal(c[1].federation, 'NOR');
  assert.equal(c[1].rating, 2823);
});

test('parseFideSearchHtml returns nothing for the no-results fragment', () => {
  assert.deepEqual(parseFideSearchHtml('<br>No results found for your query.<br>'), []);
  assert.deepEqual(parseFideSearchHtml(''), []);
});

test('parseFideSearchHtml leaves missing ratings and titles null', () => {
  const c = parseFideSearchHtml('<tr><td>295221</td><td><a href="/profile/295221">Pisane, Jonathan</a></td><td></td><td></td><td>BEL</td><td></td><td></td><td></td></tr>');
  assert.equal(c[0].rating, null);
  assert.equal(c[0].title, null);
  assert.equal(c[0].federation, 'BEL');
});
