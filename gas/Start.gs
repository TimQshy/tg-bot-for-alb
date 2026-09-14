// ===== Start.js =====
// /start command + "main_menu" callback — ported from handlers/start.js

function startHandler_(ctx) {
  var isCallback = !!ctx.callbackQuery;
  if (isCallback) ctx.answerCbQuery();

  if (ctx.from) {
    Db.upsertUser({
      id: ctx.from.id,
      username: ctx.from.username,
      first_name: ctx.from.first_name,
      last_name: ctx.from.last_name,
    });
  }

  var name = escMd_((ctx.from && ctx.from.first_name) || 'Гость');
  var text =
    '👋 Привет, *' + name + '*!\n\n' +
    'Добро пожаловать в наш салон красоты.\n' +
    'Записаться на процедуру — в пару кликов.';

  var keyboard = ik_([
    [btn_('✂️ Записаться', 'book')],
    [btn_('📋 Мои записи', 'my_bookings')],
  ]);

  if (isCallback) {
    ctx.editMessageText(text, Object.assign({ parse_mode: 'Markdown' }, keyboard));
  } else {
    ctx.reply(text, Object.assign({ parse_mode: 'Markdown' }, keyboard));
  }
}
