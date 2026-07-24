// Booking wizard — ported from scenes/booking.js (Telegraf WizardScene → array of
// step functions keyed by session.step, state persisted via Session.js).

var BOOKING_SCENE = {
  steps: [
    // Step 0: show services
    function (ctx, session) {
      var services = Db.getActiveServices();
      if (!services.length) {
        ctx.reply('😔 Нет доступных услуг. Свяжитесь с салоном.');
        leaveScene_(ctx.from.id);
        return;
      }

      var buttons = services.map(function (s) {
        return [btn_(s.name + '  —  ' + s.price + '₽  ·  ' + s.duration_minutes + ' мин', 'svc:' + s.id)];
      });
      buttons.push([btn_('❌ Отмена', 'cancel')]);

      ctx.reply('💅 *Запись в салон*\n\nВыберите услугу:', Object.assign({ parse_mode: 'Markdown' }, ik_(buttons)));
      advanceScene_(ctx, session);
    },

    // Step 1: service chosen -> show masters
    function (ctx, session) {
      if (!ctx.callbackQuery) return;
      ctx.answerCbQuery();
      var data = ctx.callbackQuery.data;

      if (data === 'cancel') { ctx.editMessageText('Запись отменена.'); leaveScene_(ctx.from.id); return; }
      if (data.indexOf('svc:') !== 0) return;

      var serviceId = parseInt(data.split(':')[1], 10);
      var service = Db.getService(serviceId);
      if (!service) { leaveScene_(ctx.from.id); return; }

      session.state.serviceId = serviceId;
      session.state.serviceName = service.name;
      session.state.serviceDuration = service.duration_minutes;
      session.state.servicePrice = service.price;

      var masters = Db.getMastersForService(serviceId);
      if (!masters.length) {
        ctx.editMessageText('😔 Нет доступных мастеров для этой услуги.');
        leaveScene_(ctx.from.id);
        return;
      }

      var buttons = masters.map(function (m) {
        return [btn_(m.description ? (m.name + '  ·  ' + m.description) : m.name, 'mst:' + m.id)];
      });
      buttons.push([btn_('❌ Отмена', 'cancel')]);

      ctx.editMessageText(
        '💅 *' + service.name + '*\n💰 ' + service.price + '₽  ·  ⏱ ' + service.duration_minutes + ' мин\n\nВыберите мастера:',
        Object.assign({ parse_mode: 'Markdown' }, ik_(buttons))
      );
      advanceScene_(ctx, session);
    },

    // Step 2: master chosen -> show dates
    function (ctx, session) {
      if (!ctx.callbackQuery) return;
      ctx.answerCbQuery();
      var data = ctx.callbackQuery.data;

      if (data === 'cancel') { ctx.editMessageText('Запись отменена.'); leaveScene_(ctx.from.id); return; }
      if (data.indexOf('mst:') !== 0) return;

      var masterId = parseInt(data.split(':')[1], 10);
      var master = Db.getMaster(masterId);
      if (!master) { leaveScene_(ctx.from.id); return; }

      session.state.masterId = masterId;
      session.state.masterName = master.name;

      var dates = getAvailableDates_(masterId, 14);
      if (!dates.length) {
        ctx.editMessageText(
          '😔 У мастера *' + master.name + '* нет свободных дат на ближайшие 2 недели.',
          { parse_mode: 'Markdown' }
        );
        leaveScene_(ctx.from.id);
        return;
      }

      var rows = [];
      for (var i = 0; i < dates.length; i += 3) {
        rows.push(dates.slice(i, i + 3).map(function (d) { return btn_(formatDateShort_(d), 'dt:' + d); }));
      }
      rows.push([btn_('❌ Отмена', 'cancel')]);

      ctx.editMessageText(
        '💅 *' + session.state.serviceName + '*\n👩 ' + master.name + '\n\nВыберите дату:',
        Object.assign({ parse_mode: 'Markdown' }, ik_(rows))
      );
      advanceScene_(ctx, session);
    },

    // Step 3: date chosen -> show time slots
    function (ctx, session) {
      if (!ctx.callbackQuery) return;
      ctx.answerCbQuery();
      var data = ctx.callbackQuery.data;

      if (data === 'cancel') { ctx.editMessageText('Запись отменена.'); leaveScene_(ctx.from.id); return; }
      if (data.indexOf('dt:') !== 0) return;

      var dateStr = data.split(':')[1];
      session.state.date = dateStr;

      var slots = getTimeSlotsForMaster_(session.state.masterId, dateStr, session.state.serviceDuration);
      if (!slots.length) {
        ctx.editMessageText('😔 На эту дату нет свободных слотов. Попробуйте другую дату.');
        leaveScene_(ctx.from.id);
        return;
      }

      var rows = [];
      for (var i = 0; i < slots.length; i += 4) {
        rows.push(slots.slice(i, i + 4).map(function (s) { return btn_(s.start, 'slot:' + s.start + ':' + s.end); }));
      }
      rows.push([btn_('❌ Отмена', 'cancel')]);

      ctx.editMessageText(
        '💅 *' + session.state.serviceName + '*\n👩 ' + session.state.masterName + '\n📅 ' + formatDateFull_(dateStr) + '\n\nВыберите время:',
        Object.assign({ parse_mode: 'Markdown' }, ik_(rows))
      );
      advanceScene_(ctx, session);
    },

    // Step 4: time chosen -> confirmation screen
    function (ctx, session) {
      if (!ctx.callbackQuery) return;
      ctx.answerCbQuery();
      var data = ctx.callbackQuery.data;

      if (data === 'cancel') { ctx.editMessageText('Запись отменена.'); leaveScene_(ctx.from.id); return; }
      if (data.indexOf('slot:') !== 0) return;

      var parts = data.split(':');
      session.state.startTime = parts[1];
      session.state.endTime = parts[2];

      var s = session.state;
      ctx.editMessageText(
        '✅ *Подтвердите запись:*\n\n' +
        '💅 Услуга: *' + s.serviceName + '*\n' +
        '👩 Мастер: *' + s.masterName + '*\n' +
        '📅 Дата: *' + formatDateFull_(s.date) + '*\n' +
        '🕐 Время: *' + s.startTime + ' – ' + s.endTime + '*\n' +
        '💰 Стоимость: *' + s.servicePrice + '₽*',
        Object.assign({ parse_mode: 'Markdown' }, ik_([
          [btn_('✅ Подтвердить', 'confirm')],
          [btn_('❌ Отмена', 'cancel')],
        ]))
      );
      advanceScene_(ctx, session);
    },

    // Step 5: confirmed -> create appointment
    function (ctx, session) {
      if (!ctx.callbackQuery) return;
      ctx.answerCbQuery();
      var data = ctx.callbackQuery.data;

      if (data === 'cancel') { ctx.editMessageText('Запись отменена.'); leaveScene_(ctx.from.id); return; }
      if (data !== 'confirm') return;

      var s = session.state;

      Db.upsertUser({
        id: ctx.from.id,
        username: ctx.from.username,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
      });

      // Race-condition guard: two clients booking the same slot concurrently.
      var lock = LockService.getScriptLock();
      lock.waitLock(10000);
      var appt;
      try {
        if (!Db.isSlotAvailable(s.masterId, s.date, s.startTime, s.endTime)) {
          ctx.editMessageText('😔 Этот слот только что заняли. Начните запись заново — /start');
          leaveScene_(ctx.from.id);
          return;
        }
        appt = Db.createAppointment({
          userId: ctx.from.id, masterId: s.masterId, serviceId: s.serviceId,
          date: s.date, startTime: s.startTime, endTime: s.endTime,
        });
      } finally {
        lock.releaseLock();
      }

      ctx.editMessageText(
        '🎉 *Запись подтверждена!*\n\n' +
        '💅 ' + s.serviceName + '\n' +
        '👩 ' + s.masterName + '\n' +
        '📅 ' + formatDateFull_(s.date) + '\n' +
        '🕐 ' + s.startTime + ' – ' + s.endTime + '\n' +
        '💰 ' + s.servicePrice + '₽\n\n' +
        '📋 Номер записи: *#' + appt.id + '*\n\n' +
        'Мы напомним за 24 ч и за 1 ч до визита. До встречи! 👋',
        Object.assign({ parse_mode: 'Markdown' }, ik_([
          [btn_('📋 Мои записи', 'my_bookings')],
          [btn_('🏠 Главное меню', 'main_menu')],
        ]))
      );

      // Notify admins
      var userName = ctx.from.first_name + (ctx.from.last_name ? (' ' + ctx.from.last_name) : '');
      var tag = ctx.from.username ? (' (@' + ctx.from.username + ')') : '';
      var adminText =
        '📩 *Новая запись #' + appt.id + '*\n\n' +
        '👤 ' + userName + tag + '\n' +
        '💅 ' + s.serviceName + '\n' +
        '👩 ' + s.masterName + '\n' +
        '📅 ' + formatDateFull_(s.date) + '\n' +
        '🕐 ' + s.startTime + ' – ' + s.endTime;

      getConfig_().ADMIN_IDS.forEach(function (adminId) {
        try {
          sendMessage_(adminId, adminText, Object.assign({ parse_mode: 'Markdown' }, ik_([
            [btn_('❌ Отменить #' + appt.id, 'admin:cancel:' + appt.id)],
          ])));
        } catch (e) {
          console.error('Failed to notify admin ' + adminId + ': ' + e);
        }
      });

      leaveScene_(ctx.from.id);
    },
  ],

  // Allow /start to escape the scene, matching bookingScene.command('start') in the old bot.
  onStart: function (ctx) {
    leaveScene_(ctx.from.id);
    ctx.reply('Используйте кнопки ниже:', ik_([
      [btn_('✂️ Записаться', 'book')],
      [btn_('📋 Мои записи', 'my_bookings')],
    ]));
  },
};
