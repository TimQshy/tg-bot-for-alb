// Clerk-backed auth for the admin panel. The panel is served from a single
// origin (admin.<domain>) and nginx proxies each salon under /s/<slug>/, so
// every container authorizes against its own SALON_SLUG: a salon owner's
// token carries the slugs they own, a system admin's carries the role.
//
// `metadata` is not in Clerk's session token by default — it has to be added
// in Dashboard → Sessions → Customize session token as:
//   { "metadata": "{{user.public_metadata}}" }
import { createClerkClient, verifyToken } from '@clerk/backend';

// Built on first use, not at import time, so a missing key still surfaces as
// bot.js's readable "Missing required .env vars" instead of an import crash.
let client = null;
export function clerk() {
  if (!client) client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  return client;
}

function bearerToken(authHeader) {
  const prefix = 'Bearer ';
  if (!authHeader || !authHeader.startsWith(prefix)) return null;
  return authHeader.slice(prefix.length).trim() || null;
}

// Resolves to { userId, isSystemAdmin } when the token is valid and grants
// access to this container's salon, or null when it doesn't.
export async function authorizeAdmin(authHeader) {
  const token = bearerToken(authHeader);
  if (!token) return null;

  let claims;
  try {
    claims = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
  } catch {
    return null;
  }

  const metadata = claims.metadata || {};
  const isSystemAdmin = metadata.role === 'system_admin';
  const salons = Array.isArray(metadata.salons) ? metadata.salons : [];

  if (!isSystemAdmin && !salons.includes(process.env.SALON_SLUG)) return null;

  return { userId: claims.sub, isSystemAdmin };
}
