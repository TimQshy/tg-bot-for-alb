// One-time setup functions — run these manually from the Apps Script editor
// (select the function in the toolbar dropdown → Run) after `clasp push`.
// See README.md for the full deployment sequence.

function createSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  ensureSheet_(ss, 'Users', USERS_HEADERS_);
  ensureSheet_(ss, 'Masters', MASTERS_HEADERS_);
  ensureSheet_(ss, 'Services', SERVICES_HEADERS_);
  ensureSheet_(ss, 'MasterServices', MASTER_SERVICES_HEADERS_);
  ensureSheet_(ss, 'WorkingHours', WORKING_HOURS_HEADERS_);
  ensureSheet_(ss, 'Appointments', APPOINTMENTS_HEADERS_);

  var counters = ensureSheet_(ss, 'Counters', ['key', 'value']);
  ensureCounter_(counters, 'nextMasterId');
  ensureCounter_(counters, 'nextServiceId');
  ensureCounter_(counters, 'nextApptId');

  // Keep date/time columns as plain text so Sheets doesn't silently reinterpret
  // "2026-07-24" / "09:30" as a Date, which would break the string comparisons
  // Db.js and Utils.js rely on.
  forceText_(ss, 'Appointments', ['appointment_date', 'start_time', 'end_time', 'created_at']);
  forceText_(ss, 'WorkingHours', ['start_time', 'end_time']);
  forceText_(ss, 'Users', ['created_at']);
  forceText_(ss, 'Masters', ['created_at']);

  var sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1 && ss.getSheets().length > 1) ss.deleteSheet(sheet1);

  Logger.log('Sheets are ready.');
}

function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function ensureCounter_(countersSheet, key) {
  var data = countersSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) return;
  }
  countersSheet.appendRow([key, 1]);
}

function forceText_(ss, sheetName, columnNames) {
  var sheet = ss.getSheetByName(sheetName);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  columnNames.forEach(function (col) {
    var idx = headers.indexOf(col);
    if (idx === -1) return;
    sheet.getRange(1, idx + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
  });
}

// Run once with your real values, e.g. from the editor:
//   setConfig('123456:ABC-DEF...', '111111111,222222222', 'Asia/Bishkek')
function setConfig(botToken, adminIds, timezone) {
  var secret = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperties({
    BOT_TOKEN: botToken,
    ADMIN_IDS: adminIds || '',
    TIMEZONE: timezone || 'Asia/Bishkek',
    WEBHOOK_SECRET: secret,
  });
  Logger.log('Config saved. Webhook secret: ' + secret);
}

// Run once with the Web App deployment URL (Deploy → Manage deployments → Web app URL).
function setupWebhook(deploymentUrl) {
  var secret = getConfig_().WEBHOOK_SECRET;
  if (!secret) throw new Error('Run setConfig(...) first.');
  var sep = deploymentUrl.indexOf('?') === -1 ? '?' : '&';
  var url = deploymentUrl + sep + 'token=' + secret;
  var result = tgApi_('setWebhook', { url: url });
  Logger.log('Webhook set: ' + JSON.stringify(result));
}

// Run once to install the reminders trigger (replaces node-cron).
function setTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'checkReminders') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('checkReminders').timeBased().everyMinutes(5).create();
  Logger.log('Reminder trigger installed (every 5 min).');
}
