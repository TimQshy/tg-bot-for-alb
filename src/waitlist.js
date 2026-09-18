// Waitlist: FIFO per (master, date). When someone cancels, the oldest
// waiting entry for that master/date gets offered the freed-up slot and has
// a timeout to accept before we move to the next person in line.
import { db } from './database.js';
import { sendText } from './whatsapp.js';
import { sendMenu } from './menu.js';
import { getSession, clearSession } from './session.js';
import { formatDateFull } from './utils.js';
import { getFreeSlotsForService } from './schedule.js';
import { sendAddress, sendMainMenu } from './booking.js';

const ADMIN_PHONES = () => (process.env.ADMIN_PHONES || '').split(',').map(s => s.trim()).filter(Boolean);

// ── Join (triggered from booking.js when a chosen date has no free slots) ──
export async function handleJoin(phone) {
  const session = getSession(phone);
  if (!session || session.step !== 'waitlist_offer') return sendMainMenu(phone);

  await db.addToWaitlist({
    userId: phone,
    masterId: session.masterId,
    serviceId: session.serviceId,
    date: session.date,
  });
  clearSession(phone);

  await sendText(
    phone,
    `✅ Вы в листе ожидания на ${formatDateFull(session.date)} к ${session.masterName}.\n` +
      `Если кто-то отменит запись — напишем вам первому.`
  );
  return sendMainMenu(phone);
}

// ── Called right after any cancellation for (masterId, date) ───────────────
export async function notifyNext(masterId, date) {
  const entry = await db.getNextWaiting(masterId, date);
  if (!entry) return;

  // entry carries the service's duration, step, start window and day block
  // (see db.getNextWaiting), so an offer never breaks a rule the booking
  // flow would have enforced.
  const slots = await getFreeSlotsForService(entry, masterId, date);
  if (!slots.length) return; // freed gap doesn't fit this service's duration yet

  const slot = slots[0];
  await db.markWaitlistOffered(entry.id, { startTime: slot.start, endTime: slot.end });

  const full = await db.getWaitlistEntry(entry.id);
  await sendMenu(
    entry.user_id,
    `🎉 Освободилось место!\n\n` +
      `💅 ${full.service_name}\n👩 ${full.master_name}\n` +
      `📅 ${formatDateFull(date)}\n🕐 ${slot.start} – ${slot.end}\n\n` +
      `Записать вас?`,
    [
      { id: `waitlist:confirm:${entry.id}`, label: '✅ Да, записать' },
      { id: `waitlist:decline:${entry.id}`, label: '❌ Нет, спасибо' },
    ]
  );
}

// ── Client responds to an offer ─────────────────────────────────────────────
export async function handleOfferConfirm(phone, idStr) {
  const id = parseInt(idStr, 10);
  const entry = await db.getWaitlistEntry(id);
  if (!entry || entry.user_id !== phone || entry.status !== 'offered') {
    return sendText(phone, 'Это предложение уже неактуально.');
  }

  const available = await db.isSlotAvailable(entry.master_id, entry.desired_date, entry.offered_start_time, entry.offered_end_time);
  if (!available) {
    await db.markWaitlistStatus(id, 'expired');
    await sendText(phone, '😔 Это время уже заняли. Вы остаётесь в очереди на случай следующей отмены.');
    return notifyNext(entry.master_id, entry.desired_date);
  }

  const appt = await db.createAppointment({
    userId: phone,
    masterId: entry.master_id,
    serviceId: entry.service_id,
    date: entry.desired_date,
    startTime: entry.offered_start_time,
    endTime: entry.offered_end_time,
  });
  await db.markWaitlistStatus(id, 'booked');

  await sendText(
    phone,
    `🎉 Запись подтверждена!\n\n` +
      `💅 ${entry.service_name}\n👩 ${entry.master_name}\n` +
      `📅 ${formatDateFull(entry.desired_date)}\n` +
      `🕐 ${String(entry.offered_start_time).slice(0, 5)} – ${String(entry.offered_end_time).slice(0, 5)}\n\n` +
      `📋 Номер записи: #${appt.id}`
  );
  await sendAddress(phone);

  for (const adminPhone of ADMIN_PHONES()) {
    sendText(
      adminPhone,
      `📩 Запись из листа ожидания #${appt.id}\n👤 ${phone}\n💅 ${entry.service_name}\n👩 ${entry.master_name}\n📅 ${formatDateFull(entry.desired_date)}`
    ).catch(() => {});
  }
}

export async function handleOfferDecline(phone, idStr) {
  const id = parseInt(idStr, 10);
  const entry = await db.getWaitlistEntry(id);
  if (!entry || entry.user_id !== phone || entry.status !== 'offered') return;

  await db.markWaitlistStatus(id, 'cancelled');
  await sendText(phone, 'Хорошо, сняли вас с очереди.');
  return notifyNext(entry.master_id, entry.desired_date);
}

// ── Called by the scheduler: offers nobody answered in time ────────────────
export async function expireStaleOffers(timeoutMin) {
  const stale = await db.getExpiredWaitlistOffers(timeoutMin);
  for (const entry of stale) {
    await db.markWaitlistStatus(entry.id, 'expired');
    await notifyNext(entry.master_id, entry.desired_date);
  }
}
