// ===== Admin.js =====
// Admin panel — ported from handlers/admin.js. All admin:* callback data prefixes
// are unchanged so nothing else about the UX/keyboards needs to change.

function t_(v) {
  return String(v).slice(0, 5);
}

function mainMenuKb_() {
  return ik_([
    [btn_('📅 Сегодня', 'admin:sched:today'), btn_('📅 Завтра', 'admin:sched:tomorrow')],
    [btn_('🗓 По дате', 'admin:sched:pick')],
    [btn_('📋 Все предстоящие', 'admin:upcoming')],
    [btn_('👩 Мастера', 'admin:masters'), btn_('💅 Услуги', 'admin:services')],
  ]);
}

function edit_(ctx, text, opts) {
  return ctx.callbackQuery ? ctx.editMessageText(text, opts) : ctx.reply(text, opts);
}

function backKb_(action) {
  return ik_([[btn_('⬅️ Назад', action)]]);
}

function showSchedule_(ctx, dateStr) {
  var appts = Db.getAppointmentsByDate(dateStr);
  var label = formatDateFull_(dateStr);

  if (!appts.length) {
    edit_(ctx, '📅 *' + label + '*\n\nЗаписей нет.', Object.assign({ parse_mode: 'Markdown' }, backKb_('admin:menu')));
    return;
  }

  var text = '📅 *' + label + '* — ' + appts.length + ' зап.\n\n';
  var rows = [];

  appts.forEach(function (a) {
    var user = escMd_(a.user_first_name) + (a.user_last_name ? (' ' + escMd_(a.user_last_name)) : '');
    var tag = a.user_username ? (' @' + escMd_(a.user_username)) : '';
    text +=
      '🕐 *' + t_(a.start_time) + '–' + t_(a.end_time) + '* | ' + escMd_(a.service_name) + ' | ' + escMd_(a.master_name) + '\n' +
      '👤 ' + user + tag + ' · #' + a.id + '\n\n';
    rows.push([btn_('❌ Отменить #' + a.id, 'admin:cancel:' + a.id)]);
  });

  rows.push([btn_('⬅️ Назад', 'admin:menu')]);
  edit_(ctx, text, Object.assign({ parse_mode: 'Markdown' }, ik_(rows)));
}

// ── Entry points ─────────────────────────────────────────────────────────

function adminCommand_(ctx) {
  if (!isAdmin_(ctx.from.id)) { ctx.reply('⛔ Нет доступа.'); return; }
  ctx.reply('🎛 *Панель администратора*', Object.assign({ parse_mode: 'Markdown' }, mainMenuKb_()));
}

