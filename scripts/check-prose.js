#!/usr/bin/env node
// House rule (CLAUDE.md): no em dashes in prose, UI copy, or prompts. This
// scans the files a reader or the model sees and fails on the first offender,
// so the rule is enforced by CI rather than by memory. Tests may contain an em
// dash on purpose (they check that one is stripped), so they are not scanned.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'data', '.git', '.netlify', 'vendor', 'test', '.claude', 'samples']);
const EXT = new Set(['.md', '.js', '.mjs', '.html', '.css', '.webmanifest']);
const EM_DASH = '\u2014';

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(name)) yield* walk(p); continue; }
    if (EXT.has(path.extname(name))) yield p;
  }
}

const hits = [];
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => { if (line.includes(EM_DASH)) hits.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 100)}`); });
}
if (hits.length) {
  console.error(`Em dash found in ${hits.length} place${hits.length === 1 ? '' : 's'} (use a comma, colon, or parentheses):\n` + hits.map(h => '  ' + h).join('\n'));
  process.exit(1);
}
console.log('prose check passed: no em dashes');
