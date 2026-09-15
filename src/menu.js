// Numbered text menus — WhatsApp Web (Baileys) doesn't reliably render
// native buttons/lists for non-Business-API senders (confirmed by hand:
// a buttonsMessage arrived as plain text with no buttons). So every choice
// is "1. Label\n2. Label…" and the client replies with a bare digit.
//
// lastMenu is separate from session.js's booking-FSM state: a menu can be
// showing (main menu, "my bookings") even when there's no active FSM step.
import { sendText } from './whatsapp.js';

const lastMenus = new Map();
const TTL_MS = 30 * 60 * 1000;

function setLastMenu(phone, ids) {
  lastMenus.set(phone, { ids, updatedAt: Date.now() });
}

export function getLastMenu(phone) {
  const m = lastMenus.get(phone);
  if (!m) return null;
  if (Date.now() - m.updatedAt > TTL_MS) {
    lastMenus.delete(phone);
    return null;
  }
  return m.ids;
}

export function clearLastMenu(phone) {
  lastMenus.delete(phone);
}

// Resolves incoming text against the menu last shown to this phone.
// Returns the matching item id, or null if there's no pending menu or the
// text isn't a valid choice for it.
export function resolveMenuReply(phone, text) {
  const ids = getLastMenu(phone);
  if (!ids) return null;
  const trimmed = (text || '').trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const idx = parseInt(trimmed, 10) - 1;
  return ids[idx] ?? null;
}

// items: [{ id, label }]
export function sendMenu(phone, bodyText, items, { footer } = {}) {
  const lines = items.map((it, i) => `${i + 1}. ${it.label}`);
  const text = [bodyText, '', ...lines, footer ? `\n${footer}` : null].filter(Boolean).join('\n');
  setLastMenu(phone, items.map(it => it.id));
  return sendText(phone, text);
}