// Single dispatcher for ALL admin:* callbacks
function adminActions_(ctx) {
  if (!isAdmin_(ctx.from.id)) { ctx.answerCbQuery('⛔ Нет доступа'); return; }
  ctx.answerCbQuery();

  var data = ctx.callbackQuery.data;

  // ── Main menu ────────────────────────────────────────────────────────
  if (data === 'admin:menu') {
    edit_(ctx, '🎛 *Панель администратора*', Object.assign({ parse_mode: 'Markdown' }, mainMenuKb_()));
    return;
  }

  // ── Schedule ─────────────────────────────────────────────────────────
  if (data === 'admin:sched:today') { showSchedule_(ctx, todayStr_()); return; }
  if (data === 'admin:sched:tomorrow') { showSchedule_(ctx, addDays_(todayStr_(), 1)); return; }

  if (data === 'admin:sched:pick') {
    var today = todayStr_();
    var dates = [];
    for (var i = 0; i < 31; i++) dates.push(addDays_(today, i));

    var rows = [];
    for (var j = 0; j < dates.length; j += 5) {
      rows.push(dates.slice(j, j + 5).map(function (d) {
        var parts = d.split('-');
        return btn_(parseInt(parts[2], 10) + '.' + parseInt(parts[1], 10), 'admin:sched:d:' + d);
      }));
    }
    rows.push([btn_('⬅️ Назад', 'admin:menu')]);
    edit_(ctx, '🗓 Выберите дату:', ik_(rows));
    return;
  }

  if (data.indexOf('admin:sched:d:') === 0) {
    showSchedule_(ctx, data.replace('admin:sched:d:', ''));
    return;
  }

  // ── Upcoming ─────────────────────────────────────────────────────────
  if (data === 'admin:upcoming') {
    var appts = Db.getUpcomingAppointments(20);
    if (!appts.length) { edit_(ctx, '📋 Нет предстоящих записей.', backKb_('admin:menu')); return; }

    var text = '📋 *Предстоящие записи:*\n\n';
    var rows = [];
    appts.forEach(function (a) {
      var user = escMd_(a.user_first_name) + (a.user_last_name ? (' ' + escMd_(a.user_last_name)) : '');
      text +=
        '📅 *' + formatDateFull_(a.appointment_date) + '*  ' + t_(a.start_time) + '–' + t_(a.end_time) + '\n' +
        '💅 ' + escMd_(a.service_name) + '  👩 ' + escMd_(a.master_name) + '\n' +
        '👤 ' + user + (a.user_username ? (' @' + escMd_(a.user_username)) : '') + '  #' + a.id + '\n\n';
      rows.push([btn_('❌ Отменить #' + a.id, 'admin:cancel:' + a.id)]);
    });
    rows.push([btn_('⬅️ Назад', 'admin:menu')]);
    edit_(ctx, text, Object.assign({ parse_mode: 'Markdown' }, ik_(rows)));
    return;
  }

  // ── Cancel appointment ───────────────────────────────────────────────
  if (data.indexOf('admin:cancel:') === 0) {
    var id = parseInt(data.split(':')[2], 10);
    var appt = Db.getAppointmentById(id);

    if (!appt || appt.status !== 'confirmed') {
      edit_(ctx, 'Запись уже отменена или не найдена.', backKb_('admin:menu'));
      return;
    }

    Db.cancelAppointment(id);

    try {
      sendMessage_(appt.user_id,
        '❌ *Ваша запись отменена салоном*\n\n' +
        '💅 ' + escMd_(appt.service_name) + '\n' +
        '👩 ' + escMd_(appt.master_name) + '\n' +
        '📅 ' + formatDateFull_(appt.appointment_date) + '\n' +
        '🕐 ' + t_(appt.start_time) + ' – ' + t_(appt.end_time) + '\n\n' +
        'Для новой записи: /start',
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      console.error('Failed to notify client about cancellation: ' + e);
    }

    edit_(ctx, '✅ Запись #' + id + ' отменена. Клиент уведомлён.', backKb_('admin:menu'));
    return;
  }

  // ── Masters list ─────────────────────────────────────────────────────
  if (data === 'admin:masters') {
    var masters = Db.getAllMasters();
    var rows = masters.map(function (m) {
      return [btn_((m.is_active ? '✅ ' : '❌ ') + m.name, 'admin:master:' + m.id)];
    });
    rows.push([btn_('➕ Добавить мастера', 'admin:master:add')]);
    rows.push([btn_('⬅️ Назад', 'admin:menu')]);
    edit_(ctx, '👩 *Мастера:*', Object.assign({ parse_mode: 'Markdown' }, ik_(rows)));
    return;
  }

  // ── Add master ───────────────────────────────────────────────────────
  if (data === 'admin:master:add') { enterScene_(ctx, 'addMaster', {}); return; }

  // ── Toggle master active ─────────────────────────────────────────────
  if (data.indexOf('admin:master:toggle:') === 0) {
    var id = parseInt(data.split(':')[3], 10);
    var master = Db.toggleMasterActive(id);
    edit_(ctx,
      (master.is_active ? '✅ Активирован' : '❌ Деактивирован') + ': *' + escMd_(master.name) + '*',
      Object.assign({ parse_mode: 'Markdown' }, backKb_('admin:masters'))
    );
    return;
  }

  // ── Master services toggle ───────────────────────────────────────────
  if (data.indexOf('admin:mastersvc:toggle:') === 0) {
    var parts = data.split(':');
    var masterId = parseInt(parts[3], 10);
    var serviceId = parseInt(parts[4], 10);
    var current = Db.getMasterServices(masterId);
    if (current.some(function (s) { return s.id === serviceId; })) {
      Db.removeMasterService(masterId, serviceId);
    } else {
      Db.addMasterService(masterId, serviceId);
    }
    // Re-render the same screen
    ctx.callbackQuery.data = 'admin:mastersvc:' + masterId;
    adminActions_(ctx);
    return;
  }

  // ── Master services list ─────────────────────────────────────────────
  if (data.indexOf('admin:mastersvc:') === 0) {
    var masterId = parseInt(data.split(':')[2], 10);
    var master = Db.getMaster(masterId);
    var allSvcs = Db.getAllServices();
    var masterSvc = Db.getMasterServices(masterId);
    var assigned = {};
    masterSvc.forEach(function (s) { assigned[s.id] = true; });

    var rows = allSvcs.map(function (s) {
      return [btn_((assigned[s.id] ? '✅ ' : '☐ ') + s.name, 'admin:mastersvc:toggle:' + masterId + ':' + s.id)];
    });
    rows.push([btn_('⬅️ Назад', 'admin:master:' + masterId)]);
    edit_(ctx, '💅 *Услуги: ' + escMd_(master.name) + '*', Object.assign({ parse_mode: 'Markdown' }, ik_(rows)));
    return;
  }

  // ── Set working hours for a specific day ────────────────────────────
  if (data.indexOf('admin:hours:set:') === 0) {
    var parts = data.split(':');
    var masterId = parseInt(parts[3], 10);
    var day = parseInt(parts[4], 10);
    enterScene_(ctx, 'setHours', { masterId: masterId, day: day });
    return;
  }

  // ── Working hours overview for master ───────────────────────────────
  if (data.indexOf('admin:hours:') === 0) {
    var masterId = parseInt(data.split(':')[2], 10);
    var master = Db.getMaster(masterId);
    var hours = Db.getAllWorkingHours(masterId);
    var map = {};
    hours.forEach(function (h) { map[h.day_of_week] = h; });

    var rows = [];
    for (var d = 0; d < 7; d++) {
      var h = map[d];
      var label = h
        ? (DAYS_SHORT_[d] + '  ' + h.start_time.slice(0, 5) + '–' + h.end_time.slice(0, 5))
        : (DAYS_SHORT_[d] + '  — выходной');
      rows.push([btn_(label, 'admin:hours:set:' + masterId + ':' + d)]);
    }
    rows.push([btn_('⬅️ Назад', 'admin:master:' + masterId)]);

    edit_(ctx, '🕐 *График: ' + escMd_(master.name) + '*\nНажмите на день для изменения:', Object.assign({ parse_mode: 'Markdown' }, ik_(rows)));
    return;
  }

  // ── Master detail ────────────────────────────────────────────────────
  if (data.indexOf('admin:master:') === 0) {
    var masterId = parseInt(data.split(':')[2], 10);
    var master = Db.getMaster(masterId);
    var svcs = Db.getMasterServices(masterId);
    var hours = Db.getAllWorkingHours(masterId);

    var svcList = svcs.length ? svcs.map(function (s) { return escMd_(s.name); }).join(', ') : 'не назначены';
    var hoursList = hours.length
      ? hours.map(function (h) { return DAYS_SHORT_[h.day_of_week] + ' ' + h.start_time.slice(0, 5) + '–' + h.end_time.slice(0, 5); }).join('  ')
      : 'не задан';

    edit_(ctx,
      '👩 *' + escMd_(master.name) + '*  ' + (master.is_active ? '✅ активен' : '❌ неактивен') + '\n\n' +
      '💅 Услуги: ' + svcList + '\n' +
      '🕐 График: ' + hoursList,
      Object.assign({ parse_mode: 'Markdown' }, ik_([
        [btn_(master.is_active ? '❌ Деактивировать' : '✅ Активировать', 'admin:master:toggle:' + masterId)],
        [btn_('💅 Услуги мастера', 'admin:mastersvc:' + masterId)],
        [btn_('🕐 Рабочие часы', 'admin:hours:' + masterId)],
        [btn_('⬅️ Назад', 'admin:masters')],
      ]))
    );
    return;
  }

  // ── Services list ────────────────────────────────────────────────────
  if (data === 'admin:services') {
    var svcs = Db.getAllServices();
    var rows = svcs.map(function (s) {
      return [btn_((s.is_active ? '✅ ' : '❌ ') + s.name + '  —  ' + s.price + '₽', 'admin:service:' + s.id)];
    });
    rows.push([btn_('➕ Добавить услугу', 'admin:service:add')]);
    rows.push([btn_('⬅️ Назад', 'admin:menu')]);
    edit_(ctx, '💅 *Услуги:*', Object.assign({ parse_mode: 'Markdown' }, ik_(rows)));
    return;
  }

  // ── Add service ──────────────────────────────────────────────────────
  if (data === 'admin:service:add') { enterScene_(ctx, 'addService', {}); return; }

  // ── Toggle service active ───────────────────────────────────────────
  if (data.indexOf('admin:service:toggle:') === 0) {
    var id = parseInt(data.split(':')[3], 10);
    var svc = Db.toggleServiceActive(id);
    edit_(ctx,
      (svc.is_active ? '✅ Активирована' : '❌ Деактивирована') + ': *' + escMd_(svc.name) + '*',
      Object.assign({ parse_mode: 'Markdown' }, backKb_('admin:services'))
    );
    return;
  }

  // ── Service detail ───────────────────────────────────────────────────
  if (data.indexOf('admin:service:') === 0) {
    var id = parseInt(data.split(':')[2], 10);
    var svc = Db.getService(id);
    if (!svc) return;

    edit_(ctx,
      '💅 *' + escMd_(svc.name) + '*  ' + (svc.is_active ? '✅' : '❌') + '\n\n' +
      '⏱ ' + svc.duration_minutes + ' мин  ·  💰 ' + svc.price + '₽' +
      (svc.description ? ('\n📝 ' + escMd_(svc.description)) : ''),
      Object.assign({ parse_mode: 'Markdown' }, ik_([
        [btn_(svc.is_active ? '❌ Деактивировать' : '✅ Активировать', 'admin:service:toggle:' + id)],
        [btn_('⬅️ Назад', 'admin:services')],
      ]))
    );
    return;
  }
}
