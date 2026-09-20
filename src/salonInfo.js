// The salon's own text — address, how to find the door, a map link — edited
// in the panel and quoted verbatim by the bot. One module so the wording is
// identical wherever a booking is confirmed: the numbered flow, the AI agent,
// the waitlist offer and an appointment the admin creates by hand.
import { db } from './database.js';

export const SETTING_KEYS = ['address', 'address_note', 'map_url'];

export async function getSalonInfo() {
  const values = await db.getSettings();
  return Object.fromEntries(SETTING_KEYS.map(k => [k, values[k] || '']));
}

// The block appended after a confirmed booking, or null when the salon
// hasn't filled the address in — an empty "📍" line helps nobody.
export async function addressMessage() {
  const { address, address_note: note, map_url: map } = await getSalonInfo();
  if (!address) return null;

  return [
    `📍 Адрес: ${address}`,
    note || null,
    map || null,
  ].filter(Boolean).join('\n');
}

// How far ahead a client may book. The salon sets it in the panel because
// the right answer differs per salon: a nail bar takes next week, a studio
// selling a course wants two months open. Everything client-facing reads
// this — the numbered date list and the AI agent's date search alike.
export const HORIZON_KEY = 'booking_horizon_days';
export const DEFAULT_HORIZON_DAYS = 60;
export const HORIZON_MIN = 1;
export const HORIZON_MAX = 365;

// Anything unparseable falls back to the default rather than throwing: a
// broken settings row must not take booking down.
export function normalizeHorizon(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_HORIZON_DAYS;
  return Math.min(Math.max(n, HORIZON_MIN), HORIZON_MAX);
}

export async function getBookingHorizonDays() {
  const values = await db.getSettings();
  return values[HORIZON_KEY] === undefined
    ? DEFAULT_HORIZON_DAYS
    : normalizeHorizon(values[HORIZON_KEY]);
}
