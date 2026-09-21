// Waitlist: FIFO per (master, date). When a slot frees up, the person who has
// been waiting longest is offered it and has until the end of the day to say
// yes; after that the same window moves on to the next person in line.
//
// A place in the queue and an offer are different things and live in
// different tables. The queue row (`waitlist`) is the promise: you keep your
// place until the salon takes you off it, whether you answered the last
// offer, said no, or never replied. The offer row (`waitlist_offer`) is one
// window, asked once — which is also what stops the same person being
// offered the same slot again the moment their silence expires.
import { db } from './database.js';
import { sendText } from './whatsapp.js';
import { sendMenu } from './menu.js';
import { getSession, clearSession } from './session.js';
import { formatDateFull, todayStr, nowMinutes, isWalkIn } from './utils.js';
import { getFreeSlotsForService } from './schedule.js';
import { sendAddress, sendMainMenu } from './booking.js';

const ADMIN_PHONES = () => (process.env.ADMIN_PHONES || '').split(',').map(s => s.trim()).filter(Boolean);

// Offers are not sent in the middle of the night. An offer that arrives at
// 03:00 is read in the morning anyway, and it would have burnt the whole
// "until the end of the day" window while the client slept.
const QUIET_BEFORE_MIN = 9 * 60;
const QUIET_AFTER_MIN = 21 * 60;

// ── Feature switch ─────────────────────────────────────────────────────────
// Some salons don't want a queue at all: a message about a freed slot three
// days later reads as spam if nobody is going to honour it. Off means the
// bot never offers to queue and never sends an offer — rows already in the
// table stay untouched, so switching back on picks up where it left off.
// Cached like the kill switch: every cancellation asks.
const ENABLED_KEY = 'waitlist_enabled';
const CACHE_MS = 5000;

let cached = null;
let cachedAt = 0;

// Missing key means on: the queue has been running since before the switch
// existed, and a salon that never touches this should not lose it.
export async function waitlistEnabled() {
  if (cached !== null && Date.now() - cachedAt < CACHE_MS) return cached;
  const values = await db.getSettings();
  cached = values[ENABLED_KEY] !== '0';
  cachedAt = Date.now();
  return cached;
}

export async function setWaitlistEnabled(enabled) {
  await db.setSettings({ [ENABLED_KEY]: enabled ? '1' : '0' });
  cached = Boolean(enabled);
  cachedAt = Date.now();
  return cached;
}

export function clearWaitlistStateCache() {
  cached = null;
  cachedAt = 0;
}

// ── Joining ────────────────────────────────────────────────────────────────
// Shared by both entry points — the numbered flow and the AI agent — so the
// rules about switching off and joining twice hold wherever someone asks.
// Returns what happened rather than a message, because the two callers word
// it differently.
export async function join({ userId, masterId, serviceId, date }) {
  if (!(await waitlistEnabled())) return { ok: false, reason: 'disabled' };

  const existing = await db.findActiveWaitlistFor(userId, masterId, date);
  if (existing) return { ok: false, reason: 'already_waiting', entry: existing };

  const entry = await db.addToWaitlist({ userId, masterId, serviceId, date });
  return { ok: true, entry };
}

export const JOINED_TEXT =
  'Мы внесли вас в лист ожидания! Как только освободится подходящее время, ' +
  'мы сразу свяжемся с вами. Запись будет фиксироваться в один клик.';

// ── Join from the numbered flow ────────────────────────────────────────────
export async function handleJoin(phone) {
  const session = getSession(phone);
  if (!session || session.step !== 'waitlist_offer') return sendMainMenu(phone);

  const result = await join({
    userId: phone,
    masterId: session.masterId,
    serviceId: session.serviceId,
    date: session.date,
  });
  clearSession(phone);

  if (result.reason === 'disabled') {
    await sendText(phone, 'Лист ожидания сейчас не работает. Попробуйте выбрать другую дату.');
    return sendMainMenu(phone);
  }

  await sendText(
    phone,
    result.reason === 'already_waiting'
      ? `Вы уже в листе ожидания на ${formatDateFull(session.date)} к ${session.masterName}. ` +
        `Освободится место — напишем.`
      : `✅ ${formatDateFull(session.date)}, ${session.masterName}.\n\n${JOINED_TEXT}`
  );
  return sendMainMenu(phone);
}

