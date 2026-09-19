// The emergency switch. One flag per salon that silences the bot everywhere
// at once: WhatsApp replies, scheduled reminders and Instagram auto-replies.
// It lives in `settings` so it survives a restart, and only a system admin
// can flip it — the salon is not meant to turn its own bot off by accident.
//
// Every incoming message asks this, so the answer is cached for a few
// seconds. The lag only matters when the switch is thrown, and a message
// answered a moment late is better than a query per message.
import { db } from './database.js';

const KEY = 'bot_enabled';
const CACHE_MS = 5000;

let cached = null;
let cachedAt = 0;

// Missing key means enabled: a fresh database has a working bot.
export async function botEnabled() {
  if (cached !== null && Date.now() - cachedAt < CACHE_MS) return cached;
  const values = await db.getSettings();
  cached = values[KEY] !== '0';
  cachedAt = Date.now();
  return cached;
}

export async function setBotEnabled(enabled) {
  await db.setSettings({ [KEY]: enabled ? '1' : '0' });
  cached = Boolean(enabled);
  cachedAt = Date.now();
  return cached;
}

// Tests and the toggle itself need the next read to hit the database.
export function clearBotStateCache() {
  cached = null;
  cachedAt = 0;
}
