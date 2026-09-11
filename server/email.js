// Minimal outbound email via Resend (shared by the magic-link flow's sibling
// features, e.g. prep-sheet requests). With no RESEND_API_KEY the message is
// logged to the console instead, so local runs work without email configured.

/** Where operator notifications go (prep-sheet requests, etc.). */
export function adminEmail() {
  return process.env.ADMIN_EMAIL || process.env.AUTH_EMAIL_YUSUF || '';
}

export async function sendEmail(to, subject, text) {
  if (!to) throw new Error('no recipient');
  if (!process.env.RESEND_API_KEY) {
    console.log(`[email] (no RESEND_API_KEY) to ${to}: ${subject}\n${text}`);
    return false;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: process.env.AUTH_FROM_EMAIL || 'Chess Analyzer <onboarding@resend.dev>', to: [to], subject, text }),
  });
  if (!r.ok) throw new Error(`resend send failed (${r.status})`);
  return true;
}
