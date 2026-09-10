// Pre-build every opponent's clash index (data/clash.json) so a publish bundles
// a current one and the read-only mirror can serve the opening clash without an
// engine, the claude CLI, or parsing at request time. Run before deploy from
// scripts/publish-web.sh; also runnable by hand: `node scripts/prebuild-clashes.js`.
import { listScoutBooks } from '../server/store.js';
import { ensureClashIndex } from '../server/clash.js';

const books = await listScoutBooks();
for (const b of books) {
  if (!b.fideId) continue;
  const t = Date.now();
  const entry = await ensureClashIndex(b.fideId, { force: true });
  console.log(`  ${b.name} (${b.fideId}): ${entry?.coverage?.bookGamesParsed ?? 0} games, ${Date.now() - t}ms`);
}
console.log(`clash indexes ready for ${books.length} opponent${books.length === 1 ? '' : 's'}`);
