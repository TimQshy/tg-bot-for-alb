import cron from 'node-cron';
import { db } from '../database.js';
import { formatDateFull } from '../utils.js';

function toDateStr(v) {
  if (v instanceof Date) return v.toISOString().split('T')[0];
  return String(v).split('T')[0];
}

export function startReminderService(bot) {
  // Runs every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    processReminders(bot).catch(err => console.error('Reminder error:', err));
  });
  console.log('Reminder service started (every 5 min)');
}

async function processReminders(bot) {
  const [r24, r1h] = await Promise.all([
    db.getPendingReminders24h(),
    db.getPendingReminders1h(),
  ]);

  for (const a of r24) await sendReminder(bot, a, '24h');
  for (const a of r1h) await sendReminder(bot, a, '1h');
}

async function sendReminder(bot, appt, type) {
  const dateStr   = toDateStr(appt.appointment_date);
  const start     = String(appt.start_time).slice(0, 5);
  const end       = String(appt.end_time).slice(0, 5);
  const timeLabel = type === '24h' ? 'завтра' : 'через час';

  const text =
    `🔔 *Напоминание о записи*\n\n` +
    `Вы записаны *${timeLabel}*:\n\n` +
    `💅 ${appt.service_name}\n` +
    `👩 ${appt.master_name}\n` +
    `📅 ${formatDateFull(dateStr)}\n` +
    `🕐 ${start} – ${end}\n\n` +
    `Ждём вас! 💇‍♀️`;

  try {
    await bot.telegram.sendMessage(appt.tg_user_id, text, { parse_mode: 'Markdown' });
    await db.markReminderSent(appt.id, type);
  } catch (err) {
    console.error(`Reminder ${type} failed for appt #${appt.id}:`, err.message);
  }
}
