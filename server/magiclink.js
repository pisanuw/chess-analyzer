// Passwordless "magic link" sign-in. POST /api/auth/magic/request emails a
// signed one-time link to an allowlisted address; GET /api/auth/magic/verify
// checks the link and issues a session. Delivery is via Resend's REST API; with
// no RESEND_API_KEY the link is logged to the console (local dev fallback).
//
// The token is a short-lived HMAC-signed (userId, expiry): stateless, so no
// store is needed. It is not strictly single-use, but the 15-minute window and
// the private allowlist keep the risk small for this handful of users.
import crypto from 'node:crypto';
import { createSessionToken, sessionCookie, rateLimit } from './auth.js';
import { findUserByEmail, getUser } from './users.js';
import { logEvent, eventIp } from './audit.js';

/** True when email can actually be delivered (drives the login screen's UI). The
 * routes still work without it via the console fallback, for local testing. */
export function magicConfigured() {
  return !!process.env.RESEND_API_KEY;
}

const magicSecret = () => crypto.createHash('sha256').update('magic:' + (process.env.SESSION_SECRET || '')).digest();
const TTL_MS = 900000; // 15 minutes

export function makeMagicToken(userId, exp = Date.now() + TTL_MS) {
  const payload = `${userId}.${exp}`;
  return `${payload}.${crypto.createHmac('sha256', magicSecret()).update(payload).digest('base64url')}`;
}

export function verifyMagicToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [userId, exp, mac] = parts;
  const good = crypto.createHmac('sha256', magicSecret()).update(`${userId}.${exp}`).digest('base64url');
  try { if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null; } catch { return null; }
  if (!(Number(exp) > Date.now())) return null;
  return { userId, exp: Number(exp) };
}

function magicLink(token) {
  return `${(process.env.PUBLIC_URL || '').replace(/\/$/, '')}/api/auth/magic/verify?token=${encodeURIComponent(token)}`;
}

async function sendMagicEmail(to, link) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[magic-link] no RESEND_API_KEY set; link for ${to}: ${link}`); // dev fallback
    return;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: process.env.AUTH_FROM_EMAIL || 'Chess Analyzer <onboarding@resend.dev>',
      to: [to],
      subject: 'Your Chess Analyzer sign-in link',
      text: `Click to sign in (valid for 15 minutes):\n\n${link}\n\nIf you did not request this, you can ignore this email.`,
    }),
  });
  if (!r.ok) throw new Error(`resend send failed (${r.status})`);
}

export async function magicRequestRoute(req, res) {
  if (!(await rateLimit(req))) return res.status(429).json({ error: 'too many attempts, try again in an hour' });
  const email = String(req.body?.email || '').trim();
  const user = email ? await findUserByEmail(email) : null;
  // Only send to allowlisted addresses, but always return the same response so
  // the endpoint cannot be used to enumerate who is on the allowlist.
  if (user) {
    try { await sendMagicEmail(email, magicLink(makeMagicToken(user.id))); }
    catch (err) { console.error(`magic send failed: ${err.message}`); }
  }
  res.json({ ok: true });
}

export async function magicVerifyRoute(req, res) {
  const v = verifyMagicToken(String(req.query.token || ''));
  if (!v) return res.status(400).send('This sign-in link is invalid or has expired. Request a new one.');
  const user = await getUser(v.userId); // re-check the member still exists on the allowlist
  if (!user) return res.redirect('/?login=denied');
  logEvent({ action: 'login', detail: 'magic-link', userId: user.id, name: user.displayName, ip: eventIp(req) });
  res.setHeader('Set-Cookie', sessionCookie(createSessionToken(user.id)));
  res.redirect('/');
}
