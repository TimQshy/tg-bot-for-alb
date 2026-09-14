// Signed-cookie session for the single admin account. No session store needed:
// the cookie itself carries an expiry + HMAC signature, verified on each request.
import crypto from 'crypto';

export const COOKIE_NAME = 'admin_session';
const TTL_MS = 12 * 60 * 60 * 1000; // 12h

function sign(value) {
  return crypto.createHmac('sha256', process.env.ADMIN_COOKIE_SECRET).update(value).digest('hex');
}

export function createSessionCookieValue() {
  const expiry = String(Date.now() + TTL_MS);
  return `${expiry}.${sign(expiry)}`;
}

export function verifySessionCookieValue(raw) {
  if (!raw) return false;
  const dot = raw.lastIndexOf('.');
  if (dot === -1) return false;
  const expiry = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = sign(expiry);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(expiry) > Date.now();
}

export function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}
