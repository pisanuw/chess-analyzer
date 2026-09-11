// Hash router, job polling, and shared chrome.
import { api, esc, toast, session, showLogin } from './api.js';
import { homeView } from './views/home.js';
import { gamesView } from './views/games.js';
import { gameView } from './views/game.js';
import { reviewView } from './views/review.js';
import { scoutView } from './views/scout.js';
import { drillsView } from './views/drills.js';
import { puzzlesView } from './views/puzzles.js';
import { settingsView } from './views/settings.js';

const app = document.getElementById('app');
let current = null; // { name, destroy }

const routes = [
  { re: /^#\/home$/, name: 'home', view: homeView },
  { re: /^#\/games$/, name: 'games', view: gamesView },
  { re: /^#\/game\/([a-f0-9]{12})(?:\/(\d+))?$/, name: 'games', view: gameView },
  { re: /^#\/report$/, name: 'report', view: reviewView },
  { re: /^#\/repertoire$/, name: 'report', view: reviewView }, // repertoire now lives in the Report page accordion
  { re: /^#\/scout(?:\/(.*))?$/, name: 'scout', view: scoutView },
  { re: /^#\/drills(?:\?(.*))?$/, name: 'puzzles', view: drillsView }, // drills live under Puzzles now; highlight that tab
  { re: /^#\/puzzles(?:\?(.*))?$/, name: 'puzzles', view: puzzlesView }, // optional query: ?source=tactics|moments|missed
  { re: /^#\/settings$/, name: 'settings', view: settingsView },
];

// Pages a visitor cannot see (no report/repertoire, no games management). They
// are redirected to Scouting, which is their landing page.
const VISITOR_BLOCKED = new Set(['home', 'games', 'report', 'repertoire', 'settings']);

let nav = 0; // navigation token: a stale async view must not clobber a newer one

async function route() {
  const token = ++nav;
  const hash = location.hash || '#/home';
  const r = routes.find(x => x.re.test(hash));
  if (!r) { location.hash = '#/home'; return; }
  if (session.user?.role === 'visitor' && VISITOR_BLOCKED.has(r.name)) { location.hash = '#/scout'; return; }
  const params = hash.match(r.re).slice(1);
  if (current?.destroy) current.destroy();
  current = null;
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === r.name));
  app.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const view = await r.view(app, ...params) || {};
    if (token !== nav) { view.destroy?.(); return; }
    current = view;
  } catch (err) {
    if (token !== nav) return;
    if (err.handled) return; // e.g. a 401 already raised the login overlay
    if (err.offline) {
      app.innerHTML = `<div class="card"><b>Cannot reach the server.</b> ${esc(err.message)} <button class="small" id="retry-route">Retry</button></div>`;
      app.querySelector('#retry-route').onclick = () => route();
    } else {
      app.innerHTML = `<div class="card"><b>Error:</b> ${esc(err.message)}</div>`;
    }
    console.error(err);
  }
}

window.addEventListener('hashchange', route);
route();

// --- job polling ---------------------------------------------------------------
const jobsEl = document.getElementById('jobs');
let lastActive = new Set();
export const jobEvents = new EventTarget();

async function pollJobs() {
  try {
    const { jobs } = await api.jobs();
    const active = jobs.filter(j => j.status === 'running' || j.status === 'queued');
    const running = active.filter(j => j.status === 'running');
    jobsEl.innerHTML = running.map(j => {
      // Sub-position detail so slow searches don't look like a stall: current
      // engine depth while analysing, elapsed seconds on the current explanation.
      const detail = j.stage === 'explain'
        ? (j.itemStartedAt ? ` · ${Math.max(0, Math.round((Date.now() - Date.parse(j.itemStartedAt)) / 1000))}s` : '')
        : (j.depth ? ` · depth ${j.depth}/${j.depthTarget || '?'}` : (j.engines > 1 ? ` · ${j.engines} engines` : ''));
      const frac = j.total ? (j.progress + (j.depth && j.depthTarget ? Math.min(1, j.depth / j.depthTarget) : 0)) / j.total : 0;
      return `
      <span class="job" title="${esc(j.kind)} ${esc(j.gameId)}${j.warning ? ': ' + esc(j.warning) : ''}">
        ${j.warning ? '⚠ ' : ''}${j.stage === 'explain' ? 'Explaining' : 'Analysing'} ${j.total ? `${j.progress}/${j.total}` : ''}${detail}
        <span class="bar"><i style="width:${Math.round(frac * 100)}%"></i></span>
      </span>`;
    }).join('') + (active.length > running.length ? `<span class="muted">${active.length - running.length} queued</span>` : '');
    const nowActive = new Set(active.map(j => j.id));
    const finished = [...lastActive].filter(id => !nowActive.has(id));
    if (finished.length) {
      const failed = jobs.filter(j => finished.includes(j.id) && j.status === 'failed');
      for (const f of failed) toast(`Job failed: ${f.error}`, true);
      // Announce successful completions anywhere in the app, not just on the
      // Games list, so a batch import that finishes while you are elsewhere is
      // not silent.
      const done = jobs.filter(j => finished.includes(j.id) && j.status === 'done');
      const analysed = done.filter(j => j.kind === 'analyse').length;
      const explained = done.filter(j => j.kind === 'explain').length;
      const parts = [analysed && `${analysed} analysed`, explained && `${explained} explained`].filter(Boolean);
      if (parts.length) toast(`Ready: ${parts.join(', ')}`);
      jobEvents.dispatchEvent(new CustomEvent('finished', { detail: jobs.filter(j => finished.includes(j.id)) }));
    }
    lastActive = nowActive;
    setTimeout(pollJobs, active.length ? 1500 : 5000);
  } catch {
    setTimeout(pollJobs, 5000);
  }
}

export async function updateDrillBadge() {
  try {
    const { dueCount } = await api.drills();
    const b = document.getElementById('drill-badge');
    b.textContent = dueCount;
    b.hidden = !dueCount;
  } catch {}
}

function renderWhoami(me) {
  const el = document.getElementById('whoami');
  if (!el) return;
  if (!me.authActive || !me.user) { el.hidden = true; return; } // no login configured: nothing to show
  el.hidden = false;
  el.innerHTML = `<span class="who">${esc(me.user.displayName || me.user.id)}</span>${me.user.role === 'admin' ? ' <span class="chip">admin</span>' : ''} <button class="link" id="logout-btn">Sign out</button>`;
  el.querySelector('#logout-btn').onclick = async () => { try { await api.logout(); } catch {} location.reload(); };
}

// Identity + chrome. /api/auth/me is exempt from the auth gate, so it answers
// even when nobody is signed in (user: null). Gate the whole app on it, mark the
// admin body class (CSS hides .admin-only controls for members), then set up
// chrome. The hosted mirror cannot run jobs (the queue lives in a function
// instance's memory), so job polling and the Settings link stay off there.
Promise.all([api.me().catch(() => ({})), api.status().catch(() => ({}))]).then(([me, status]) => {
  session.user = me.user || null;
  session.authActive = !!me.authActive;
  session.providers = me.providers || {};
  document.body.classList.toggle('is-admin', me.user?.role === 'admin');
  document.body.classList.toggle('is-visitor', me.user?.role === 'visitor');
  if (me.authActive && !me.user) { showLogin(); return; } // not signed in: the overlay covers the app
  // Visitors land on Scouting; bounce them off any page they cannot see.
  if (me.user?.role === 'visitor') { const r = routes.find(x => x.re.test(location.hash || '#/home')); if (!r || VISITOR_BLOCKED.has(r.name)) location.hash = '#/scout'; }
  renderWhoami(me);
  updateDrillBadge();
  if (status.readonly) {
    window.addEventListener('hashchange', updateDrillBadge);
  } else {
    // Settings is admin-only; the nav link ships hidden, revealed here for an admin.
    if (me.user?.role === 'admin') document.querySelector('[data-nav="settings"]')?.removeAttribute('hidden');
    pollJobs();
    setInterval(updateDrillBadge, 60000);
    jobEvents.addEventListener('finished', updateDrillBadge);
  }
}).catch(() => {});
