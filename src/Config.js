// Reads bot configuration from Script Properties (replaces .env / process.env.*).
// Set via Setup.setConfig(botToken, adminIds, timezone) — see Setup.js.

function getConfig_() {
  var p = PropertiesService.getScriptProperties();
  var adminIdsRaw = p.getProperty('ADMIN_IDS') || '';
  return {
    BOT_TOKEN: p.getProperty('BOT_TOKEN'),
    ADMIN_IDS: adminIdsRaw
      .split(',')
      .map(function (s) { return parseInt(s.trim(), 10); })
      .filter(function (n) { return !isNaN(n); }),
    TIMEZONE: p.getProperty('TIMEZONE') || 'Asia/Bishkek',
    WEBHOOK_SECRET: p.getProperty('WEBHOOK_SECRET'),
  };
}

function isAdmin_(userId) {
  return getConfig_().ADMIN_IDS.indexOf(userId) !== -1;
}
