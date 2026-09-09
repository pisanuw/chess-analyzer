// Single-password auth for the hosted copy. Active only when APP_PASSWORD is
// set; local use (no env var) is untouched. Cookie is HMAC-signed with a key
// derived from the password, so there is no separate secret to manage.
import crypto from 'node:crypto';
import { kvEnabled, kvGet, kvPut } from './store.js';

const DAY_S = 86400;
const COOKIE_DAYS = 90;
const WINDOW_MS = 3600000;   // brute-force window: attempts reset hourly
const MAX_ATTEMPTS = 20;     // failed logins per client per window
const MIN_PASSWORD_LEN = 12; // the whole public wall is this one secret
const attempts = new Map();  // ip -> { n, resetAt } : local + KV-failure fallback

const password = () => process.env.APP_PASSWORD || '';

// A short password behind a single-secret public wall is the real risk once the
// rate limiter binds; warn loudly at startup so the operator can lengthen it.
if (password() && password().length < MIN_PASSWORD_LEN) {
  console.warn(`APP_PASSWORD is only ${password().length} characters; use at least ${MIN_PASSWORD_LEN} for the public login wall.`);
}

/** The real client, not a client-supplied value. Netlify sets
 * x-nf-client-connection-ip to the peer and it cannot be forged through the
 * CDN; locally there is no proxy, so the socket address (req.ip) is the client.
 * X-Forwarded-For is deliberately ignored: with no configured trusted proxy its
 * hops are all client-supplied, and rotating them was the way to defeat the
 * per-IP limit entirely. */
function clientIp(req) {
  return String(req.headers['x-nf-client-connection-ip'] || req.ip || '?').trim();
}

const throttleKey = ip => `login-throttle:${ip}`;

/** Count this attempt against the per-client window and report whether it is
 * allowed. On the hosted copy the counter lives in Supabase so it binds across
 * the (otherwise memory-isolated) serverless instances; locally, and whenever
 * the store is unreachable, an in-process Map is used so a storage hiccup can
 * never lock a legitimate user out. */
async function allowAttempt(ip, now) {
  if (kvEnabled()) {
    try {
      const cur = await kvGet(throttleKey(ip));
      let n = cur?.n || 0;
      let resetAt = cur?.resetAt || now + WINDOW_MS;
      if (now > resetAt) { n = 0; resetAt = now + WINDOW_MS; }
      if (n >= MAX_ATTEMPTS) return false;
      await kvPut(throttleKey(ip), { n: n + 1, resetAt });
      return true;
    } catch { /* store down: fall through to the in-memory limiter */ }
  }
  const a = attempts.get(ip) || { n: 0, resetAt: now + WINDOW_MS };
  if (now > a.resetAt) { a.n = 0; a.resetAt = now + WINDOW_MS; }
  if (a.n >= MAX_ATTEMPTS) return false;
  a.n++;
  attempts.set(ip, a);
  return true;
}

/** Reset a client's window after a successful login. */
async function clearAttempts(ip) {
  attempts.delete(ip);
  if (kvEnabled()) { try { await kvPut(throttleKey(ip), { n: 0, resetAt: Date.now() + WINDOW_MS }); } catch {} }
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

export function authMiddleware(req, res, next) {
  if (!password() || !req.path.startsWith('/api') || req.path === '/api/login') return next();
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (bearer && passwordOk(bearer)) return next();
  const cookie = ((req.headers.cookie || '').match(/(?:^|;\s*)auth=([^;]+)/) || [])[1];
  if (verify(cookie)) return next();
  res.status(401).json({ error: 'auth required' });
}

export async function loginRoute(req, res) {
  const ip = clientIp(req);
  if (!(await allowAttempt(ip, Date.now()))) return res.status(429).json({ error: 'too many attempts, try again in an hour' });
  if (!passwordOk(req.body?.password)) return res.status(401).json({ error: 'wrong password' });
  await clearAttempts(ip);
  const exp = Date.now() + COOKIE_DAYS * DAY_S * 1000;
  res.setHeader('Set-Cookie', `auth=${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${COOKIE_DAYS * DAY_S}`);
  res.json({ ok: true });
}
