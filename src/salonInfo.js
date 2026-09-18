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
