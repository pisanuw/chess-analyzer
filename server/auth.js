// Single-password auth for the hosted copy. Active only when APP_PASSWORD is
// set; local use (no env var) is untouched. Cookie is HMAC-signed with a key
// derived from the password, so there is no separate secret to manage.
import crypto from 'node:crypto';
import { kvEnabled, kvGet, kvPut } from './store.js';
import { getUser, publicUser } from './users.js';
import { getProfile } from './profiles.js';
import { logEvent, eventIp } from './audit.js';

const DAY_S = 86400;
const COOKIE_DAYS = 90;
const WINDOW_MS = 3600000;   // brute-force window: attempts reset hourly
const MAX_ATTEMPTS = 20;     // failed logins per client per window
const attempts = new Map();  // ip -> { n, resetAt } : local + KV-failure fallback

const password = () => process.env.APP_PASSWORD || '';

/** The real client, not a client-supplied value. Netlify sets
 * x-nf-client-connection-ip to the peer and it cannot be forged through the
 * CDN; locally there is no proxy, so the socket address (req.ip) is the client.
 * X-Forwarded-For is deliberately ignored: with no configured trusted proxy its
 * hops are all client-supplied, and rotating them was the way to defeat the
 * per-IP limit entirely. */
function clientIp(req) {
  return String(req.headers['x-nf-client-connection-ip'] || req.ip || '?').trim();
}

// Each action class gets its own bucket per client: heavy legitimate use of
// one (prep-sheet requests from a shared office IP, say) must not lock out a
// login attempt from the same IP. `scope` names the action; unscoped callers
// (none left below) would have shared the 'login' bucket, kept as the default
// for that reason.
const throttleKey = (ip, scope) => `login-throttle:${scope}:${ip}`;

/** Count this attempt against the per-client, per-scope window and report
 * whether it is allowed. On the hosted copy the counter lives in Supabase so
 * it binds across the (otherwise memory-isolated) serverless instances;
 * locally, and whenever the store is unreachable, an in-process Map is used
 * so a storage hiccup can never lock a legitimate user out. */
async function allowAttempt(ip, now, scope = 'login') {
  const key = throttleKey(ip, scope);
  if (kvEnabled()) {
    try {
      const cur = await kvGet(key);
      let n = cur?.n || 0;
      let resetAt = cur?.resetAt || now + WINDOW_MS;
      if (now > resetAt) { n = 0; resetAt = now + WINDOW_MS; }
      if (n >= MAX_ATTEMPTS) return false;
      await kvPut(key, { n: n + 1, resetAt });
      return true;
    } catch { /* store down: fall through to the in-memory limiter */ }
  }
  const a = attempts.get(key) || { n: 0, resetAt: now + WINDOW_MS };
  if (now > a.resetAt) { a.n = 0; a.resetAt = now + WINDOW_MS; }
  if (a.n >= MAX_ATTEMPTS) return false;
  a.n++;
  attempts.set(key, a);
  return true;
}

/** Reset a client's window after a successful login. */
async function clearAttempts(ip, scope = 'login') {
  attempts.delete(throttleKey(ip, scope));
  if (kvEnabled()) { try { await kvPut(throttleKey(ip, scope), { n: 0, resetAt: Date.now() + WINDOW_MS }); } catch {} }
}

/** Per-client rate limit, scoped per action class (password login has its own
 * call below; magic-link requests, prep-sheet email requests, and the
 * request-access form each pass their own `scope`) so one action's heavy use
 * cannot lock a client out of another. Counts this attempt against the hourly
 * window; false when over. */
export async function rateLimit(req, scope = 'login') {
  return allowAttempt(clientIp(req), Date.now(), scope);
}

const secret = () => crypto.createHash('sha256').update('cookie:' + password()).digest();
const hash = s => crypto.createHash('sha256').update(String(s)).digest();
const passwordOk = input => !!password() && crypto.timingSafeEqual(hash(input), hash(password()));

function sign(exp) {
  return `${exp}.${crypto.createHmac('sha256', secret()).update(String(exp)).digest('base64url')}`;
}

function verify(token) {
  const [exp, mac] = String(token || '').split('.');
  if (!exp || !mac) return false;
  const good = crypto.createHmac('sha256', secret()).update(exp).digest('base64url');
  try { if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return false; } catch { return false; }
  return Number(exp) > Date.now();
}

// --- per-user sessions -------------------------------------------------------
// A session cookie carries the member id, HMAC-signed with SESSION_SECRET (which
// falls back to APP_PASSWORD so the legacy single-password deployment keeps a
// stable signing key). Auth is only ENFORCED when one of those is set; a bare
// local run stays open (the operator is the admin). Google/magic-link flows
// (later phases) issue these sessions; here is the shared verify + cookie plumbing.
const SESSION_DAYS = 30;
const sessionSecret = () => crypto.createHash('sha256').update('session:' + (process.env.SESSION_SECRET || password())).digest();

export function authActive() {
  return !!(process.env.SESSION_SECRET || password());
}

