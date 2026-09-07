// Thin fetch wrapper for the local JSON API.
async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${url} failed (${res.status})`);
  return data;
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
  analyse: (id, force = false) => req('POST', `/api/games/${id}/analyse`, { force }),
  explain: id => req('POST', `/api/games/${id}/explain`, {}),
  analyseAll: () => req('POST', '/api/games/analyse-all', {}),
  prompt: (id, ply) => req('GET', `/api/games/${id}/moments/${ply}/prompt`),
  saveExplanation: (id, ply, e) => req('PUT', `/api/games/${id}/moments/${ply}/explanation`, e),
  guess: (id, ply, uci, correct) => req('POST', `/api/games/${id}/moments/${ply}/guess`, { uci, correct }),
  evalMove: (id, ply, uci) => req('POST', `/api/games/${id}/moments/${ply}/eval`, { uci }),
  jobs: () => req('GET', '/api/jobs'),
  report: () => req('GET', '/api/report'),
  repertoire: () => req('GET', '/api/repertoire'),
  scoutSubjects: () => req('GET', '/api/scout'),
  scout: subject => req('GET', `/api/scout/${encodeURIComponent(subject)}`),
  prepSheet: subject => req('POST', `/api/scout/${encodeURIComponent(subject)}/prepsheet`),
  patterns: () => req('GET', '/api/patterns'),
  synthesizePattern: pattern => req('POST', '/api/patterns/synthesize', { pattern }),
  drills: () => req('GET', '/api/drills'),
  reviewDrill: (id, grade, correct) => req('POST', `/api/drills/${encodeURIComponent(id)}/review`, { grade, correct }),
};

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatEval(cp) {
  if (cp == null) return '';
  if (Math.abs(cp) >= 9800) return (cp > 0 ? '#' : '#-') + (10000 - Math.abs(cp));
  return (cp >= 0 ? '+' : '') + (cp / 100).toFixed(2);
}

export function moveLabel(m) {
  return `${m.moveNumber}${m.color === 'white' ? '.' : '...'} ${m.san}`;
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
