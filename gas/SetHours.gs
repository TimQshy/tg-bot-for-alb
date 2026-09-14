// ===== SetHours.js =====
// Set-working-hours wizard — ported from scenes/admin/setHours.js.
// Entered with initial state { masterId, day } from Admin.js (replaces the old
// ctx.session.setHoursCtx).

var TIME_RE_ = /^(\d{1,2}):(\d{2})$/;

function parseTime_(str) {
  var m = str.trim().match(TIME_RE_);
  if (!m) return null;
  var h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return (h < 10 ? '0' : '') + h + ':' + (min < 10 ? '0' : '') + min;
}

var SET_HOURS_SCENE = {
  steps: [
    // Step 0: show current hours for the day, ask for input
    function (ctx, session) {
      var masterId = session.state.masterId, day = session.state.day;
      if (masterId === undefined || day === undefined) {
        ctx.reply('Ошибка контекста. Попробуйте снова через /admin');
        leaveScene_(ctx.from.id);
        return;
      }

      var existing = Db.getWorkingHours(masterId, day);
      var dayName = DAYS_FULL_[day];
      var current = existing
        ? ('Сейчас: *' + existing.start_time.slice(0, 5) + ' – ' + existing.end_time.slice(0, 5) + '*')
        : 'Сейчас: выходной';

      ctx.reply(
        '🕐 *' + dayName + '*\n' + current + '\n\n' +
        'Введите время в формате *ЧЧ:ММ–ЧЧ:ММ*\nнапример: 9:00–18:00',
        Object.assign({ parse_mode: 'Markdown' }, ik_([
          [btn_('🚫 Сделать выходным', 'day_off')],
          [btn_('❌ Отмена', 'cancel')],
        ]))
      );
      advanceScene_(ctx, session);
    },

    // Step 1: handle response
    function (ctx, session) {
      var masterId = session.state.masterId, day = session.state.day;

      if (ctx.callbackQuery) {
        ctx.answerCbQuery();
        if (ctx.callbackQuery.data === 'cancel') {
          ctx.reply('Отменено.');
          leaveScene_(ctx.from.id);
          return;
        }
        if (ctx.callbackQuery.data === 'day_off') {
          Db.deleteWorkingHour(masterId, day);
          ctx.reply('✅ *' + DAYS_FULL_[day] + '* — теперь выходной.', { parse_mode: 'Markdown' });
          leaveScene_(ctx.from.id);
          return;
        }
        return;
      }

      if (!ctx.message || !ctx.message.text) return;

      var input = ctx.message.text.trim();
      var rangeParts = input.split(/\s*[-–—]\s*/);
      if (rangeParts.length !== 2) {
        ctx.reply('Формат: ЧЧ:ММ–ЧЧ:ММ, например 9:00–18:00');
        return;
      }

      var start = parseTime_(rangeParts[0]);
      var end = parseTime_(rangeParts[1]);
      if (!start || !end) {
        ctx.reply('Некорректное время. Попробуйте ещё раз (например: 9:00–18:00)');
        return;
      }
      if (start >= end) {
        ctx.reply('Время начала должно быть раньше времени окончания.');
        return;
      }

      Db.setWorkingHour(masterId, day, start, end);
      ctx.reply('✅ *' + DAYS_FULL_[day] + ':* ' + start + ' – ' + end, { parse_mode: 'Markdown' });
      leaveScene_(ctx.from.id);
    },
  ],

  onStart: function (ctx) { leaveScene_(ctx.from.id); },
};
