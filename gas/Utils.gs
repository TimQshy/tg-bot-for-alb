// ===== Utils.js =====
// Date/time helpers — ported 1:1 from the old Node bot's utils.js (pure JS, no
// framework dependency, only async→sync since Sheets access is synchronous).

var DAYS_SHORT_ = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
var DAYS_FULL_ = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
var MONTHS_GEN_ = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
var MONTHS_SHORT_ = ['янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function nowIso_() {
  return new Date().toISOString();
}

function todayStr_() {
  return Utilities.formatDate(new Date(), getConfig_().TIMEZONE, 'yyyy-MM-dd');
}

function addDays_(dateStr, n) {
  var d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

// Returns 0=Mon … 6=Sun (ISO weekday convention)
function getDayOfWeek_(dateStr) {
  var d = new Date(dateStr + 'T12:00:00Z');
  var jsDay = d.getUTCDay(); // 0=Sun
  return jsDay === 0 ? 6 : jsDay - 1;
}

// "18 июл, Пт"
function formatDateShort_(dateStr) {
  var d = new Date(dateStr + 'T12:00:00Z');
  return d.getUTCDate() + ' ' + MONTHS_SHORT_[d.getUTCMonth()] + ', ' + DAYS_SHORT_[getDayOfWeek_(dateStr)];
}

// "18 июля (пятница)"
function formatDateFull_(dateStr) {
  var d = new Date(dateStr + 'T12:00:00Z');
  return d.getUTCDate() + ' ' + MONTHS_GEN_[d.getUTCMonth()] + ' (' + DAYS_FULL_[getDayOfWeek_(dateStr)].toLowerCase() + ')';
}

// "09:30" -> 570
function toMinutes_(timeStr) {
  var parts = String(timeStr).slice(0, 5).split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

// 570 -> "09:30"
function toTimeString_(min) {
  var h = Math.floor(min / 60), m = min % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

// dateStr + "HH:MM" -> Date, in the script's configured time zone (appsscript.json
// timeZone — the same value getConfig_().TIMEZONE now reads via
// Session.getScriptTimeZone(), so there's only one place to change it).
function combineDateTime_(dateStr, timeStr) {
  var d = dateStr.split('-').map(Number);
  var t = String(timeStr).slice(0, 5).split(':').map(Number);
  return new Date(d[0], d[1] - 1, d[2], t[0], t[1], 0);
}

// Generate free time slots given working hours, service duration, and booked slots
function generateSlots_(startTime, endTime, durationMin, bookedSlots) {
  var start = toMinutes_(startTime);
  var end = toMinutes_(endTime);
  var slots = [];

  for (var s = start; s + durationMin <= end; s += 30) {
    var e = s + durationMin;
    var overlaps = bookedSlots.some(function (b) {
      var bs = toMinutes_(b.start_time);
      var be = toMinutes_(b.end_time);
      return !(e <= bs || s >= be);
    });
    if (!overlaps) slots.push({ start: toTimeString_(s), end: toTimeString_(e) });
  }
  return slots;
}

// Returns date strings (next `days` days) where the master has working hours
function getAvailableDates_(masterId, days) {
  days = days || 14;
  var dates = [];
  for (var i = 1; i <= days; i++) {
    var dateStr = addDays_(todayStr_(), i);
    var dow = getDayOfWeek_(dateStr);
    var hours = Db.getWorkingHours(masterId, dow);
    if (hours) dates.push(dateStr);
  }
  return dates;
}

// Returns free time slots for master on a given date
function getTimeSlotsForMaster_(masterId, dateStr, durationMin) {
  var dow = getDayOfWeek_(dateStr);
  var hours = Db.getWorkingHours(masterId, dow);
  if (!hours) return [];
  var booked = Db.getBookedSlots(masterId, dateStr);
  return generateSlots_(hours.start_time, hours.end_time, durationMin, booked);
}
