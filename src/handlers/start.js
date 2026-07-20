import { Markup } from 'telegraf';
import { db } from '../database.js';

export async function startHandler(ctx) {
  const isCallback = !!ctx.callbackQuery;
  if (isCallback) await ctx.answerCbQuery();

  if (ctx.from) {
    await db.upsertUser({
      id:         ctx.from.id,
      username:   ctx.from.username,
      first_name: ctx.from.first_name,
      last_name:  ctx.from.last_name,
    });
  }

  const name = ctx.from?.first_name || 'Гость';
  const text =
    `👋 Привет, *${name}*!\n\n` +
    `Добро пожаловать в наш салон красоты.\n` +
    `Записаться на процедуру — в пару кликов.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✂️ Записаться', 'book')],
    [Markup.button.callback('📋 Мои записи', 'my_bookings')],
  ]);

  if (isCallback) {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }
}