// ── Sending an offer ───────────────────────────────────────────────────────
// The first free window on that date, offered to the first person in line who
// hasn't already been asked about it. One live offer per master/date: the
// queue is FIFO, and two offers out at once would race two clients for one
// slot.
export async function notifyNext(masterId, date, { force = false } = {}) {
  if (!(await waitlistEnabled())) return null;
  if (date < todayStr()) return null;
  if (!force && !withinSendingHours()) return null;

  // A live offer holds the queue for that date — but only while the window it
  // names is still there. Someone else booking it (a walk-in, the panel)
  // would otherwise freeze the queue until the end of the day for a slot that
  // no longer exists.
  const live = await db.getLiveOffer(masterId, date);
  if (live) {
    if (await db.isSlotAvailable(masterId, date, live.start_time, live.end_time)) return null;
    await db.markWaitlistOfferStatus(live.id, 'expired');
  }

  // Offers are per window, so the candidate and the window have to be found
  // together: a colouring that needs four hours and a 30-minute gap are not
  // the same opening. The first free slot is found per candidate, in queue
  // order, and the first pair that fits wins.
  const slots = await freeSlotsForWaiting(masterId, date);
  if (!slots.length) return null;

  for (const { entry, slot } of slots) {
    const next = await db.getNextWaitingFor(masterId, date, slot.start, slot.end);
    if (!next || next.id !== entry.id) continue;
    return sendOffer(entry, date, slot);
  }
  return null;
}

// Waiting entries paired with the first window that actually fits their
// service, in queue order.
async function freeSlotsForWaiting(masterId, date) {
  const pairs = [];
  for (const entry of await db.listWaitlist({ date, masterId })) {
    if (entry.status !== 'waiting') continue;
    // A walk-in the salon typed in by hand has no chat to offer anything in.
    // Sending would mark an offer nobody can answer and block the date until
    // the end of the day; they are a row to ring, and the panel says so.
    if (isWalkIn(entry.user_id)) continue;
    const service = await db.getService(entry.service_id);
    if (!service) continue;
    const free = await getFreeSlotsForService(service, masterId, date);
    if (free.length) pairs.push({ entry, slot: free[0] });
  }
  return pairs;
}

async function sendOffer(entry, date, slot) {
  const offer = await db.createWaitlistOffer(entry.id, {
    date, startTime: slot.start, endTime: slot.end,
  });
  const full = await db.getWaitlistOffer(offer.id);

  await sendMenu(
    entry.user_id,
    `🎉 Освободилось окно на ${formatDateFull(date)}, ${slot.start} – ${slot.end}!\n\n` +
      `💅 ${full.service_name}\n👩 ${full.master_name}\n\n` +
      `Вы первый в очереди, поэтому это время держим за вами. ` +
      `Нажмите «Записаться», чтобы подтвердить.`,
    [
      { id: `waitlist:confirm:${offer.id}`, label: '✅ Записаться' },
      { id: `waitlist:decline:${offer.id}`, label: '❌ Не смогу' },
    ]
  );
  return offer;
}

// Offers go out during the day. Called on cancellations, which can happen at
// any hour; the sweep picks up whatever was held back overnight.
function withinSendingHours() {
  const min = nowMinutes();
  return min >= QUIET_BEFORE_MIN && min < QUIET_AFTER_MIN;
}

// ── Client responds ────────────────────────────────────────────────────────
export async function handleOfferConfirm(phone, idStr) {
  const id = parseInt(idStr, 10);
  const offer = await db.getWaitlistOffer(id);
  if (!offer || offer.user_id !== phone || offer.status !== 'sent') {
    return sendText(phone, 'Это предложение уже неактуально.');
  }

  const available = await db.isSlotAvailable(offer.master_id, offer.desired_date, offer.start_time, offer.end_time);
  if (!available) {
    await db.markWaitlistOfferStatus(id, 'expired');
    await sendText(phone, '😔 Это время уже заняли. Вы остаётесь в очереди на случай следующей отмены.');
    return notifyNext(offer.master_id, dateOf(offer.desired_date), { force: true });
  }

  const appt = await db.createAppointment({
    userId: phone,
    masterId: offer.master_id,
    serviceId: offer.service_id,
    date: offer.desired_date,
    startTime: offer.start_time,
    endTime: offer.end_time,
  });
  await db.markWaitlistOfferStatus(id, 'accepted');
  await db.markWaitlistStatus(offer.waitlist_id, 'booked');

  await sendText(
    phone,
    `🎉 Запись подтверждена!\n\n` +
      `💅 ${offer.service_name}\n👩 ${offer.master_name}\n` +
      `📅 ${formatDateFull(dateOf(offer.desired_date))}\n` +
      `🕐 ${String(offer.start_time).slice(0, 5)} – ${String(offer.end_time).slice(0, 5)}\n\n` +
      `📋 Номер записи: #${appt.id}`
  );
  await sendAddress(phone);

  for (const adminPhone of ADMIN_PHONES()) {
    sendText(
      adminPhone,
      `📩 Запись из листа ожидания #${appt.id}\n👤 ${phone}\n💅 ${offer.service_name}\n` +
        `👩 ${offer.master_name}\n📅 ${formatDateFull(dateOf(offer.desired_date))}`
    ).catch(() => {});
  }
}

