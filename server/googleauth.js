// Google sign-in via the OAuth2 authorization-code flow, hand-rolled with fetch
// (no googleapis dependency, matching the project's no-library style). Flow:
//   GET /api/auth/google           -> redirect to Google's consent screen
//   GET /api/auth/google/callback  -> exchange the code, read the id_token,
//                                     match the email to the allowlist, issue a session.
// The id_token is received directly from Google's token endpoint over TLS, so
// per Google's guidance its signature does not need re-verification here; we
// decode the payload and sanity-check aud and email_verified.
import crypto from 'node:crypto';
import { createSessionToken, sessionCookie } from './auth.js';
import { findUserByEmail } from './users.js';

export function googleConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// Absolute callback URL Google will redirect back to. Must exactly match one of
// the app's "Authorized redirect URIs" in the Google Cloud console.
function redirectUri() {
  return process.env.GOOGLE_REDIRECT_URI
    || `${(process.env.PUBLIC_URL || '').replace(/\/$/, '')}/api/auth/google/callback`;
}

export function googleAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// Anti-CSRF state: an HMAC-signed nonce+expiry, mirrored in a short-lived cookie
// (double submit). The callback requires the URL state to be validly signed,
// unexpired, and equal to the cookie, so a forged or replayed callback fails.
const stateSecret = () => crypto.createHash('sha256').update('gstate:' + (process.env.SESSION_SECRET || '')).digest();
const STATE_TTL_MS = 600000; // 10 minutes to complete the round trip

export function makeState() {
  const payload = `${crypto.randomBytes(12).toString('base64url')}.${Date.now() + STATE_TTL_MS}`;
  return `${payload}.${crypto.createHmac('sha256', stateSecret()).update(payload).digest('base64url')}`;
}

export function checkState(token, cookieToken) {
  if (!token || token !== cookieToken) return false; // double-submit: URL state must equal the cookie
  const parts = String(token).split('.');
  if (parts.length !== 3) return false;
  const [nonce, exp, mac] = parts;
  const good = crypto.createHmac('sha256', stateSecret()).update(`${nonce}.${exp}`).digest('base64url');
  try { if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return false; } catch { return false; }
  return Number(exp) > Date.now();
}

const stateCookie = t => `g_state=${t}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=600`;
const clearStateCookie = () => `g_state=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
const readCookie = (req, name) => ((req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)) || [])[1];

/** Decode a JWT payload (the middle segment). No signature check: the token came
 * straight from Google's token endpoint over TLS. Returns the claims or null. */
export function decodeIdToken(idToken) {
  try {
    const payload = String(idToken).split('.')[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch { return null; }
}

/** Turn a Google id_token into a session token for an allowlisted member, or
 * null (unverified email, wrong audience, or not on the allowlist). */
export async function googleLoginToken(idToken) {
  const p = decodeIdToken(idToken);
  if (!p || !p.email) return null;
  if (process.env.GOOGLE_CLIENT_ID && p.aud !== process.env.GOOGLE_CLIENT_ID) return null;
  if (p.email_verified === false) return null;
  const user = await findUserByEmail(p.email);
  return user ? createSessionToken(user.id) : null;
}

async function exchangeCodeForIdToken(code) {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`google token exchange failed (${r.status})`);
  const j = await r.json();
  if (!j.id_token) throw new Error('no id_token from google');
  return j.id_token;
}

export function googleStartRoute(req, res) {
  if (!googleConfigured()) return res.status(503).send('Google sign-in is not configured');
  const state = makeState();
  res.setHeader('Set-Cookie', stateCookie(state));
  res.redirect(googleAuthUrl(state));
}

export async function googleCallbackRoute(req, res) {
  if (!googleConfigured()) return res.status(503).send('Google sign-in is not configured');
  if (req.query.error) return res.redirect('/?login=google_denied');
  if (!checkState(req.query.state, readCookie(req, 'g_state'))) return res.status(400).send('bad OAuth state');
  let idToken;
  try { idToken = await exchangeCodeForIdToken(String(req.query.code || '')); }
  catch { res.setHeader('Set-Cookie', clearStateCookie()); return res.status(502).send('Google token exchange failed'); }
  const token = await googleLoginToken(idToken);
  res.setHeader('Set-Cookie', token ? [clearStateCookie(), sessionCookie(token)] : [clearStateCookie()]);
  res.redirect(token ? '/' : '/?login=denied'); // denied = signed in with Google but not on the allowlist
}
