// Hash router, job polling, and shared chrome.
import { api, esc, toast, session, showLogin, setViewAs, flushReviews } from './api.js';
import { homeView } from './views/home.js';
import { gamesView } from './views/games.js';
import { gameView } from './views/game.js';
import { reviewView } from './views/review.js';
import { scoutView } from './views/scout.js';
import { drillsView } from './views/drills.js';
import { puzzlesView } from './views/puzzles.js';
import { settingsView } from './views/settings.js';
import { logView } from './views/log.js';
import { adminView } from './views/admin.js';
import { prepView } from './views/prep.js';

const app = document.getElementById('app');
let current = null; // { name, destroy }

const routes = [
  { re: /^#\/home$/, name: 'home', view: homeView },
  { re: /^#\/games$/, name: 'games', view: gamesView },
  { re: /^#\/game\/([a-f0-9]{12})(?:\/(\d+))?$/, name: 'games', view: gameView },
  { re: /^#\/report$/, name: 'report', view: reviewView },
  { re: /^#\/repertoire$/, name: 'report', view: reviewView }, // repertoire now lives in the Report page accordion
  { re: /^#\/scout(?:\/(.*))?$/, name: 'scout', view: scoutView },
  { re: /^#\/prep\/([^?]+)(?:\?(.*))?$/, name: 'scout', view: prepView }, // prepare for a game: one opponent, one colour
  { re: /^#\/drills(?:\?(.*))?$/, name: 'puzzles', view: drillsView }, // drills live under Puzzles now; highlight that tab
  { re: /^#\/puzzles(?:\?(.*))?$/, name: 'puzzles', view: puzzlesView }, // optional query: ?source=tactics|moments|missed
  { re: /^#\/settings$/, name: 'settings', view: settingsView },
  { re: /^#\/log$/, name: 'log', view: logView }, // admin-only activity log
  { re: /^#\/admin$/, name: 'admin', view: adminView }, // admin-only roster management
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
  if ((r.name === 'log' || r.name === 'admin') && session.user?.role !== 'admin') { location.hash = session.user?.role === 'visitor' ? '#/scout' : '#/home'; return; }
  const params = hash.match(r.re).slice(1);
  if (current?.destroy) current.destroy();
  current = null;
  document.querySelectorAll('[data-nav]').forEach(a => {
    const isCurrent = a.dataset.nav === r.name;
    a.classList.toggle('active', isCurrent);
    if (isCurrent) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  // Each view renders into its own element: a slow view that resolves after the
  // user has moved on writes into a detached node, never over the newer page.
  const host = document.createElement('div');
  host.innerHTML = '<div class="empty">Loading…</div>';
  app.replaceChildren(host);
  try {
    const view = await r.view(host, ...params) || {};
    if (token !== nav) { view.destroy?.(); return; }
    current = view;
  } catch (err) {
    if (token !== nav) return;
    if (err.handled) return; // e.g. a 401 already raised the login overlay
    if (err.offline) {
      host.innerHTML = `<div class="card"><b>Cannot reach the server.</b> ${esc(err.message)} <button class="small" id="retry-route">Retry</button></div>`;
      host.querySelector('#retry-route').onclick = () => route();
    } else {
      host.innerHTML = `<div class="card"><b>Error:</b> ${esc(err.message)}</div>`;
    }
    console.error(err);
  }
}

window.addEventListener('hashchange', route);
// The first route() waits for /api/auth/me (below): routing before the role is
// known would start rendering Home for a visitor, and the slow Home view would
// then clobber the Scouting page the visitor redirect had already rendered.

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
  const u = me.user;
  const name = u.name || u.displayName || u.id;
  const roleTag = u.role === 'admin' ? 'admin' : u.role === 'visitor' ? 'visitor' : '';
  const avatar = u.picture
    ? `<img class="avatar" src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer">`
    : `<span class="avatar avatar-initials">${esc((name[0] || '?').toUpperCase())}</span>`;
  let theme = 'auto'; try { theme = localStorage.getItem('theme') || 'auto'; } catch {}
  const opt = (val, label) => `<button class="small theme-opt${theme === val ? ' primary' : ''}" data-theme-set="${val}">${label}</button>`;
  el.innerHTML = `<div class="whoami-wrap">
    <button id="whoami-btn" aria-haspopup="true" aria-expanded="false" aria-controls="whoami-menu" title="${esc(name)}${roleTag ? ` (${roleTag})` : ''}">${avatar}<span class="who">${esc(name)}</span></button>
    <div id="whoami-menu" class="hidden" role="menu" aria-label="Account menu">
      <div class="menu-head">${esc(name)}${roleTag ? ` <span class="chip">${roleTag}</span>` : ''}</div>
      <div class="menu-label">Page theme</div>
      <div class="menu-row">${opt('auto', 'Auto')}${opt('light', 'Light')}${opt('dark', 'Dark')}</div>
      ${u.role === 'admin' ? `<div class="menu-label">Viewing as</div>
      <div class="menu-row"><select id="view-as" aria-label="View the app as a member"><option value="">Myself</option></select></div>
      <div class="menu-label"><small>Read-only: reports, drills, and prep of that member, as they see them.</small></div>` : ''}
      <button class="link" id="logout-btn">Sign out</button>
    </div>
  </div>`;
  const viewAs = el.querySelector('#view-as');
  if (viewAs) {
    // The admin can check any member's report, drills, and prep: the GET calls
    // carry ?user=<id> (writes never do). Remembered for the tab.
    api.members().then(({ members = [] }) => {
      for (const m of members) {
        if (m.role === 'visitor') continue;
        const o = document.createElement('option');
        o.value = m.id; o.textContent = m.displayName || m.id;
        if (session.viewAs === m.id) o.selected = true;
        viewAs.appendChild(o);
      }
    }).catch(() => {});
    viewAs.onchange = () => {
      setViewAs(viewAs.value || null);
      closeMenu();
      route();
      updateDrillBadge();
    };
  }
  const menu = el.querySelector('#whoami-menu');
  const btn = el.querySelector('#whoami-btn');
  const closeMenu = ({ restoreFocus = false } = {}) => {
    if (menu.classList.contains('hidden')) return;
    menu.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
    if (restoreFocus) btn.focus();
  };
  btn.onclick = e => {
    e.stopPropagation();
    const willOpen = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !willOpen);
    btn.setAttribute('aria-expanded', String(willOpen));
  };
  document.addEventListener('click', e => { if (!el.contains(e.target)) closeMenu(); });
  menu.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu({ restoreFocus: true }); } });
  el.querySelectorAll('[data-theme-set]').forEach(b => b.onclick = () => {
    const val = b.dataset.themeSet;
    try { localStorage.setItem('theme', val); } catch {}
    if (val === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', val);
    el.querySelectorAll('[data-theme-set]').forEach(x => x.classList.toggle('primary', x === b));
  });
  el.querySelector('#logout-btn').onclick = async () => { try { await api.logout(); } catch {} location.reload(); };
}

// Identity + chrome. /api/auth/me is exempt from the auth gate, so it answers
// even when nobody is signed in (user: null). Gate the whole app on it, mark the
// admin body class (CSS hides .admin-only controls for members), then set up
// chrome. The hosted mirror cannot run jobs (the queue lives in a function
// instance's memory), so job polling and the Settings link stay off there.
// Offline drills: the worker keeps the app shell and the last drill deck.
// Registered on https and localhost only (a worker needs a secure context).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

Promise.all([api.me().catch(() => ({})), api.status().catch(() => ({}))]).then(([me, status]) => {
  session.user = me.user || null;
  session.authActive = !!me.authActive;
  session.providers = me.providers || {};
  document.body.classList.toggle('is-admin', me.user?.role === 'admin');
  document.body.classList.toggle('is-visitor', me.user?.role === 'visitor');
  if (me.authActive && !me.user) { showLogin(); return; } // not signed in: the overlay covers the app
  // First route, now that the role is known. route() itself lands visitors on
  // Scouting (their landing page) and bounces them off pages they cannot see.
  route();
  renderWhoami(me);
  updateDrillBadge();
  // Reviews graded offline (a tournament hall): replay them now and whenever
  // the connection comes back. Registered here, after session.user is set, so
  // the queue is read under the right user's key.
  const syncReviews = () => flushReviews().then(({ synced }) => {
    if (synced) { toast(`${synced} offline review${synced === 1 ? '' : 's'} synced`); updateDrillBadge(); }
  }).catch(() => {});
  syncReviews();
  window.addEventListener('online', syncReviews);
  // The activity log is admin-only; reveal its nav link for an admin. It works on
  // the hosted mirror too, where /api/audit reads the shared Supabase-backed log.
  if (me.user?.role === 'admin') document.querySelector('[data-nav="log"]')?.removeAttribute('hidden');
  if (status.readonly) {
    window.addEventListener('hashchange', updateDrillBadge);
  } else {
    // Settings and Admin are admin-only and producer-only (they write); the nav
    // links ship hidden, revealed here for an admin on the analysing machine.
    if (me.user?.role === 'admin') { document.querySelector('[data-nav="settings"]')?.removeAttribute('hidden'); document.querySelector('[data-nav="admin"]')?.removeAttribute('hidden'); }
    pollJobs();
    setInterval(updateDrillBadge, 60000);
    jobEvents.addEventListener('finished', updateDrillBadge);
  }
}).catch(err => { console.error(err); route(); }); // still render something if startup chrome fails
