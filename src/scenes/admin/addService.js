import { Scenes, Markup } from 'telegraf';
import { db } from '../../database.js';

export const addServiceScene = new Scenes.WizardScene(
  'addService',

  // Step 0: ask name
  async (ctx) => {
    await ctx.reply(
      '💅 *Добавить услугу*\n\nВведите название:',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'cancel')]]) }
    );
    return ctx.wizard.next();
  },

  // Step 1: save name, ask price
  async (ctx) => {
    if (ctx.callbackQuery?.data === 'cancel') {
      await ctx.answerCbQuery(); await ctx.reply('Отменено.'); return ctx.scene.leave();
    }
    if (!ctx.message?.text) return;
    ctx.scene.state.name = ctx.message.text.trim();
    await ctx.reply('Введите цену (₽):');
    return ctx.wizard.next();
  },

  // Step 2: save price, ask duration
  async (ctx) => {
    if (!ctx.message?.text) return;
    const price = parseFloat(ctx.message.text.replace(',', '.'));
    if (isNaN(price) || price <= 0) {
      await ctx.reply('Введите корректную цену (например: 1500):');
      return;
    }
    ctx.scene.state.price = price;
    await ctx.reply('Введите длительность в минутах (например: 60):');
    return ctx.wizard.next();
  },

  // Step 3: save duration → create
  async (ctx) => {
    if (!ctx.message?.text) return;
    const dur = parseInt(ctx.message.text);
    if (isNaN(dur) || dur < 15 || dur > 480) {
      await ctx.reply('Введите длительность от 15 до 480 минут:');
      return;
    }

    const svc = await db.createService({
      name: ctx.scene.state.name,
      description: null,
      durationMinutes: dur,
      price: ctx.scene.state.price,
    });

    await ctx.reply(
      `✅ Услуга *${svc.name}* добавлена!\n💰 ${svc.price}₽  ·  ⏱ ${svc.duration_minutes} мин\n\n` +
      `Назначьте её мастерам через /admin → Мастера`,
      { parse_mode: 'Markdown' }
    );
    return ctx.scene.leave();
  }
);

addServiceScene.command('start', ctx => ctx.scene.leave());
