// Home dashboard: the daily prescription. Reuses the report, drills, and games
// endpoints (no new backend), so a player lands on "what to do now" instead of
// the import/admin surface.
import { api, esc, session } from '../api.js';
import { lineChart } from '../charts.js';
import { CATEGORY_LABEL } from '../labels.js';

const iso = d => d.toISOString().slice(0, 10);

/** Consecutive days up to today (or yesterday) with at least one review or
 * guess, from the sorted activity dates the report provides. */
function currentStreak(dates) {
  const set = new Set(dates || []);
  const d = new Date();
  if (!set.has(iso(d))) d.setDate(d.getDate() - 1); // an untrained morning is not a broken streak yet
  let streak = 0;
  while (set.has(iso(d))) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}

export async function homeView(root) {
  const [{ report: r }, drills, gamesRes, { upcoming }] = await Promise.all([
    api.report().catch(() => ({ report: null })),
    api.drills().catch(() => ({})),
    api.games().catch(() => ({ games: [] })),
    api.upcoming().catch(() => ({ upcoming: [] })),
  ]);
  const games = gamesRes.games || [];
  const due = drills.dueCount || 0;
  // The next game, with how far its prep has come.
  const nextGame = (upcoming || []).find(u => !u.date || u.date.slice(0, 10) >= iso(new Date())) || (upcoming || [])[0];
  const nextPrep = nextGame ? await api.prep(nextGame.subject, nextGame.color, nextGame.timeControl).then(x => x.prep).catch(() => null) : null;
  const nextLine = nextGame ? `<div class="card" style="margin-top: 16px; border-left: 3px solid var(--accent)">
      <div class="row" style="gap: 12px; flex-wrap: wrap; align-items: center">
        <b>Next game:</b> <span>${esc(nextGame.subject)}, you as <span class="chip ${nextGame.color}">${nextGame.color}</span>${nextGame.date ? `, ${esc(nextGame.date)}` : ''}${nextGame.round ? ` (round ${esc(nextGame.round)})` : ''}</span>
        ${nextPrep ? `<span class="muted">prep deck ${nextPrep.progress.done} of ${nextPrep.progress.total} done${nextPrep.sheet ? '' : ', no sheet yet'}</span>` : ''}
        <a class="btn small primary" href="#/prep/${encodeURIComponent(nextGame.subject)}?color=${nextGame.color}${nextGame.timeControl && nextGame.timeControl !== 'all' ? `&tc=${nextGame.timeControl}` : ''}">Prepare ▸</a>
      </div></div>` : '';

  if (!games.length) {
    const isAdmin = session.user?.role === 'admin' || !session.authActive;
    root.innerHTML = `<h1>Home</h1>${nextLine}<div class="card" style="margin-top: 16px"><p>${isAdmin
      ? 'No games yet. Import a PGN on the <a href="#/games">Games</a> page, and set the player name in <a href="#/settings">Settings</a> so imported games get the right colour.'
      : 'No games of yours yet. Ask the admin to import your PGNs or seed your games from your FIDE book; the <a href="#/scout">Players</a> page works meanwhile.'}</p></div>`;
    return;
  }

  const focus = r ? ((r.focus || []).find(f => (f.trend || 0) > 0.1) || (r.focus || [])[0]) : null;
  const recent = games.find(g => g.status === 'analysed' || g.status === 'explained');
  const streak = currentStreak(r?.activity);
  const hasTrend = r && (r.timeline || []).length >= 2;

  root.innerHTML = `
    <h1>Home</h1>
    ${nextLine}
    <div class="tiles" style="margin-top: 16px">
      <div class="tile"><div class="v">${due}</div><div class="l">Drills due</div></div>
      <div class="tile"><div class="v">${r?.overallAccuracy ?? '–'}${r?.overallAccuracy != null ? '%' : ''}</div><div class="l">Average accuracy</div></div>
      <div class="tile"><div class="v">${streak}</div><div class="l">Day streak</div></div>
      <div class="tile"><div class="v">${r?.games ?? 0}</div><div class="l">Games analysed</div></div>
    </div>
    <div class="card" style="margin-top: 16px">
      <div class="row" style="gap: 12px; flex-wrap: wrap; align-items: center">
        <button class="primary" id="start-session">${due ? `Start today's session (${due} due)` : 'Practice (nothing due)'}</button>
        ${focus ? `<span class="muted">Focus: <b>${esc(CATEGORY_LABEL[focus.category] || focus.category)}</b>${focus.trend > 0.1 ? ' <span style="color: var(--critical)">(getting worse)</span>' : focus.trend < -0.1 ? ' <span style="color: var(--good, green)">(improving)</span>' : ''} · <a href="#/drills?category=${encodeURIComponent(focus.category)}">drill it ▸</a></span>` : ''}
        ${recent ? `<span class="muted">Latest: <a href="#/game/${recent.id}">${esc(recent.white)} vs ${esc(recent.black)}</a></span>` : ''}
      </div>
      ${streak ? `<p class="muted" style="margin: 8px 0 0">${streak} day${streak === 1 ? '' : 's'} in a row. Keep it going.</p>` : '<p class="muted" style="margin: 8px 0 0">A few drills today starts a streak.</p>'}
    </div>
    ${hasTrend ? `<div class="card" style="margin-top: 16px"><h3 style="margin-top:0">Accuracy trend</h3><div id="home-trend"></div><small>Click a point to open the game. Full breakdown on the <a href="#/report">report</a>.</small></div>` : ''}
  `;

  root.querySelector('#start-session').onclick = () => { location.hash = '#/drills'; };

  if (hasTrend) {
    lineChart(root.querySelector('#home-trend'), r.timeline.map(t => ({ x: t.date ? t.date.slice(2) : '?', y: t.accuracy, sub: `${t.label} (${t.result})`, gameId: t.gameId })), {
      yMin: Math.min(50, ...r.timeline.map(t => Math.floor(t.accuracy / 10) * 10)),
      yMax: 100, format: v => v + '%', onClick: p => { location.hash = `#/game/${p.gameId}`; },
    });
  }
}
