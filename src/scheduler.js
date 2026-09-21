// Background jobs: appointment reminders (24h/2h before) and waitlist-offer
// timeouts. Runs inside the same process via node-cron — state lives in
// Postgres (appointments.reminder_*_sent, waitlist.offered_at), so a restart
// between ticks doesn't lose anything; the next tick just picks it up.
import cron from 'node-cron';
import { db } from './database.js';
import { sendText } from './whatsapp.js';
import { formatDateFull, isWalkIn } from './utils.js';
import { sendMenu } from './menu.js';
import { runWaitlistSweep } from './waitlist.js';
import { refreshIgToken } from './instagram.js';
import { botEnabled } from './botState.js';

// Asked three days out and treated as unanswered one day out, which is the
// window in which a freed slot is still worth something to the waitlist.
const ADMIN_PHONES = () => (process.env.ADMIN_PHONES || '').split(',').map(s => s.trim()).filter(Boolean);

const CONFIRM_AHEAD_MIN = 3 * 24 * 60;
const CONFIRM_WINDOW_MIN = 12 * 60; // sent anywhere in this band, once
const ADMIN_ALERT_WITHIN_MIN = 24 * 60;
const MORNING_HOUR = 9;

async function sendReminder(appt, label) {
  await sendText(
    appt.user_id,
    `⏰ Напоминание: у вас запись ${label}\n\n` +
      `💅 ${appt.service_name}\n👩 ${appt.master_name}\n` +
      `📅 ${formatDateFull(String(appt.appointment_date).slice(0, 10))}\n` +
      `🕐 ${String(appt.start_time).slice(0, 5)} – ${String(appt.end_time).slice(0, 5)}`
  );
}

// ── Confirmation («придёте?») ──────────────────────────────────────────────
// A booking nobody confirms is the one that quietly becomes an empty chair,
// so it is asked about while there is still time to give the slot away.
async function runConfirmRequests() {
  const due = await db.getAppointmentsNeedingConfirmRequest(
    CONFIRM_AHEAD_MIN - CONFIRM_WINDOW_MIN, CONFIRM_AHEAD_MIN
  );
  for (const appt of due) {
    try {
      const date = String(appt.appointment_date).slice(0, 10);
      await sendMenu(
        appt.user_id,
        `Здравствуйте! Подтверждаете свою запись?\n\n` +
          `💅 ${appt.service_name}\n👩 ${appt.master_name}\n` +
          `📅 ${formatDateFull(date)}\n🕐 ${String(appt.start_time).slice(0, 5)} – ${String(appt.end_time).slice(0, 5)}`,
        [
          { id: `appt_confirm:${appt.id}`, label: '✅ Да, приду' },
          { id: `cancel_appt:${appt.id}`, label: '❌ Отменить запись' },
        ]
      );
      await db.markConfirmRequestSent(appt.id);
    } catch (err) {
      console.error(`confirm request failed for appointment #${appt.id}:`, err);
    }
  }
}

// Nobody answered and the visit is tomorrow: the salon rings them. Sent in
// the morning, because a list of calls to make is useless at 23:00.
async function runAdminAlerts() {
  if (new Date().getHours() < MORNING_HOUR) return;

  const admins = ADMIN_PHONES();
  for (const appt of await db.getUnconfirmedAppointments(ADMIN_ALERT_WITHIN_MIN)) {
    try {
      const date = String(appt.appointment_date).slice(0, 10);
      for (const adminPhone of admins) {
        await sendText(
          adminPhone,
          `📞 Клиент не подтвердил запись #${appt.id}\n\n` +
            `👤 ${appt.user_name}${isWalkIn(appt.user_id) ? '' : ` (${appt.user_id})`}\n` +
            `💅 ${appt.service_name}\n👩 ${appt.master_name}\n` +
            `📅 ${formatDateFull(date)}\n🕐 ${String(appt.start_time).slice(0, 5)} – ${String(appt.end_time).slice(0, 5)}\n\n` +
            `Стоит позвонить. Не придёт — отмените запись в панели, место уйдёт в лист ожидания.`
        );
      }
      // Marked even with no admin phones configured: the alternative is
      // re-running this query for the same appointment every five minutes
      // until the visit.
      await db.markAdminAlertSent(appt.id);
    } catch (err) {
      console.error(`admin alert failed for appointment #${appt.id}:`, err);
    }
  }
}

async function runReminders() {
  for (const appt of await db.getAppointmentsNeedingReminder('reminder_24h_sent', 24 * 60)) {
    try {
      await sendReminder(appt, 'завтра');
      await db.markReminderSent(appt.id, 'reminder_24h_sent');
    } catch (err) {
      console.error(`24h reminder failed for appointment #${appt.id}:`, err);
    }
  }

  for (const appt of await db.getAppointmentsNeedingReminder('reminder_2h_sent', 2 * 60)) {
    try {
      await sendReminder(appt, 'через 2 часа');
      await db.markReminderSent(appt.id, 'reminder_2h_sent');
    } catch (err) {
      console.error(`2h reminder failed for appointment #${appt.id}:`, err);
    }
  }
}

export function startScheduler() {
  // Every 5 min: cheap at current volume, fine-grained enough that
  // reminders/waitlist timeouts don't run noticeably late.
  // Both jobs write to clients, so both stop while the bot is switched off
  // in the panel. Nothing is marked as sent in the meantime — a reminder
  // whose hour passed during the outage is simply skipped by the window
  // check when the tick runs again.
  cron.schedule('*/5 * * * *', async () => {
    if (!(await botEnabled().catch(() => true))) return;
    runReminders().catch(err => console.error('runReminders failed:', err));
    runConfirmRequests().catch(err => console.error('runConfirmRequests failed:', err));
    runAdminAlerts().catch(err => console.error('runAdminAlerts failed:', err));
    runWaitlistSweep().catch(err => console.error('runWaitlistSweep failed:', err));
  });

  // Instagram tokens live 60 days; refreshing on the 1st keeps a wide margin
  // even if a run is missed. Pruning delivered-event ids rides along.
  cron.schedule('0 4 1 * *', () => {
    refreshIgToken().catch(err => console.error('refreshIgToken failed:', err));
    db.pruneIgEvents().catch(err => console.error('pruneIgEvents failed:', err));
  });
}
