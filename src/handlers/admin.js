import { Markup } from 'telegraf';
import { db } from '../database.js';
import { formatDateFull, addDays, todayStr, DAYS_SHORT_EXPORT as DAYS_S, DAYS_FULL_EXPORT as DAYS_F } from '../utils.js';

const ADMIN_IDS = () => (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);

export function isAdmin(userId) {
  return ADMIN_IDS().includes(userId);
}

function toDateStr(v) {
  if (v instanceof Date) return v.toISOString().split('T')[0];
  return String(v).split('T')[0];
}

function t(v) { return String(v).slice(0, 5); }

// ── Keyboards ─────────────────────────────────────────────────────────────

function mainMenuKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📅 Сегодня', 'admin:sched:today'),
     Markup.button.callback('📅 Завтра', 'admin:sched:tomorrow')],
    [Markup.button.callback('🗓 По дате', 'admin:sched:pick')],
    [Markup.button.callback('📋 Все предстоящие', 'admin:upcoming')],
    [Markup.button.callback('👩 Мастера', 'admin:masters'),
     Markup.button.callback('💅 Услуги', 'admin:services')],
  ]);
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function showSchedule(ctx, dateStr) {
  const appts = await db.getAppointmentsByDate(dateStr);
  const label = formatDateFull(dateStr);

  if (!appts.length) {
    return edit(ctx,
      `📅 *${label}*\n\nЗаписей нет.`,
      { parse_mode: 'Markdown', ...backKb('admin:menu') }
    );
  }

  let text = `📅 *${label}* — ${appts.length} зап.\n\n`;
  const rows = [];

  for (const a of appts) {
    const user = a.user_first_name + (a.user_last_name ? ` ${a.user_last_name}` : '');
    const tag  = a.user_username ? ` @${a.user_username}` : '';
    text +=
      `🕐 *${t(a.start_time)}–${t(a.end_time)}* | ${a.service_name} | ${a.master_name}\n` +
      `👤 ${user}${tag} · #${a.id}\n\n`;
    rows.push([Markup.button.callback(`❌ Отменить #${a.id}`, `admin:cancel:${a.id}`)]);
  }

  rows.push([Markup.button.callback('⬅️ Назад', 'admin:menu')]);
  return edit(ctx, text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}

function edit(ctx, text, opts) {
  return ctx.callbackQuery
    ? ctx.editMessageText(text, opts)
    : ctx.reply(text, opts);
}

function backKb(action) {
  return Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', action)]]);
}

// ── Entry points ──────────────────────────────────────────────────────────

export async function adminCommand(ctx) {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Нет доступа.');
  await ctx.reply('🎛 *Панель администратора*', { parse_mode: 'Markdown', ...mainMenuKb() });
}

// Single handler for ALL admin:* callbacks
export async function adminActions(ctx) {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('⛔ Нет доступа');
    return;
  }
  await ctx.answerCbQuery();

  const data = ctx.callbackQuery.data;

  // ── Main menu ─────────────────────────────────────────────────────────
  if (data === 'admin:menu') {
    return edit(ctx, '🎛 *Панель администратора*', {
      parse_mode: 'Markdown', ...mainMenuKb(),
    });
  }

  // ── Schedule ──────────────────────────────────────────────────────────
  if (data === 'admin:sched:today')    return showSchedule(ctx, todayStr());
  if (data === 'admin:sched:tomorrow') return showSchedule(ctx, addDays(todayStr(), 1));

  if (data === 'admin:sched:pick') {
    const today = todayStr();
    const rows  = [];
    const dates = Array.from({ length: 31 }, (_, i) => addDays(today, i));
    for (let i = 0; i < dates.length; i += 5) {
      rows.push(dates.slice(i, i + 5).map(d => {
        const [, , dd] = d.split('-');
        const [, mm]   = d.split('-');
        return Markup.button.callback(`${parseInt(dd)}.${parseInt(mm)}`, `admin:sched:d:${d}`);
      }));
    }
    rows.push([Markup.button.callback('⬅️ Назад', 'admin:menu')]);
    return edit(ctx, '🗓 Выберите дату:', { ...Markup.inlineKeyboard(rows) });
  }

  if (data.startsWith('admin:sched:d:')) {
    return showSchedule(ctx, data.replace('admin:sched:d:', ''));
  }

  // ── Upcoming ──────────────────────────────────────────────────────────
  if (data === 'admin:upcoming') {
    const appts = await db.getUpcomingAppointments(20);
    if (!appts.length) {
      return edit(ctx, '📋 Нет предстоящих записей.', backKb('admin:menu'));
    }

    let text = '📋 *Предстоящие записи:*\n\n';
    const rows = [];
    for (const a of appts) {
      const dateStr = toDateStr(a.appointment_date);
      const user    = a.user_first_name + (a.user_last_name ? ` ${a.user_last_name}` : '');
      text +=
        `📅 *${formatDateFull(dateStr)}*  ${t(a.start_time)}–${t(a.end_time)}\n` +
        `💅 ${a.service_name}  👩 ${a.master_name}\n` +
        `👤 ${user}${a.user_username ? ` @${a.user_username}` : ''}  #${a.id}\n\n`;
      rows.push([Markup.button.callback(`❌ Отменить #${a.id}`, `admin:cancel:${a.id}`)]);
    }
    rows.push([Markup.button.callback('⬅️ Назад', 'admin:menu')]);
    return edit(ctx, text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
  }

  // ── Cancel appointment ────────────────────────────────────────────────
  if (data.startsWith('admin:cancel:')) {
    const id   = parseInt(data.split(':')[2]);
    const appt = await db.getAppointmentById(id);

    if (!appt || appt.status !== 'confirmed') {
      return edit(ctx, 'Запись уже отменена или не найдена.', backKb('admin:menu'));
    }

    await db.cancelAppointment(id);

    const dateStr = toDateStr(appt.appointment_date);
    ctx.telegram.sendMessage(
      appt.user_id,
      `❌ *Ваша запись отменена салоном*\n\n` +
      `💅 ${appt.service_name}\n` +
      `👩 ${appt.master_name}\n` +
      `📅 ${formatDateFull(dateStr)}\n` +
      `🕐 ${t(appt.start_time)} – ${t(appt.end_time)}\n\n` +
      `Для новой записи: /start`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});

    return edit(ctx, `✅ Запись #${id} отменена. Клиент уведомлён.`, backKb('admin:menu'));
  }

  // ── Masters list ──────────────────────────────────────────────────────
  if (data === 'admin:masters') {
    const masters = await db.getAllMasters();
    const rows = masters.map(m => [
      Markup.button.callback(`${m.is_active ? '✅' : '❌'} ${m.name}`, `admin:master:${m.id}`),
    ]);
    rows.push([Markup.button.callback('➕ Добавить мастера', 'admin:master:add')]);
    rows.push([Markup.button.callback('⬅️ Назад', 'admin:menu')]);
    return edit(ctx, '👩 *Мастера:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
  }

  // ── Add master ────────────────────────────────────────────────────────
  if (data === 'admin:master:add') {
    return ctx.scene.enter('addMaster');
  }

  // ── Toggle master active ──────────────────────────────────────────────
  if (data.startsWith('admin:master:toggle:')) {
    const id     = parseInt(data.split(':')[3]);
    const master = await db.toggleMasterActive(id);
    return edit(
      ctx,
      `${master.is_active ? '✅ Активирован' : '❌ Деактивирован'}: *${master.name}*`,
      { parse_mode: 'Markdown', ...backKb('admin:masters') }
    );
  }

  // ── Master services toggle ────────────────────────────────────────────
  if (data.startsWith('admin:mastersvc:toggle:')) {
    const parts     = data.split(':');
    const masterId  = parseInt(parts[3]);
    const serviceId = parseInt(parts[4]);
    const current   = await db.getMasterServices(masterId);
    if (current.some(s => s.id === serviceId)) {
      await db.removeMasterService(masterId, serviceId);
    } else {
      await db.addMasterService(masterId, serviceId);
    }
    // Re-render the same screen
    ctx.callbackQuery.data = `admin:mastersvc:${masterId}`;
    return adminActions(ctx);
  }

  // ── Master services list ──────────────────────────────────────────────
  if (data.startsWith('admin:mastersvc:')) {
    const masterId  = parseInt(data.split(':')[2]);
    const master    = await db.getMaster(masterId);
    const allSvcs   = await db.getAllServices();
    const masterSvc = await db.getMasterServices(masterId);
    const assigned  = new Set(masterSvc.map(s => s.id));

    const rows = allSvcs.map(s => [
      Markup.button.callback(
        `${assigned.has(s.id) ? '✅' : '☐'} ${s.name}`,
        `admin:mastersvc:toggle:${masterId}:${s.id}`
      ),
    ]);
    rows.push([Markup.button.callback('⬅️ Назад', `admin:master:${masterId}`)]);
    return edit(ctx, `💅 *Услуги: ${master.name}*`, {
      parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows),
    });
  }

  // ── Set working hours for a specific day ─────────────────────────────
  if (data.startsWith('admin:hours:set:')) {
    const parts    = data.split(':');
    const masterId = parseInt(parts[3]);
    const day      = parseInt(parts[4]);
    ctx.session.setHoursCtx = { masterId, day };
    return ctx.scene.enter('setHours');
  }

  // ── Working hours overview for master ────────────────────────────────
  if (data.startsWith('admin:hours:')) {
    const masterId = parseInt(data.split(':')[2]);
    const master   = await db.getMaster(masterId);
    const hours    = await db.getAllWorkingHours(masterId);
    const map      = Object.fromEntries(hours.map(h => [h.day_of_week, h]));

    const rows = Array.from({ length: 7 }, (_, d) => {
      const h     = map[d];
      const label = h
        ? `${DAYS_S[d]}  ${h.start_time.slice(0, 5)}–${h.end_time.slice(0, 5)}`
        : `${DAYS_S[d]}  — выходной`;
      return [Markup.button.callback(label, `admin:hours:set:${masterId}:${d}`)];
    });
    rows.push([Markup.button.callback('⬅️ Назад', `admin:master:${masterId}`)]);

    return edit(ctx, `🕐 *График: ${master.name}*\nНажмите на день для изменения:`, {
      parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows),
    });
  }

  // ── Master detail ─────────────────────────────────────────────────────
  if (data.startsWith('admin:master:')) {
    const masterId = parseInt(data.split(':')[2]);
    const master   = await db.getMaster(masterId);
    const svcs     = await db.getMasterServices(masterId);
    const hours    = await db.getAllWorkingHours(masterId);

    const svcList   = svcs.length ? svcs.map(s => s.name).join(', ') : 'не назначены';
    const hoursList = hours.length
      ? hours.map(h => `${DAYS_S[h.day_of_week]} ${h.start_time.slice(0,5)}–${h.end_time.slice(0,5)}`).join('  ')
      : 'не задан';

    return edit(ctx,
      `👩 *${master.name}*  ${master.is_active ? '✅ активен' : '❌ неактивен'}\n\n` +
      `💅 Услуги: ${svcList}\n` +
      `🕐 График: ${hoursList}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(
            master.is_active ? '❌ Деактивировать' : '✅ Активировать',
            `admin:master:toggle:${masterId}`
          )],
          [Markup.button.callback('💅 Услуги мастера', `admin:mastersvc:${masterId}`)],
          [Markup.button.callback('🕐 Рабочие часы',   `admin:hours:${masterId}`)],
          [Markup.button.callback('⬅️ Назад', 'admin:masters')],
        ]),
      }
    );
  }

  // ── Services list ─────────────────────────────────────────────────────
  if (data === 'admin:services') {
    const svcs = await db.getAllServices();
    const rows = svcs.map(s => [
      Markup.button.callback(
        `${s.is_active ? '✅' : '❌'} ${s.name}  —  ${s.price}₽`,
        `admin:service:${s.id}`
      ),
    ]);
    rows.push([Markup.button.callback('➕ Добавить услугу', 'admin:service:add')]);
    rows.push([Markup.button.callback('⬅️ Назад', 'admin:menu')]);
    return edit(ctx, '💅 *Услуги:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
  }

  // ── Add service ───────────────────────────────────────────────────────
  if (data === 'admin:service:add') {
    return ctx.scene.enter('addService');
  }

  // ── Toggle service active ─────────────────────────────────────────────
  if (data.startsWith('admin:service:toggle:')) {
    const id  = parseInt(data.split(':')[3]);
    const svc = await db.toggleServiceActive(id);
    return edit(ctx,
      `${svc.is_active ? '✅ Активирована' : '❌ Деактивирована'}: *${svc.name}*`,
      { parse_mode: 'Markdown', ...backKb('admin:services') }
    );
  }

  // ── Service detail ────────────────────────────────────────────────────
  if (data.startsWith('admin:service:')) {
    const id  = parseInt(data.split(':')[2]);
    const svc = await db.getService(id);
    if (!svc) return;

    return edit(ctx,
      `💅 *${svc.name}*  ${svc.is_active ? '✅' : '❌'}\n\n` +
      `⏱ ${svc.duration_minutes} мин  ·  💰 ${svc.price}₽` +
      (svc.description ? `\n📝 ${svc.description}` : ''),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(
            svc.is_active ? '❌ Деактивировать' : '✅ Активировать',
            `admin:service:toggle:${id}`
          )],
          [Markup.button.callback('⬅️ Назад', 'admin:services')],
        ]),
      }
    );
  }
}
