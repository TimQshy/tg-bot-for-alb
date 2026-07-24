// "Мои записи" / cancel-appointment flow — ported from handlers/myBookings.js

function sliceTime_(t) {
  return String(t).slice(0, 5);
}

function myBookingsHandler_(ctx) {
  var isCallback = !!ctx.callbackQuery;
  if (isCallback) ctx.answerCbQuery();

  var appts = Db.getUserAppointments(ctx.from.id);

  if (!appts.length) {
    var emptyText = '📋 У вас нет активных записей.';
    var emptyKb = ik_([
      [btn_('✂️ Записаться', 'book')],
      [btn_('🏠 Главное меню', 'main_menu')],
    ]);
    if (isCallback) ctx.editMessageText(emptyText, emptyKb);
    else ctx.reply(emptyText, emptyKb);
    return;
  }

  var text = '📋 *Ваши записи:*\n\n';
  var buttons = [];

  appts.forEach(function (a) {
    text +=
      '💅 *' + a.service_name + '*\n' +
      '👩 ' + a.master_name + '\n' +
      '📅 ' + formatDateFull_(a.appointment_date) + '\n' +
      '🕐 ' + sliceTime_(a.start_time) + ' – ' + sliceTime_(a.end_time) + '  ·  💰 ' + a.price + '₽\n\n';
    buttons.push([btn_('❌ Отменить запись #' + a.id, 'cancel_appt:' + a.id)]);
  });

  buttons.push([btn_('✂️ Новая запись', 'book')]);
  buttons.push([btn_('🏠 Главное меню', 'main_menu')]);

  var kb = ik_(buttons);
  if (isCallback) ctx.editMessageText(text, Object.assign({ parse_mode: 'Markdown' }, kb));
  else ctx.reply(text, Object.assign({ parse_mode: 'Markdown' }, kb));
}

function cancelApptAction_(ctx) {
  ctx.answerCbQuery();
  var apptId = parseInt(ctx.callbackQuery.data.split(':')[1], 10);
  var appt = Db.getAppointmentById(apptId);

  if (!appt || appt.status !== 'confirmed' || appt.user_id !== ctx.from.id) {
    ctx.editMessageText('Запись не найдена или уже отменена.', ik_([[btn_('⬅️ Назад', 'my_bookings')]]));
    return;
  }

  ctx.editMessageText(
    '❓ *Отменить запись?*\n\n' +
    '💅 ' + appt.service_name + '\n' +
    '👩 ' + appt.master_name + '\n' +
    '📅 ' + formatDateFull_(appt.appointment_date) + '\n' +
    '🕐 ' + sliceTime_(appt.start_time) + ' – ' + sliceTime_(appt.end_time),
    Object.assign({ parse_mode: 'Markdown' }, ik_([
      [btn_('✅ Да, отменить', 'confirm_cancel:' + apptId)],
      [btn_('⬅️ Нет, назад', 'my_bookings')],
    ]))
  );
}

function confirmCancelAction_(ctx) {
  ctx.answerCbQuery();
  var apptId = parseInt(ctx.callbackQuery.data.split(':')[1], 10);
  var appt = Db.getAppointmentById(apptId);

  if (!appt || appt.status !== 'confirmed') {
    ctx.editMessageText('Запись уже отменена.', ik_([[btn_('📋 Мои записи', 'my_bookings')]]));
    return;
  }

  Db.cancelAppointment(apptId);
  ctx.editMessageText('✅ Запись отменена.', ik_([[btn_('📋 Мои записи', 'my_bookings')]]));
}
