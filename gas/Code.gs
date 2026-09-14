// ===== Code.js =====
// Webhook entry point — replaces bot.js. Telegram calls doPost(e) on every update.

// Apps Script web apps don't expose request headers to doPost(e), so the
// Telegram secret_token header can't be checked directly. Instead the secret
// is embedded as a query parameter in the URL registered with Telegram (see
// setupWebhook in Setup.gs) — Apps Script does parse query params out of the
// request URL for POSTs, into e.parameter. Any POST that doesn't carry the
// matching secret is silently ignored instead of being parsed as an update.
function isValidWebhookRequest_(e) {
  var expected = getConfig_().WEBHOOK_SECRET;
  if (!expected) return false;
  return e && e.parameter && e.parameter.secret === expected;
}

function doPost(e) {
  try {
    if (!isValidWebhookRequest_(e)) {
      console.error('Rejected webhook request: missing or invalid secret.');
      return HtmlService.createHtmlOutput('forbidden');
    }
    var update = JSON.parse(e.postData.contents);
    var ctx = buildCtx_(update);
    if (ctx.from) dispatchUpdate_(ctx);
  } catch (err) {
    console.error('doPost error: ' + err);
  }
  return HtmlService.createHtmlOutput('ok');
}

function doGet(e) {
  return HtmlService.createHtmlOutput('Beauty Salon Bot is running.');
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
