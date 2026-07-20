import { Scenes, Markup } from 'telegraf';
import { db } from '../../database.js';
import { DAYS_FULL_EXPORT as DAYS } from '../../utils.js';

const TIME_RE = /^(\d{1,2}):(\d{2})$/;

function parseTime(str) {
  const m = str.trim().match(TIME_RE);
  if (!m) return null;
  const h = parseInt(m[1]), min = parseInt(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export const setHoursScene = new Scenes.WizardScene(
  'setHours',

  // Step 0: show current hours for the day, ask for input
  async (ctx) => {
    const { masterId, day } = ctx.session.setHoursCtx || {};
    if (masterId === undefined || day === undefined) {
      await ctx.reply('Ошибка контекста. Попробуйте снова через /admin');
      return ctx.scene.leave();
    }

    const existing = await db.getWorkingHours(masterId, day);
    const dayName  = DAYS[day];
    const current  = existing
      ? `Сейчас: *${existing.start_time.slice(0, 5)} – ${existing.end_time.slice(0, 5)}*`
      : 'Сейчас: выходной';

    await ctx.reply(
      `🕐 *${dayName}*\n${current}\n\n` +
      `Введите время в формате *ЧЧ:ММ–ЧЧ:ММ*\nнапример: 9:00–18:00`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🚫 Сделать выходным', 'day_off')],
          [Markup.button.callback('❌ Отмена', 'cancel')],
        ]),
      }
    );
    return ctx.wizard.next();
  },

  // Step 1: handle response
  async (ctx) => {
    const { masterId, day } = ctx.session.setHoursCtx || {};

    if (ctx.callbackQuery) {
      await ctx.answerCbQuery();
      if (ctx.callbackQuery.data === 'cancel') {
        await ctx.reply('Отменено.');
        ctx.session.setHoursCtx = null;
        return ctx.scene.leave();
      }
      if (ctx.callbackQuery.data === 'day_off') {
        await db.deleteWorkingHour(masterId, day);
        await ctx.reply(`✅ *${DAYS[day]}* — теперь выходной.`, { parse_mode: 'Markdown' });
        ctx.session.setHoursCtx = null;
        return ctx.scene.leave();
      }
      return;
    }

    if (!ctx.message?.text) return;

    const input = ctx.message.text.trim();
    const rangeParts = input.split(/\s*[-–—]\s*/);
    if (rangeParts.length !== 2) {
      await ctx.reply('Формат: ЧЧ:ММ–ЧЧ:ММ, например 9:00–18:00');
      return;
    }

    const start = parseTime(rangeParts[0]);
    const end   = parseTime(rangeParts[1]);
    if (!start || !end) {
      await ctx.reply('Некорректное время. Попробуйте ещё раз (например: 9:00–18:00)');
      return;
    }
    if (start >= end) {
      await ctx.reply('Время начала должно быть раньше времени окончания.');
      return;
    }

    await db.setWorkingHour(masterId, day, start, end);
    await ctx.reply(
      `✅ *${DAYS[day]}:* ${start} – ${end}`,
      { parse_mode: 'Markdown' }
    );
    ctx.session.setHoursCtx = null;
    return ctx.scene.leave();
  }
);

setHoursScene.command('start', ctx => { ctx.session.setHoursCtx = null; ctx.scene.leave(); });
