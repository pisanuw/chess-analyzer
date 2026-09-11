// Thin fetch wrapper for the local JSON API.
async function req(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // fetch rejects (server restarted, offline). Surface a typed, actionable
    // error instead of the raw "Failed to fetch", which reads like a bug.
    const err = new Error('Cannot reach the server. Is it running (npm start)?');
    err.offline = true;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') {
    showLogin();
    const err = new Error('Login required'); // the overlay handles it; callers should not render this
    err.handled = true; err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(data.error || `${method} ${url} failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Disable a button while an async action runs; restore it in finally so an
 * impatient double-click cannot fire the request twice. */
export async function busy(btn, fn) {
  if (!btn) return fn();
  const was = btn.disabled;
  btn.disabled = true;
  try { return await fn(); } finally { btn.disabled = was; }
}

/** Populated once at startup from /api/auth/me; views read session.user?.role. */
export const session = { user: null, authActive: false, providers: {} };

let loginShown = false;

/** Sign-in overlay: Google and/or a magic-link email (or the legacy single
 * password when neither provider is configured). Shown on any 401 and at startup
 * when auth is on but nobody is signed in. Fetches /api/auth/me (which is exempt
 * from the auth gate) to learn which methods to offer. */
export async function showLogin() {
  if (loginShown || document.getElementById('login-overlay')) return;
  loginShown = true; // set before the await so two concurrent 401s cannot both build the overlay
  let providers = {};
  try { const me = await api.me(); if (me.user) { loginShown = false; return; } providers = me.providers || {}; } catch {}
  const denied = new URLSearchParams(location.search).get('login');
  const google = providers.google ? `<a class="btn primary login-google" href="/api/auth/google">Sign in with Google</a>` : '';
  const magic = providers.magic ? `<form id="magic-form" class="login-magic">
      <input type="email" id="magic-email" placeholder="you@example.com" autocomplete="email" required>
      <button class="btn" type="submit">Email me a sign-in link</button>
    </form>` : '';
  const pw = (!providers.google && !providers.magic) ? `<form id="pw-form" class="login-magic">
      <input type="password" id="login-pw" placeholder="Password" autocomplete="current-password">
      <button class="btn primary" type="submit">Enter</button>
    </form>` : '';
  const div = document.createElement('div');
  div.id = 'login-overlay';
  div.className = 'login-overlay';
  div.innerHTML = `<div class="login-box">
    <div style="font-size:42px">♞</div>
    <h2 style="margin:0">Chess Analyzer</h2>
    ${denied === 'denied' ? '<p class="login-err">That account is not on the invite list. Ask the admin to add your email.</p>' : ''}
    ${denied === 'google_denied' ? '<p class="login-err">Google sign-in was cancelled. Try again.</p>' : ''}
    ${google}${magic}${pw}
    <details class="login-request">
      <summary>Not on the list? Request access</summary>
      <form id="req-access-form" class="login-magic">
        <input type="email" id="req-email" placeholder="you@example.com" autocomplete="email" required>
        <textarea id="req-reason" placeholder="Why you would like access (optional)" rows="2" style="width:100%; box-sizing:border-box"></textarea>
        <button class="btn" type="submit">Send request</button>
      </form>
    </details>
    <p id="login-msg" class="login-msg"></p>
  </div>`;
  document.body.appendChild(div);
  div.querySelector('#req-access-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.requestAccess(div.querySelector('#req-email').value.trim(), div.querySelector('#req-reason').value.trim());
      div.querySelector('#login-msg').textContent = 'Request sent. The admin will be in touch.';
    } catch (err) { div.querySelector('#login-msg').textContent = err.message; }
  });
  div.querySelector('#magic-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.magicRequest(div.querySelector('#magic-email').value.trim());
      div.querySelector('#login-msg').textContent = 'Check your email for a sign-in link (valid for 15 minutes).';
    } catch (err) { div.querySelector('#login-msg').textContent = err.message; }
  });
  div.querySelector('#pw-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    try { await req('POST', '/api/login', { password: div.querySelector('#login-pw').value }); location.reload(); }
    catch (err) { div.querySelector('#login-msg').textContent = err.message; }
  });
}

// Visitors record nothing: these writes resolve to a no-op instead of calling
// the server (the server guards them too). session.user is set at startup.
const noopForVisitor = fn => (...args) => (session.user?.role === 'visitor' ? Promise.resolve({ ephemeral: true }) : fn(...args));

export const api = {
  status: () => req('GET', '/api/status'),
  me: () => req('GET', '/api/auth/me'),
  logout: () => req('POST', '/api/auth/logout', {}),
  magicRequest: email => req('POST', '/api/auth/magic/request', { email }),
  settings: () => req('GET', '/api/settings'),
  saveSettings: patch => req('PUT', '/api/settings', patch),
  games: () => req('GET', '/api/games'),
  game: id => req('GET', `/api/games/${id}`),
  importPgn: (pgn, analyse = true, purpose = 'own', subject = '') => req('POST', '/api/games/import', { pgn, analyse, purpose, subject }),
  deleteGame: id => req('DELETE', `/api/games/${id}`),
  setPlayer: (id, color, analyse = true) => req('POST', `/api/games/${id}/player`, { color, analyse }),
  setNames: (id, white, black, subject) => req('POST', `/api/games/${id}/names`, { white, black, ...(subject !== undefined ? { subject } : {}) }),
  analyse: (id, force = false) => req('POST', `/api/games/${id}/analyse`, { force }),
  explain: id => req('POST', `/api/games/${id}/explain`, {}),
  analyseAll: (opts = {}) => req('POST', '/api/games/analyse-all', opts),
  prompt: (id, ply) => req('GET', `/api/games/${id}/moments/${ply}/prompt`),
  saveExplanation: (id, ply, e) => req('PUT', `/api/games/${id}/moments/${ply}/explanation`, e),
  guess: noopForVisitor((id, ply, uci, correct) => req('POST', `/api/games/${id}/moments/${ply}/guess`, { uci, correct })),
  evalMove: (id, ply, uci) => req('POST', `/api/games/${id}/moments/${ply}/eval`, { uci }),
  testHosts: () => req('POST', '/api/engine/hosts/test', {}),
  jobs: () => req('GET', '/api/jobs'),
  report: () => req('GET', '/api/report'),
  repertoire: () => req('GET', '/api/repertoire'),
  scoutSubjects: () => req('GET', '/api/scout'),
  scout: subject => req('GET', `/api/scout/${encodeURIComponent(subject)}`),
  prepSheet: subject => req('POST', `/api/scout/${encodeURIComponent(subject)}/prepsheet`),
  requestPrepSheet: subject => req('POST', `/api/scout/${encodeURIComponent(subject)}/prepsheet/request`, {}),
  requestPrepByFide: fideId => req('POST', '/api/prep-request', { fideId }),
  requestAccess: (email, reason) => req('POST', '/api/auth/request-access', { email, reason }),
  audit: () => req('GET', '/api/audit'),
  adminUsers: () => req('GET', '/api/admin/users'),
  addVisitor: email => req('POST', '/api/admin/visitors', { email }),
  addPlayer: ({ email, displayName, fideId, playerNames }) => req('POST', '/api/admin/players', { email, displayName, fideId, playerNames }),
  removeUser: id => req('DELETE', `/api/admin/users/${encodeURIComponent(id)}`),
  scoutImport: ({ pgn, fideId, name, filename }) => req('POST', '/api/scout/import', { pgn, fideId, name, filename }),
  scoutBook: fideId => req('GET', `/api/scout/book/${encodeURIComponent(fideId)}`),
  promoteScout: fideId => req('POST', `/api/scout/book/${encodeURIComponent(fideId)}/promote`, {}),
  scoutClash: (fideId, opts = {}) => req('GET', `/api/scout/book/${encodeURIComponent(fideId)}/clash${opts.extend ? '?extend=1' : ''}`),
  narrateClash: fideId => req('POST', `/api/scout/book/${encodeURIComponent(fideId)}/clash/narrate`, {}),
  players: () => req('GET', '/api/players'),
  fideSearch: name => req('GET', `/api/fide/search?name=${encodeURIComponent(name)}`),
  linkPlayer: ({ fideId, name, fideName, federation, verify }) => req('POST', '/api/players/link', { fideId, name, fideName, federation, verify }),
  patterns: () => req('GET', '/api/patterns'),
  synthesizePattern: pattern => req('POST', '/api/patterns/synthesize', { pattern }),
  puzzles: ({ source = 'tactics', limit = 30 } = {}) =>
    req('GET', `/api/puzzles?source=${encodeURIComponent(source)}&limit=${limit}`),
  drills: ({ pattern = null, category = null, limit = null, session = false } = {}) =>
    req('GET', `/api/drills?limit=${limit || 20}${pattern ? `&pattern=${encodeURIComponent(pattern)}` : ''}${category ? `&category=${encodeURIComponent(category)}` : ''}${session ? '&session=1' : ''}`),
  reviewDrill: noopForVisitor((id, grade, correct, practice = false, ms = null) =>
    req('POST', `/api/drills/${encodeURIComponent(id)}/review`, { grade, correct, practice, ...(ms != null ? { ms } : {}) })),
  suspendDrill: noopForVisitor((id, suspended = true) => req('POST', `/api/drills/${encodeURIComponent(id)}/suspend`, { suspended })),
  undoDrill: noopForVisitor(id => req('POST', `/api/drills/${encodeURIComponent(id)}/undo`, {})),
  restoreSuspended: noopForVisitor(() => req('POST', '/api/drills/restore-suspended', {})),
  recordDecoy: noopForVisitor(correct => req('POST', '/api/drills/decoy', { correct })),
  feedback: noopForVisitor((id, ply, helpful) => req('POST', `/api/games/${id}/moments/${ply}/feedback`, { helpful })),
  reexplain: (id, ply) => req('POST', `/api/games/${id}/moments/${ply}/reexplain`, {}),
  playoutMove: (fen, elo) => req('POST', '/api/playout/move', { fen, elo }),
  playoutAssess: fen => req('POST', '/api/playout/assess', { fen }),
  card: async () => {
    let res;
    try { res = await fetch('/api/report/card'); }
    catch { const err = new Error('Cannot reach the server. Is it running (npm start)?'); err.offline = true; throw err; }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'card generation failed');
    return res.text();
  },
};

// Chess math shared with the server (one definition, no sync hazard).
export { winProb, formatEval, WP_ACCEPT } from './shared.js';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Seconds -> "m:ss". */
export function fmtClock(s) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "12." for White moves, "12..." for Black. */
export function movePrefix(m) {
  return `${m.moveNumber}${m.color === 'white' ? '.' : '...'}`;
}

export function moveLabel(m) {
  return `${movePrefix(m)} ${m.san}`;
}

export const JUDGE_MARK = { blunder: '??', mistake: '?', inaccuracy: '?!', good: '', best: '' };

let toastTimer;
export function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3000);
}
