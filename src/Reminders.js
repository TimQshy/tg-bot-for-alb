// Appointment reminders (24h / 1h before visit) — replaces node-cron + services/reminders.js.
// Invoked by a time-driven trigger installed via Setup.setTriggers() (every 5 min).

function checkReminders() {
  try {
    var r24 = Db.getPendingReminders24h();
    var r1h = Db.getPendingReminders1h();
    r24.forEach(function (a) { sendReminder_(a, '24h'); });
    r1h.forEach(function (a) { sendReminder_(a, '1h'); });
  } catch (err) {
    console.error('Reminder error: ' + err);
  }
}

function sendReminder_(appt, type) {
  var timeLabel = type === '24h' ? 'завтра' : 'через час';
  var text =
    '🔔 *Напоминание о записи*\n\n' +
    'Вы записаны *' + timeLabel + '*:\n\n' +
    '💅 ' + appt.service_name + '\n' +
    '👩 ' + appt.master_name + '\n' +
    '📅 ' + formatDateFull_(appt.appointment_date) + '\n' +
    '🕐 ' + String(appt.start_time).slice(0, 5) + ' – ' + String(appt.end_time).slice(0, 5) + '\n\n' +
    'Ждём вас! 💇‍♀️';

  try {
    sendMessage_(appt.tg_user_id, text, { parse_mode: 'Markdown' });
    Db.markReminderSent(appt.id, type);
  } catch (err) {
    console.error('Reminder ' + type + ' failed for appt #' + appt.id + ': ' + err);
  }
}
