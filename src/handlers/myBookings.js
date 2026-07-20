import { Markup } from 'telegraf';
import { db } from '../database.js';
import { formatDateFull } from '../utils.js';

function toDateStr(dateVal) {
  // dateVal may be a Date object from pg
  if (dateVal instanceof Date) return dateVal.toISOString().split('T')[0];
  return String(dateVal).split('T')[0];
}

function sliceTime(t) {
  return String(t).slice(0, 5);
}

export async function myBookingsHandler(ctx) {
  const isCallback = !!ctx.callbackQuery;
  if (isCallback) await ctx.answerCbQuery();

  const appts = await db.getUserAppointments(ctx.from.id);

  if (!appts.length) {
    const text = '📋 У вас нет активных записей.';
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('✂️ Записаться', 'book')],
      [Markup.button.callback('🏠 Главное меню', 'main_menu')],
    ]);
    return isCallback
      ? ctx.editMessageText(text, kb)
      : ctx.reply(text, kb);
  }

  let text = '📋 *Ваши записи:*\n\n';
  const buttons = [];

  for (const a of appts) {
    const dateStr = toDateStr(a.appointment_date);
    const start   = sliceTime(a.start_time);
    const end     = sliceTime(a.end_time);
    text +=
      `💅 *${a.service_name}*\n` +
      `👩 ${a.master_name}\n` +
      `📅 ${formatDateFull(dateStr)}\n` +
      `🕐 ${start} – ${end}  ·  💰 ${a.price}₽\n\n`;
    buttons.push([Markup.button.callback(`❌ Отменить запись #${a.id}`, `cancel_appt:${a.id}`)]);
  }

  buttons.push([Markup.button.callback('✂️ Новая запись', 'book')]);
  buttons.push([Markup.button.callback('🏠 Главное меню', 'main_menu')]);

  const kb = Markup.inlineKeyboard(buttons);

  return isCallback
    ? ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb })
    : ctx.reply(text, { parse_mode: 'Markdown', ...kb });
}

export async function cancelApptAction(ctx) {
  await ctx.answerCbQuery();
  const apptId = parseInt(ctx.callbackQuery.data.split(':')[1]);
  const appt   = await db.getAppointmentById(apptId);

  if (!appt || appt.status !== 'confirmed' || appt.user_id !== ctx.from.id) {
    return ctx.editMessageText('Запись не найдена или уже отменена.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'my_bookings')]]),
    });
  }

  const dateStr = toDateStr(appt.appointment_date);
  await ctx.editMessageText(
    `❓ *Отменить запись?*\n\n` +
    `💅 ${appt.service_name}\n` +
    `👩 ${appt.master_name}\n` +
    `📅 ${formatDateFull(dateStr)}\n` +
    `🕐 ${sliceTime(appt.start_time)} – ${sliceTime(appt.end_time)}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Да, отменить', `confirm_cancel:${apptId}`)],
        [Markup.button.callback('⬅️ Нет, назад', 'my_bookings')],
      ]),
    }
  );
}

export async function confirmCancelAction(ctx) {
  await ctx.answerCbQuery();
  const apptId = parseInt(ctx.callbackQuery.data.split(':')[1]);
  const appt   = await db.getAppointmentById(apptId);

  if (!appt || appt.status !== 'confirmed') {
    return ctx.editMessageText('Запись уже отменена.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('📋 Мои записи', 'my_bookings')]]),
    });
  }

  await db.cancelAppointment(apptId);
  await ctx.editMessageText('✅ Запись отменена.', {
    ...Markup.inlineKeyboard([[Markup.button.callback('📋 Мои записи', 'my_bookings')]]),
  });
}
