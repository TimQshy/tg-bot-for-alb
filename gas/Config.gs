// ===== Config.js =====

function getConfig_() {
  var p = PropertiesService.getScriptProperties();
  var adminIdsRaw = p.getProperty('ADMIN_IDS') || '';
  return {
    BOT_TOKEN: p.getProperty('BOT_TOKEN'),
    ADMIN_IDS: adminIdsRaw
      .split(',')
      .map(function (s) { return parseInt(s.trim(), 10); })
      .filter(function (n) { return !isNaN(n); }),
    // Single source of truth for time zone: this always matches the "timeZone"
    // field in appsscript.json, which is also what governs how the `new
    // Date(y, m, d, h, mi)` constructor (used in combineDateTime_) interprets
    // its components. Previously this came from a separate Script Property
    // that could drift out of sync with appsscript.json and silently shift
    // reminder timing — don't reintroduce a second source.
    TIMEZONE: Session.getScriptTimeZone(),
    WEBHOOK_SECRET: p.getProperty('WEBHOOK_SECRET'),
  };
}

function isAdmin_(userId) {
  return getConfig_().ADMIN_IDS.indexOf(userId) !== -1;
}

// Escapes Telegram legacy-Markdown special characters in dynamic (user- or
// admin-entered) text before it's interpolated into a parse_mode: 'Markdown'
// message. Without this, a name/description containing `_`, `*`, `` ` `` or
// `[` makes Telegram reject the whole message with a parse error — which
// tgApi_ only logs, so the send fails silently (e.g. an admin never gets
// notified about a new booking because the client's name broke formatting).
function escMd_(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/([_*`\[])/g, '\\$1');
}