export function createSessionToken(userId, exp = Date.now() + SESSION_DAYS * DAY_S * 1000) {
  const payload = `${userId}.${exp}`;
  return `${payload}.${crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url')}`;
}

/** Verify a session token: returns { userId, exp } or null. userIds contain no
 * dot (see users.js id rule), so a 3-part split is unambiguous. */
export function verifySessionToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [userId, exp, mac] = parts;
  const good = crypto.createHmac('sha256', sessionSecret()).update(`${userId}.${exp}`).digest('base64url');
  try { if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null; } catch { return null; }
  if (!(Number(exp) > Date.now())) return null;
  return { userId, exp: Number(exp) };
}

const cookieFlags = `Path=/; HttpOnly; SameSite=Lax; Secure`;
export function sessionCookie(token) { return `sess=${token}; ${cookieFlags}; Max-Age=${SESSION_DAYS * DAY_S}`; }
export function clearSessionCookie() { return `sess=; ${cookieFlags}; Max-Age=0`; }

const readCookie = (req, name) => ((req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)) || [])[1];

/** The legacy single-password path (bearer or the old `auth` cookie): still
 * accepted, and treated as an admin so an existing hosted deployment keeps full
 * access during the transition. */
function legacyOk(req) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (bearer && passwordOk(bearer)) return true;
  return verify(readCookie(req, 'auth'));
}

const isExempt = p => p === '/api/login' || p.startsWith('/api/auth/');

/** Gate /api/* when auth is active, accepting either a session cookie or the
 * legacy password. Attaches req.session (or null) and req.legacyAuthed for
 * routes and the identity resolver. Static assets and the auth endpoints pass
 * through. Kept synchronous: the roster lookup happens lazily in currentUser(). */
export function authMiddleware(req, res, next) {
  req.session = verifySessionToken(readCookie(req, 'sess'));
  req.legacyAuthed = legacyOk(req);
  if (!authActive() || !req.path.startsWith('/api/') || isExempt(req.path)) return next();
  if (req.session || req.legacyAuthed) return next();
  res.status(401).json({ error: 'auth required' });
}

/** A validly signed session whose user id is no longer on the roster (a removed
 * member, a renamed id) must not pass as anyone: without this it fell through
 * the admin branch of the route helpers and was served the default member's
 * data. Runs after authMiddleware, resolves the roster once per request (cached
 * on req.user for currentUser), and clears the dead cookie with the 401. */
export function knownSessionMiddleware(req, res, next) {
  if (!authActive() || !req.session?.userId || !req.path.startsWith('/api/') || isExempt(req.path)) return next();
  getUser(req.session.userId).then(u => {
    if (u) { req.user = u; return next(); }
    req.session = null;
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.status(401).json({ error: 'session is no longer valid, sign in again' });
  }).catch(next);
}

/** The acting user for a request: the session's allowlisted member, an admin for
 * a legacy password login or a bare local run, or null when auth is on and the
 * caller is unauthenticated (or holds a session for an unknown id). Reads the
 * roster, so it is async. */
export async function currentUser(req) {
  if (req.user) return req.user;
  if (req.session?.userId) {
    const u = await getUser(req.session.userId);
    if (u) req.user = u;
    return u;
  }
  if (req.legacyAuthed || !authActive()) return { id: 'admin', displayName: 'Admin', role: 'admin' };
  return null;
}

/** Who am I? Drives the frontend login gate; reachable unauthenticated. Also
 * advertises which login methods are configured so the login screen can show the
 * right buttons (env read inline to avoid importing the provider modules). */
export async function meRoute(req, res) {
  const u = await currentUser(req);
  const pub = publicUser(u);
  const profile = u ? await getProfile(u.id).catch(() => null) : null;
  res.json({
    user: pub ? { ...pub, name: profile?.name || null, picture: profile?.picture || null } : null,
    authActive: authActive(),
    providers: {
      google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      magic: !!process.env.RESEND_API_KEY,
    },
  });
}

/** Clear both the session cookie and the legacy password cookie. */
export function logoutRoute(req, res) {
  if (req.session?.userId) logEvent({ action: 'logout', userId: req.session.userId, ip: eventIp(req) });
  res.setHeader('Set-Cookie', [clearSessionCookie(), `auth=; ${cookieFlags}; Max-Age=0`]);
  res.json({ ok: true });
}

export async function loginRoute(req, res) {
  const ip = clientIp(req);
  if (!(await allowAttempt(ip, Date.now(), 'password'))) return res.status(429).json({ error: 'too many attempts, try again in an hour' });
  if (!passwordOk(req.body?.password)) return res.status(401).json({ error: 'wrong password' });
  await clearAttempts(ip, 'password');
  logEvent({ action: 'login', detail: 'password', userId: 'admin', ip });
  const exp = Date.now() + COOKIE_DAYS * DAY_S * 1000;
  res.setHeader('Set-Cookie', `auth=${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${COOKIE_DAYS * DAY_S}`);
  res.json({ ok: true });
}
