import { Scenes, Markup } from 'telegraf';
import { db } from '../../database.js';

export const addMasterScene = new Scenes.WizardScene(
  'addMaster',

  // Step 0: ask name
  async (ctx) => {
    await ctx.reply(
      '👩 *Добавить мастера*\n\nВведите имя:',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'cancel')]]) }
    );
    return ctx.wizard.next();
  },

  // Step 1: save name, ask description
  async (ctx) => {
    if (ctx.callbackQuery?.data === 'cancel') {
      await ctx.answerCbQuery();
      await ctx.reply('Отменено.');
      return ctx.scene.leave();
    }
    if (!ctx.message?.text) return;

    ctx.scene.state.name = ctx.message.text.trim();

    await ctx.reply('Описание мастера (специализация, стаж …)\nИли пропустите:', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⏭ Пропустить', 'skip')],
        [Markup.button.callback('❌ Отмена', 'cancel')],
      ]),
    });
    return ctx.wizard.next();
  },

  // Step 2: save description → create
  async (ctx) => {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery();
      if (ctx.callbackQuery.data === 'cancel') { await ctx.reply('Отменено.'); return ctx.scene.leave(); }
      if (ctx.callbackQuery.data === 'skip') ctx.scene.state.description = null;
    } else if (ctx.message?.text) {
      ctx.scene.state.description = ctx.message.text.trim();
    } else {
      return;
    }

    const master = await db.createMaster(ctx.scene.state);
    await ctx.reply(
      `✅ Мастер *${master.name}* добавлен (id: ${master.id}).\n\n` +
      `Назначьте услуги и рабочие часы через /admin → Мастера → ${master.name}`,
      { parse_mode: 'Markdown' }
    );
    return ctx.scene.leave();
  }
);

addMasterScene.command('start', ctx => ctx.scene.leave());
