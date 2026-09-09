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

/** Password overlay for the hosted copy; shown on any 401. */
export function showLogin() {
  if (document.getElementById('login-overlay')) return;
  const div = document.createElement('div');
  div.id = 'login-overlay';
  div.style.cssText = 'position:fixed;inset:0;background:rgba(10,10,14,.92);display:flex;align-items:center;justify-content:center;z-index:100';
  div.innerHTML = `<form style="display:flex;flex-direction:column;gap:10px;align-items:center">
    <div style="font-size:42px">♞</div>
    <input type="password" id="login-pw" placeholder="Password" autocomplete="current-password" style="padding:8px 10px;font-size:16px">
    <button class="primary" style="padding:8px 18px">Enter</button>
    <p id="login-err" style="color:#e66;min-height:1em;margin:0"></p>
  </form>`;
  document.body.appendChild(div);
  const input = div.querySelector('#login-pw');
  input.focus();
  div.querySelector('form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await req('POST', '/api/login', { password: input.value });
      location.reload();
    } catch (err) { div.querySelector('#login-err').textContent = err.message; }
  });
}

export const api = {
  status: () => req('GET', '/api/status'),
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
  analyseAll: () => req('POST', '/api/games/analyse-all', {}),
  prompt: (id, ply) => req('GET', `/api/games/${id}/moments/${ply}/prompt`),
  saveExplanation: (id, ply, e) => req('PUT', `/api/games/${id}/moments/${ply}/explanation`, e),
  guess: (id, ply, uci, correct) => req('POST', `/api/games/${id}/moments/${ply}/guess`, { uci, correct }),
  evalMove: (id, ply, uci) => req('POST', `/api/games/${id}/moments/${ply}/eval`, { uci }),
  testHosts: () => req('POST', '/api/engine/hosts/test', {}),
  jobs: () => req('GET', '/api/jobs'),
  report: () => req('GET', '/api/report'),
  repertoire: () => req('GET', '/api/repertoire'),
  scoutSubjects: () => req('GET', '/api/scout'),
  scout: subject => req('GET', `/api/scout/${encodeURIComponent(subject)}`),
  prepSheet: subject => req('POST', `/api/scout/${encodeURIComponent(subject)}/prepsheet`),
  scoutImport: ({ pgn, fideId, name, filename }) => req('POST', '/api/scout/import', { pgn, fideId, name, filename }),
  scoutBook: fideId => req('GET', `/api/scout/book/${encodeURIComponent(fideId)}`),
  promoteScout: fideId => req('POST', `/api/scout/book/${encodeURIComponent(fideId)}/promote`, {}),
  patterns: () => req('GET', '/api/patterns'),
  synthesizePattern: pattern => req('POST', '/api/patterns/synthesize', { pattern }),
  puzzles: ({ source = 'tactics', limit = 30 } = {}) =>
    req('GET', `/api/puzzles?source=${encodeURIComponent(source)}&limit=${limit}`),
  drills: ({ pattern = null, category = null, limit = null, session = false } = {}) =>
    req('GET', `/api/drills?limit=${limit || 20}${pattern ? `&pattern=${encodeURIComponent(pattern)}` : ''}${category ? `&category=${encodeURIComponent(category)}` : ''}${session ? '&session=1' : ''}`),
  reviewDrill: (id, grade, correct, practice = false, ms = null) =>
    req('POST', `/api/drills/${encodeURIComponent(id)}/review`, { grade, correct, practice, ...(ms != null ? { ms } : {}) }),
  suspendDrill: (id, suspended = true) => req('POST', `/api/drills/${encodeURIComponent(id)}/suspend`, { suspended }),
  undoDrill: id => req('POST', `/api/drills/${encodeURIComponent(id)}/undo`, {}),
  restoreSuspended: () => req('POST', '/api/drills/restore-suspended', {}),
  recordDecoy: correct => req('POST', '/api/drills/decoy', { correct }),
  feedback: (id, ply, helpful) => req('POST', `/api/games/${id}/moments/${ply}/feedback`, { helpful }),
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
