// In-process memo for derived views that are expensive to rebuild and change
// only when their inputs do: a report, a repertoire, a puzzle pool. Callers key
// each value on a fingerprint of the inputs (see store.js indexFingerprint), so
// a stale value is impossible by construction and nothing needs invalidating.
// Small and least-recently-used, one namespace per builder.
const stores = new Map(); // name -> Map key -> value

export async function memo(name, key, compute, { max = 16 } = {}) {
  let m = stores.get(name);
  if (!m) stores.set(name, m = new Map());
  if (m.has(key)) {
    const v = m.get(key);
    m.delete(key); m.set(key, v); // refresh insertion order: the oldest falls out first
    return v;
  }
  const v = await compute();
  m.set(key, v);
  while (m.size > max) m.delete(m.keys().next().value);
  return v;
}

/** Drop every memoised value (one namespace, or all): for tests and for
 * settings changes that alter how a value is derived. */
export function clearMemo(name = null) {
  if (name) stores.delete(name); else stores.clear();
}

/** How many values each namespace holds, for diagnostics. */
export function memoStats() {
  return Object.fromEntries([...stores].map(([k, m]) => [k, m.size]));
}