// Saying no closes this offer, not the place in the queue: the client asked
// to be told when this date frees up, and one inconvenient window is not a
// change of mind. Only the salon takes people off the list.
export async function handleOfferDecline(phone, idStr) {
  const id = parseInt(idStr, 10);
  const offer = await db.getWaitlistOffer(id);
  if (!offer || offer.user_id !== phone || offer.status !== 'sent') return;

  await db.markWaitlistOfferStatus(id, 'declined');
  await sendText(
    phone,
    'Хорошо, это время не предлагаем. Вы остаётесь в очереди — освободится другое, напишем.'
  );
  return notifyNext(offer.master_id, dateOf(offer.desired_date), { force: true });
}

// ── Scheduler jobs ─────────────────────────────────────────────────────────
// Offers nobody answered by the end of the day, and windows that opened up
// without a cancellation to announce them — the salon adding hours, or a
// client's earlier decline. Both end in the same place: ask the next person.
export async function runWaitlistSweep() {
  if (!(await waitlistEnabled())) return;

  await db.expireStaleWaitlistOffers();

  if (!withinSendingHours()) return;
  for (const target of await db.getWaitlistTargets()) {
    await notifyNext(target.master_id, target.date).catch(err =>
      console.error(`waitlist sweep failed for master ${target.master_id} on ${target.date}:`, err)
    );
  }
}

// ── Panel actions ──────────────────────────────────────────────────────────
// The salon stepping in: offer this person a slot now, whatever the queue
// order and whatever the hour. Used when an admin has them on the phone.
export async function offerEntryNow(entryId) {
  const entry = await db.getWaitlistEntry(entryId);
  if (!entry || entry.status !== 'waiting') return { ok: false, reason: 'not_waiting' };
  if (isWalkIn(entry.user_id)) return { ok: false, reason: 'no_contact' };

  const live = await db.getLiveOffer(entry.master_id, dateOf(entry.desired_date));
  if (live) return { ok: false, reason: 'offer_pending', offer: live };

  const service = await db.getService(entry.service_id);
  const date = dateOf(entry.desired_date);
  const free = await getFreeSlotsForService(service, entry.master_id, date);
  if (!free.length) return { ok: false, reason: 'no_slots' };

  const offer = await sendOffer(entry, date, free[0]);
  return { ok: true, offer };
}

// Changing what someone is waiting for. A live offer names a window on the
// old date and the old master, so it is closed rather than left pointing at
// something the entry no longer asks for.
export async function updateEntry(entryId, { serviceId, masterId, date }) {
  const entry = await db.getWaitlistEntry(entryId);
  if (!entry) return null;

  const moved = masterId !== entry.master_id || date !== dateOf(entry.desired_date);
  if (moved) {
    const live = await db.getLiveOffer(entry.master_id, dateOf(entry.desired_date));
    if (live && live.waitlist_id === entry.id) await db.markWaitlistOfferStatus(live.id, 'expired');
  }

  return db.updateWaitlistEntry(entryId, { serviceId, masterId, date });
}

export async function removeEntry(entryId) {
  const entry = await db.getWaitlistEntry(entryId);
  if (!entry) return null;
  // A live offer to someone being taken off the list would still be
  // answerable, so it is closed with them.
  const live = await db.getLiveOffer(entry.master_id, dateOf(entry.desired_date));
  if (live && live.waitlist_id === entry.id) await db.markWaitlistOfferStatus(live.id, 'expired');
  return db.markWaitlistStatus(entryId, 'cancelled');
}

// Postgres hands back a Date for a `date` column; every caller here wants the
// YYYY-MM-DD string the rest of the code passes around.
function dateOf(value) {
  return String(value).slice(0, 10);
}
