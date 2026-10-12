// The salon's own text — address, how to find the door, a map link — edited
// in the panel and quoted verbatim by the bot. One module so the wording is
// identical wherever a booking is confirmed: the numbered flow, the AI agent,
// the waitlist offer and an appointment the admin creates by hand.
import { db } from './database.js';
import { todayStr, addDays } from './utils.js';

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

// A date from which client booking is held shut until that day comes — "на
// ноябрь запись откроется 1 ноября". Before it, every date on or after it is
// off limits to the bot, the consultant and the waitlist alike; from that day
// on the gate is inert by itself, so nobody has to remember to clear it. The
// panel is not held by it, same as with the horizon.
export const OPENS_ON_KEY = 'booking_opens_on';

const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export const isIsoDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

// What the client is told. A gate on the 1st reads as a whole month opening,
// which is how salons announce it; any other day is named as a date.
export function gateMessage(opensOn) {
  const [, m, d] = opensOn.split('-').map(Number);
  const when = `${d} ${MONTHS_GEN[m - 1]}`;
  return d === 1
    ? `Запись на ${MONTHS_NOM[m - 1]} откроется ${when}`
    : `Запись на даты с ${when} откроется ${when}`;
}

// null when nothing is held shut today.
export async function getBookingGate(today = todayStr()) {
  const opensOn = (await db.getSettings())[OPENS_ON_KEY];
  if (!isIsoDate(opensOn) || today >= opensOn) return null;
  return { opensOn, lastOpenDate: addDays(opensOn, -1), message: gateMessage(opensOn) };
}

// How many days ahead a client can book right now: the horizon, cut short at
// the gate while it is shut. Can be 0 — today is the last open date.
export async function getBookableDays(today = todayStr()) {
  const [horizon, gate] = await Promise.all([getBookingHorizonDays(), getBookingGate(today)]);
  if (!gate) return horizon;
  const toGate = Math.round((Date.parse(gate.lastOpenDate) - Date.parse(today)) / 86400000);
  return Math.max(0, Math.min(horizon, toGate));
}
