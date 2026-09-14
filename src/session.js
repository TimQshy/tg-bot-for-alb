// In-memory per-phone session store for the booking FSM.
// Simple by design: a restart clears in-progress bookings (confirmed
// appointments are safe in Postgres either way). Good enough for MVP scale.

const sessions = new Map();
const TTL_MS = 30 * 60 * 1000; // 30 min inactivity

export function getSession(phone) {
  const s = sessions.get(phone);
  if (!s) return null;
  if (Date.now() - s._updatedAt > TTL_MS) {
    sessions.delete(phone);
    return null;
  }
  return s;
}

export function setSession(phone, data) {
  sessions.set(phone, { ...data, _updatedAt: Date.now() });
}

export function clearSession(phone) {
  sessions.delete(phone);
}
