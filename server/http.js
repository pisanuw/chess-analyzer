// Request helpers shared by every route module: the read-only flag, the async
// route wrapper, and the identity and role gates.
import { DEFAULT_USER } from './store.js';
import { currentUser, authActive } from './auth.js';
import { getUser, isVisitor } from './users.js';
import { logEvent, eventIp } from './audit.js';

// Read-only mirror (hosted copy): game data is managed on the analysing machine
// and published; only training state (drill reviews, guesses) is writable.
export const READONLY = !!process.env.READONLY_DATA;

export const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  const status = err.status || 500;
  // A raw Node system error (fs, network: ENOENT, EACCES, ECONNREFUSED, ...)
  // carries internal detail (a path, a host) in its message; a deliberately
  // thrown `Error('...')` is a message the developer wrote for this exact
  // situation and is usually actionable ("Stockfish not found..."), so only
  // the former gets sanitized. `err.code` is how Node marks the former; a
  // plain `new Error(...)` never sets it.
  const message = err.code && status === 500 ? 'Internal server error' : err.message;
  res.status(status).json({ error: message });
});

// Best-effort, in-memory throttle on the "viewing as" audit entry below: a
// single report/drills/prep page fires several GETs, and the badge and job
// poller repeat every request on an interval, so logging every one of them
// would drown the admin-mutation log (capped at 500 events) in traffic for a
// single browsing session. One entry per admin/target pair per window is
// enough to show that it happened.
const impersonationLogged = new Map(); // `${adminId}:${targetId}` -> last-logged ms
const IMPERSONATION_LOG_WINDOW_MS = 15 * 60 * 1000;
function shouldLogImpersonation(adminId, targetId) {
  const key = `${adminId}:${targetId}`;
  const last = impersonationLogged.get(key) || 0;
  if (Date.now() - last < IMPERSONATION_LOG_WINDOW_MS) return false;
  impersonationLogged.set(key, Date.now());
  return true;
}

// The member whose private data a request acts on (report, repertoire, games,
// drills, puzzles, pattern notes). A member is locked to themselves; an admin
// (or the local operator, when auth is off) may target any member via ?user=,
// defaulting to the primary member. Scout data is shared, so it ignores this.
export async function effectiveUser(req) {
  const u = await currentUser(req);
  if (!u && authActive()) { const err = new Error('auth required'); err.status = 401; throw err; }
  if (u && u.role !== 'admin') return u.id;
  const q = typeof req.query.user === 'string' ? req.query.user : '';
  if (!q || !u) return DEFAULT_USER;
  const target = await getUser(q);
  if (!target) return DEFAULT_USER;
  // Viewing as oneself is not impersonation; requireAdmin logs mutations
  // separately, so this only covers the read side (?user= is GET-only).
  if (target.id !== u.id && shouldLogImpersonation(u.id, target.id)) {
    logEvent({ action: 'view-as', userId: u.id, name: u.displayName, role: u.role, ip: eventIp(req), detail: `viewing as ${target.displayName || target.id}` });
  }
  return target.id;
}

// Gate for management routes (import, analysis, settings, users, scouting
// imports): only an admin or the local operator may pass.
export async function requireAdmin(req, res) {
  const u = await currentUser(req);
  if (u && u.role === 'admin') {
    // Record every admin mutation for the activity log (reads like GET are skipped).
    if (req.method !== 'GET') logEvent({ action: `${req.method} ${req.path}`, userId: u.id, name: u.displayName, role: u.role, ip: eventIp(req) });
    return true;
  }
  res.status(403).json({ error: 'admin only' });
  return false;
}

// Visitors (allowlisted guests) can browse the shared scouting library and
// practice drills/puzzles, but see no report or repertoire and record nothing.
// Returns true (and sends 403) when the caller is a visitor.
export async function blockVisitor(req, res) {
  if (isVisitor(await currentUser(req))) { res.status(403).json({ error: 'not available to visitors' }); return true; }
  return false;
}

// A visitor records nothing: the training-write routes no-op for them (their
// practice is ephemeral). The frontend also skips these calls for visitors.
export async function visitorNoop(req, res) {
  if (isVisitor(await currentUser(req))) { res.json({ ok: true, ephemeral: true }); return true; }
  return false;
}

// The rating the coach assumes for the person preparing (prep sheets, clash
// narration, pattern synthesis): their roster rating, else the global setting.
export async function studentRating(req, settings) {
  const u = await getUser(await effectiveUser(req)).catch(() => null);
  return u?.rating || settings.playerRating;
}

// Recency/rating knobs that bound which of an opponent's games still describe
// the player you will face. Shared by the dossier view and promotion.
export const dossierOpts = (settings, timeControl = 'all') => ({
  maxAgeYears: settings.scoutMaxAgeYears, eloBand: settings.scoutEloBand,
  halfLifeDays: settings.scoutHalfLifeDays, analyseCount: settings.scoutAnalyseCount,
  timeControl: ['classical', 'rapid', 'blitz'].includes(timeControl) ? timeControl : 'all',
});
