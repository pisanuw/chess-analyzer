// Sign-in, identity, and access requests. Registered before the auth and
// read-only gates in index.js (the paths under /api/auth/ are exempt), so the
// frontend can ask who it is, sign in, and request access on the mirror.
import { loginRoute, meRoute, logoutRoute, rateLimit } from '../auth.js';
import { googleStartRoute, googleCallbackRoute } from '../googleauth.js';
import { magicRequestRoute, magicVerifyRoute } from '../magiclink.js';
import { sendEmail, adminEmail } from '../email.js';
import { logEvent, eventIp } from '../audit.js';

export function registerAuthRoutes(app) {
  app.post('/api/login', (req, res) => loginRoute(req, res).catch(err => {
    console.error(err);
    res.status(500).json({ error: err.message });
  }));
  // Identity endpoints (exempt from the auth gate and the read-only gate, so the
  // frontend can ask who it is and log out even on the mirror).
  app.get('/api/auth/me', (req, res) => meRoute(req, res).catch(err => {
    console.error(err);
    res.status(500).json({ error: err.message });
  }));
  app.post('/api/auth/logout', (req, res) => logoutRoute(req, res));
  // Google sign-in (OAuth2 code flow). Both are exempt from the auth gate.
  app.get('/api/auth/google', (req, res) => { try { googleStartRoute(req, res); } catch (err) { console.error(err); res.status(500).send('sign-in failed'); } });
  app.get('/api/auth/google/callback', (req, res) => googleCallbackRoute(req, res).catch(err => {
    console.error(err);
    res.status(500).send('sign-in failed');
  }));
  // Magic-link sign-in (request emails a one-time link; verify sets the session).
  app.post('/api/auth/magic/request', (req, res) => magicRequestRoute(req, res).catch(err => {
    console.error(err);
    res.status(500).json({ error: 'could not send link' });
  }));
  app.get('/api/auth/magic/verify', (req, res) => magicVerifyRoute(req, res).catch(err => {
    console.error(err);
    res.status(500).send('sign-in failed');
  }));
  // Request access: an unauthorized visitor asks the admin to be added. Public
  // (under /api/auth/, so exempt from the auth gate) and registered before the
  // read-only gate so it works on the hosted mirror, where such requests happen.
  app.post('/api/auth/request-access', (req, res) => (async () => {
    if (!(await rateLimit(req, 'access-request'))) return res.status(429).json({ error: 'too many requests, try again later' });
    const to = adminEmail();
    if (!to) return res.status(503).json({ error: 'access requests are not configured' });
    const email = String(req.body?.email || '').trim();
    const reason = String(req.body?.reason || '').trim().slice(0, 2000);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'enter a valid email address' });
    await sendEmail(to, `Access request: ${email}`,
      `${email} is requesting access to Chess Analyzer.\n\nReason:\n${reason || '(none given)'}\n\nAdd them from the Admin page: Add visitor, or Add player.`);
    logEvent({ action: 'access requested', detail: email, ip: eventIp(req) });
    res.json({ ok: true });
  })().catch(err => { console.error(`access request failed: ${err.message}`); res.status(502).json({ error: 'could not send the request' }); }));
}
