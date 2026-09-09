// Opt-in FIDE id lookup against the official rating site (ratings.fide.com).
// This is the ONE place the app reaches a third party other than the claude CLI,
// and only on an explicit user action (the "find FIDE id" button), never at
// import: auto-resolving by name is too ambiguous to trust, so a human confirms
// each match. Results feed the players map (server/players.js).
//
// Contract, reverse-engineered from the site's own XHR:
//   GET https://ratings.fide.com/incl_search_l.php?search=<name>&simple=1
//   with header X-Requested-With: XMLHttpRequest  (omit it and the body is empty)
// returns an HTML table; each data row links to /profile/<id> and carries
// [id, name, title, wtitle, federation, standard, rapid, blitz].

const UA = 'Mozilla/5.0 (chess-analyzer; opponent prep) Chrome/120 Safari/537.36';
const SEARCH_URL = 'https://ratings.fide.com/incl_search_l.php';
const PROFILE_URL = id => `https://ratings.fide.com/profile/${id}`;

const toInt = s => { const n = parseInt(String(s).replace(/[^\d]/g, ''), 10); return Number.isFinite(n) ? n : null; };
const cellText = html => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();

/** Parse the search XHR HTML into candidate players. Pure, so it is unit-tested
 * against a fixture and never depends on the network. */
export function parseFideSearchHtml(html) {
  const out = [];
  const seen = new Set();
  for (const row of String(html || '').split(/<tr[\s>]/i).slice(1)) {
    const idm = row.match(/profile\/(\d+)/);
    if (!idm) continue;
    const fideId = idm[1];
    if (seen.has(fideId)) continue; // pagination tabs repeat rows
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => cellText(c[1]));
    if (cells.length < 2 || !cells[1]) continue;
    seen.add(fideId);
    out.push({
      fideId,
      name: cells[1],
      title: cells[2] || null,
      federation: cells[4] || null,
      rating: toInt(cells[5]),
      rapid: toInt(cells[6]),
      blitz: toInt(cells[7]),
    });
  }
  return out;
}

/** Search FIDE by name. Returns { query, count, candidates }. Throws on a
 * transport/HTTP error so the route can report it cleanly. */
export async function searchFide(name, { limit = 25, timeoutMs = 12000 } = {}) {
  const query = String(name || '').trim();
  if (query.length < 2) return { query, count: 0, candidates: [] };
  const url = `${SEARCH_URL}?search=${encodeURIComponent(query)}&simple=1`;
  const res = await fetch(url, {
    headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://ratings.fide.com/', 'User-Agent': UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`FIDE search failed (${res.status})`);
  const html = await res.text();
  const m = html.match(/([\d,]+)\s+record\(s\) found/i);
  const candidates = parseFideSearchHtml(html);
  return { query, count: m ? Number(m[1].replace(/,/g, '')) : candidates.length, candidates: candidates.slice(0, limit) };
}

/** Confirm an id by reading the canonical name off its profile page, or null. */
export async function fideProfileName(id, { timeoutMs = 12000 } = {}) {
  if (!/^\d{3,}$/.test(String(id))) return null;
  const res = await fetch(PROFILE_URL(id), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return null;
  const m = (await res.text()).match(/<title>\s*([^<]*?)\s*FIDE Profile\s*<\/title>/i);
  return m ? m[1].trim() : null;
}
