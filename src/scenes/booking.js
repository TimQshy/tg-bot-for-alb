import { Scenes, Markup } from 'telegraf';
import { db } from '../database.js';
import {
  formatDateShort, formatDateFull, getAvailableDates, getTimeSlotsForMaster,
} from '../utils.js';

const ADMIN_IDS = () => (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);

export const bookingScene = new Scenes.WizardScene(
  'booking',

  // ── Step 0: show services ───────────────────────────────────────────────
  async (ctx) => {
    const services = await db.getActiveServices();
    if (!services.length) {
      await ctx.reply('😔 Нет доступных услуг. Свяжитесь с салоном.');
      return ctx.scene.leave();
    }

    const buttons = services.map(s => [
      Markup.button.callback(
        `${s.name}  —  ${s.price}₽  ·  ${s.duration_minutes} мин`,
        `svc:${s.id}`
      ),
    ]);
    buttons.push([Markup.button.callback('❌ Отмена', 'cancel')]);

    await ctx.reply('💅 *Запись в салон*\n\nВыберите услугу:', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
    return ctx.wizard.next();
  },

  // ── Step 1: service chosen → show masters ───────────────────────────────
  async (ctx) => {
    if (!ctx.callbackQuery) return;
    await ctx.answerCbQuery();
    const data = ctx.callbackQuery.data;

    if (data === 'cancel') {
      await ctx.editMessageText('Запись отменена.');
      return ctx.scene.leave();
    }
    if (!data.startsWith('svc:')) return;

    const serviceId = parseInt(data.split(':')[1]);
    const service = await db.getService(serviceId);
    if (!service) return ctx.scene.leave();

    ctx.scene.state = {
      serviceId,
      serviceName: service.name,
      serviceDuration: service.duration_minutes,
      servicePrice: service.price,
    };

    const masters = await db.getMastersForService(serviceId);
    if (!masters.length) {
      await ctx.editMessageText('😔 Нет доступных мастеров для этой услуги.');
      return ctx.scene.leave();
    }

    const buttons = masters.map(m => [
      Markup.button.callback(
        m.description ? `${m.name}  ·  ${m.description}` : m.name,
        `mst:${m.id}`
      ),
    ]);
    buttons.push([Markup.button.callback('❌ Отмена', 'cancel')]);

    await ctx.editMessageText(
      `💅 *${service.name}*\n💰 ${service.price}₽  ·  ⏱ ${service.duration_minutes} мин\n\nВыберите мастера:`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
    return ctx.wizard.next();
  },

  // ── Step 2: master chosen → show dates ─────────────────────────────────
  async (ctx) => {
    if (!ctx.callbackQuery) return;
    await ctx.answerCbQuery();
    const data = ctx.callbackQuery.data;

    if (data === 'cancel') {
      await ctx.editMessageText('Запись отменена.');
      return ctx.scene.leave();
    }
    if (!data.startsWith('mst:')) return;

    const masterId = parseInt(data.split(':')[1]);
    const master = await db.getMaster(masterId);
    if (!master) return ctx.scene.leave();

    ctx.scene.state.masterId  = masterId;
    ctx.scene.state.masterName = master.name;

    const dates = await getAvailableDates(masterId, 14);
    if (!dates.length) {
      await ctx.editMessageText(
        `😔 У мастера *${master.name}* нет свободных дат на ближайшие 2 недели.`,
        { parse_mode: 'Markdown' }
      );
      return ctx.scene.leave();
    }

    const rows = [];
    for (let i = 0; i < dates.length; i += 3) {
      rows.push(
        dates.slice(i, i + 3).map(d =>
          Markup.button.callback(formatDateShort(d), `dt:${d}`)
        )
      );
    }
    rows.push([Markup.button.callback('❌ Отмена', 'cancel')]);

    await ctx.editMessageText(
      `💅 *${ctx.scene.state.serviceName}*\n👩 ${master.name}\n\nВыберите дату:`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
    );
    return ctx.wizard.next();
  },

  // ── Step 3: date chosen → show time slots ──────────────────────────────
  async (ctx) => {
    if (!ctx.callbackQuery) return;
    await ctx.answerCbQuery();
    const data = ctx.callbackQuery.data;

    if (data === 'cancel') {
      await ctx.editMessageText('Запись отменена.');
      return ctx.scene.leave();
    }
    if (!data.startsWith('dt:')) return;

    const dateStr = data.split(':')[1];
    ctx.scene.state.date = dateStr;

    const slots = await getTimeSlotsForMaster(
      ctx.scene.state.masterId, dateStr, ctx.scene.state.serviceDuration
    );

    if (!slots.length) {
      await ctx.editMessageText('😔 На эту дату нет свободных слотов. Попробуйте другую дату.');
      return ctx.scene.leave();
    }

    const rows = [];
    for (let i = 0; i < slots.length; i += 4) {
      rows.push(
        slots.slice(i, i + 4).map(s =>
          Markup.button.callback(s.start, `slot:${s.start}:${s.end}`)
        )
      );
    }
    rows.push([Markup.button.callback('❌ Отмена', 'cancel')]);

    const s = ctx.scene.state;
    await ctx.editMessageText(
      `💅 *${s.serviceName}*\n👩 ${s.masterName}\n📅 ${formatDateFull(dateStr)}\n\nВыберите время:`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
    );
    return ctx.wizard.next();
  },

  // ── Step 4: time chosen → confirmation screen ──────────────────────────
  async (ctx) => {
    if (!ctx.callbackQuery) return;
    await ctx.answerCbQuery();
    const data = ctx.callbackQuery.data;

    if (data === 'cancel') {
      await ctx.editMessageText('Запись отменена.');
      return ctx.scene.leave();
    }
    if (!data.startsWith('slot:')) return;

    const parts = data.split(':');
    ctx.scene.state.startTime = parts[1];
    ctx.scene.state.endTime   = parts[2];

    const s = ctx.scene.state;
    await ctx.editMessageText(
      `✅ *Подтвердите запись:*\n\n` +
      `💅 Услуга: *${s.serviceName}*\n` +
      `👩 Мастер: *${s.masterName}*\n` +
      `📅 Дата: *${formatDateFull(s.date)}*\n` +
      `🕐 Время: *${s.startTime} – ${s.endTime}*\n` +
      `💰 Стоимость: *${s.servicePrice}₽*`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Подтвердить', 'confirm')],
          [Markup.button.callback('❌ Отмена', 'cancel')],
        ]),
      }
    );
    return ctx.wizard.next();
  },

  // ── Step 5: confirmed → create appointment ─────────────────────────────
  async (ctx) => {
    if (!ctx.callbackQuery) return;
    await ctx.answerCbQuery();
    const data = ctx.callbackQuery.data;

    if (data === 'cancel') {
      await ctx.editMessageText('Запись отменена.');
      return ctx.scene.leave();
    }
    if (data !== 'confirm') return;

    const s = ctx.scene.state;

    await db.upsertUser({
      id: ctx.from.id,
      username:    ctx.from.username,
      first_name:  ctx.from.first_name,
      last_name:   ctx.from.last_name,
    });

    // Race-condition guard
    const available = await db.isSlotAvailable(s.masterId, s.date, s.startTime, s.endTime);
    if (!available) {
      await ctx.editMessageText('😔 Этот слот только что заняли. Начните запись заново — /start');
      return ctx.scene.leave();
    }

    const appt = await db.createAppointment({
      userId:    ctx.from.id,
      masterId:  s.masterId,
      serviceId: s.serviceId,
      date:      s.date,
      startTime: s.startTime,
      endTime:   s.endTime,
    });

    await ctx.editMessageText(
      `🎉 *Запись подтверждена!*\n\n` +
      `💅 ${s.serviceName}\n` +
      `👩 ${s.masterName}\n` +
      `📅 ${formatDateFull(s.date)}\n` +
      `🕐 ${s.startTime} – ${s.endTime}\n` +
      `💰 ${s.servicePrice}₽\n\n` +
      `📋 Номер записи: *#${appt.id}*\n\n` +
      `Мы напомним за 24 ч и за 1 ч до визита. До встречи! 👋`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📋 Мои записи', 'my_bookings')],
          [Markup.button.callback('🏠 Главное меню', 'main_menu')],
        ]),
      }
    );

    // Notify admins
    const userName = ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');
    const tag = ctx.from.username ? ` (@${ctx.from.username})` : '';
    const adminText =
      `📩 *Новая запись #${appt.id}*\n\n` +
      `👤 ${userName}${tag}\n` +
      `💅 ${s.serviceName}\n` +
      `👩 ${s.masterName}\n` +
      `📅 ${formatDateFull(s.date)}\n` +
      `🕐 ${s.startTime} – ${s.endTime}`;

    for (const adminId of ADMIN_IDS()) {
      ctx.telegram.sendMessage(adminId, adminText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`❌ Отменить #${appt.id}`, `admin:cancel:${appt.id}`)],
        ]),
      }).catch(() => {});
    }

    return ctx.scene.leave();
  }
);

// Allow /start to escape the scene
bookingScene.command('start', async (ctx) => {
  await ctx.scene.leave();
  await ctx.reply('Используйте кнопки ниже:', Markup.inlineKeyboard([
    [Markup.button.callback('✂️ Записаться', 'book')],
    [Markup.button.callback('📋 Мои записи', 'my_bookings')],
  ]));
});
