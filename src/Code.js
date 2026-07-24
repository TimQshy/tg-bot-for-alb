// Webhook entry point — replaces bot.js. Telegram calls doPost(e) on every update.

function doPost(e) {
  try {
    var config = getConfig_();
    var token = e && e.parameter && e.parameter.token;
    if (!config.WEBHOOK_SECRET || token !== config.WEBHOOK_SECRET) {
      return ContentService.createTextOutput('forbidden');
    }

    var update = JSON.parse(e.postData.contents);
    var ctx = buildCtx_(update);
    if (ctx.from) dispatchUpdate_(ctx);
  } catch (err) {
    console.error('doPost error: ' + err + (err && err.stack ? ('\n' + err.stack) : ''));
  }
  return ContentService.createTextOutput('ok');
}

function doGet(e) {
  return ContentService.createTextOutput('Beauty Salon Bot is running.');
}

function dispatchUpdate_(ctx) {
  var session = getSession_(ctx.from.id);
  var isStartCommand = !!(ctx.message && ctx.message.text && ctx.message.text.split(' ')[0] === '/start');

  // Active wizard scene — let it escape on /start, like the old bot's
  // scene.command('start') handlers, otherwise route the update to the current step.
  if (session && session.scene) {
    var scene = getScene_(session.scene);
    if (isStartCommand && scene && scene.onStart) {
      scene.onStart(ctx);
      return;
    }
    runSceneStep_(ctx, session);
    return;
  }

  // Commands
  if (ctx.message && ctx.message.text) {
    var command = ctx.message.text.split(' ')[0];
    if (command === '/start') { startHandler_(ctx); return; }
    if (command === '/mybookings') { myBookingsHandler_(ctx); return; }
    if (command === '/admin') { adminCommand_(ctx); return; }
    return;
  }

  // Callback buttons
  if (ctx.callbackQuery) {
    var data = ctx.callbackQuery.data;
    if (data === 'book') { ctx.answerCbQuery(); enterScene_(ctx, 'booking', {}); return; }
    if (data === 'my_bookings') { myBookingsHandler_(ctx); return; }
    if (data === 'main_menu') { startHandler_(ctx); return; }
    if (data.indexOf('cancel_appt:') === 0) { cancelApptAction_(ctx); return; }
    if (data.indexOf('confirm_cancel:') === 0) { confirmCancelAction_(ctx); return; }
    if (data.indexOf('admin:') === 0) { adminActions_(ctx); return; }
    ctx.answerCbQuery();
  }
}
