// ===== Telegram.js =====
// Thin wrapper over the Telegram Bot API (replaces Telegraf).

function tgApi_(method, payload) {
  var token = getConfig_().BOT_TOKEN;
  var url = 'https://api.telegram.org/bot' + token + '/' + method;
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  var body = JSON.parse(res.getContentText());
  if (!body.ok) {
    console.error('Telegram API error [' + method + ']: ' + res.getContentText());
  }
  return body.result;
}

function sendMessage_(chatId, text, extra) {
  return tgApi_('sendMessage', Object.assign({ chat_id: chatId, text: text }, extra || {}));
}

function editMessageText_(chatId, messageId, text, extra) {
  return tgApi_('editMessageText', Object.assign({ chat_id: chatId, message_id: messageId, text: text }, extra || {}));
}

function answerCallbackQuery_(id, text) {
  var payload = { callback_query_id: id };
  if (text) payload.text = text;
  return tgApi_('answerCallbackQuery', payload);
}

// Telegraf's Markup.button.callback(text, data) equivalent.
function btn_(text, data) {
  return { text: text, callback_data: data };
}

// Telegraf's Markup.inlineKeyboard(rows) equivalent — spread into reply opts.
function ik_(rows) {
  return { reply_markup: { inline_keyboard: rows } };
}

// Builds a Telegraf-ctx-like object from a raw Telegram Update so handlers/scenes
// ported from the old bot can keep calling ctx.reply/ctx.editMessageText/ctx.answerCbQuery.
function buildCtx_(update) {
  var message = update.message;
  var callbackQuery = update.callback_query;
  var from = (message && message.from) || (callbackQuery && callbackQuery.from);
  var chat = (message && message.chat) || (callbackQuery && callbackQuery.message && callbackQuery.message.chat);
  var chatId = chat ? chat.id : null;
  var messageId = callbackQuery ? callbackQuery.message.message_id : (message ? message.message_id : null);

  return {
    update: update,
    message: message,
    callbackQuery: callbackQuery,
    from: from,
    chatId: chatId,
    reply: function (text, opts) { return sendMessage_(chatId, text, opts); },
    editMessageText: function (text, opts) { return editMessageText_(chatId, messageId, text, opts); },
    answerCbQuery: function (text) { return callbackQuery ? answerCallbackQuery_(callbackQuery.id, text) : null; },
  };
}
