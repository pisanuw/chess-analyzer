// Single-password auth for the hosted copy. Active only when APP_PASSWORD is
// set; local use (no env var) is untouched. Cookie is HMAC-signed with a key
// derived from the password, so there is no separate secret to manage.
import crypto from 'node:crypto';

const DAY_S = 86400;
const COOKIE_DAYS = 90;
const attempts = new Map(); // ip -> { n, resetAt }

const password = () => process.env.APP_PASSWORD || '';
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

export function loginRoute(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '?').split(',')[0].trim();
  const a = attempts.get(ip) || { n: 0, resetAt: Date.now() + 3600000 };
  if (Date.now() > a.resetAt) { a.n = 0; a.resetAt = Date.now() + 3600000; }
  if (a.n >= 20) return res.status(429).json({ error: 'too many attempts, try again in an hour' });
  a.n++;
  attempts.set(ip, a);
  if (!passwordOk(req.body?.password)) return res.status(401).json({ error: 'wrong password' });
  attempts.delete(ip);
  const exp = Date.now() + COOKIE_DAYS * DAY_S * 1000;
  res.setHeader('Set-Cookie', `auth=${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${COOKIE_DAYS * DAY_S}`);
  res.json({ ok: true });
}
