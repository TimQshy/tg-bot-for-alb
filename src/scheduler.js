// Background jobs: appointment reminders (24h/2h before) and waitlist-offer
// timeouts. Runs inside the same process via node-cron — state lives in
// Postgres (appointments.reminder_*_sent, waitlist.offered_at), so a restart
// between ticks doesn't lose anything; the next tick just picks it up.
import cron from 'node-cron';
import { db } from './database.js';
import { sendText } from './whatsapp.js';
import { formatDateFull } from './utils.js';
import { expireStaleOffers } from './waitlist.js';
import { refreshIgToken } from './instagram.js';
import { botEnabled } from './botState.js';

const WAITLIST_OFFER_TIMEOUT_MIN = parseInt(process.env.WAITLIST_OFFER_TIMEOUT_MIN || '30', 10);

async function sendReminder(appt, label) {
  await sendText(
    appt.user_id,
    `⏰ Напоминание: у вас запись ${label}\n\n` +
      `💅 ${appt.service_name}\n👩 ${appt.master_name}\n` +
      `📅 ${formatDateFull(String(appt.appointment_date).slice(0, 10))}\n` +
      `🕐 ${String(appt.start_time).slice(0, 5)} – ${String(appt.end_time).slice(0, 5)}`
  );
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
    expireStaleOffers(WAITLIST_OFFER_TIMEOUT_MIN).catch(err => console.error('expireStaleOffers failed:', err));
  });

  // Instagram tokens live 60 days; refreshing on the 1st keeps a wide margin
  // even if a run is missed. Pruning delivered-event ids rides along.
  cron.schedule('0 4 1 * *', () => {
    refreshIgToken().catch(err => console.error('refreshIgToken failed:', err));
    db.pruneIgEvents().catch(err => console.error('pruneIgEvents failed:', err));
  });
}
