// ===== Db.js =====
// Google Sheets data-access layer — replaces database.js (Postgres).
// Whole sheets are loaded into memory and filtered with JS; fine at the scale of
// a single-salon booking bot (a few masters, tens of appointments/day).

var USERS_HEADERS_ = ['id', 'username', 'first_name', 'last_name', 'created_at'];
var MASTERS_HEADERS_ = ['id', 'name', 'description', 'is_active', 'created_at'];
var SERVICES_HEADERS_ = ['id', 'name', 'description', 'duration_minutes', 'price', 'is_active'];
var MASTER_SERVICES_HEADERS_ = ['master_id', 'service_id'];
var WORKING_HOURS_HEADERS_ = ['master_id', 'day_of_week', 'start_time', 'end_time'];
var APPOINTMENTS_HEADERS_ = ['id', 'user_id', 'master_id', 'service_id', 'appointment_date',
  'start_time', 'end_time', 'status', 'reminder_24h_sent', 'reminder_1h_sent', 'notes', 'created_at'];

// ── Generic sheet helpers ────────────────────────────────────────────────────

function getSheet_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name + ' (run Setup.createSheets() first)');
  return sheet;
}

function sheetToObjects_(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  return values.slice(1)
    .map(function (row, idx) {
      var obj = { _row: idx + 2 };
      headers.forEach(function (h, i) { obj[h] = row[i]; });
      return obj;
    })
    .filter(function (obj) { return obj[headers[0]] !== '' && obj[headers[0]] !== null; });
}

function appendRow_(sheet, headerOrder, obj) {
  var row = headerOrder.map(function (h) { return obj[h] !== undefined && obj[h] !== null ? obj[h] : ''; });
  sheet.appendRow(row);
}

function updateRowByField_(sheet, headerOrder, matchField, matchValue, updates) {
  var data = sheet.getDataRange().getValues();
  var colIdx = headerOrder.indexOf(matchField);
  for (var i = 1; i < data.length; i++) {
    if (data[i][colIdx] === matchValue) {
      Object.keys(updates).forEach(function (k) {
        var ci = headerOrder.indexOf(k);
        if (ci !== -1) sheet.getRange(i + 1, ci + 1).setValue(updates[k]);
      });
      return true;
    }
  }
  return false;
}

function deleteRowsWhere_(sheet, headerOrder, predicate) {
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    var obj = {};
    headerOrder.forEach(function (h, idx) { obj[h] = data[i][idx]; });
    if (predicate(obj)) sheet.deleteRow(i + 1);
  }
}

// Atomic autoincrement counters (Sheets has no SERIAL) — guarded by LockService
// so two concurrent requests never hand out the same id.
function nextId_(counterKey) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet_('Counters');
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === counterKey) {
        var val = data[i][1];
        sheet.getRange(i + 1, 2).setValue(val + 1);
        return val;
      }
    }
    throw new Error('Counter not found: ' + counterKey);
  } finally {
    lock.releaseLock();
  }
}

// ── Business data access (same contract as the old database.js) ────────────

var Db = {
  upsertUser: function (u) {
    var sheet = getSheet_('Users');
    var updated = updateRowByField_(sheet, USERS_HEADERS_, 'id', u.id, {
      username: u.username || '',
      first_name: u.first_name,
      last_name: u.last_name || '',
    });
    if (!updated) {
      appendRow_(sheet, USERS_HEADERS_, {
        id: u.id, username: u.username || '', first_name: u.first_name,
        last_name: u.last_name || '', created_at: nowIso_(),
      });
    }
  },

  // ── Services ───────────────────────────────────────────────────────────
  getActiveServices: function () {
    return sheetToObjects_(getSheet_('Services'))
      .filter(function (s) { return s.is_active === true; })
      .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  },

  getAllServices: function () {
    return sheetToObjects_(getSheet_('Services'))
      .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  },

  getService: function (id) {
    return sheetToObjects_(getSheet_('Services')).find(function (s) { return s.id === id; });
  },

  createService: function (data) {
    var id = nextId_('nextServiceId');
    var svc = {
      id: id, name: data.name, description: data.description || '',
      duration_minutes: data.durationMinutes, price: data.price, is_active: true,
    };
    appendRow_(getSheet_('Services'), SERVICES_HEADERS_, svc);
    return svc;
  },

  toggleServiceActive: function (id) {
    var svc = Db.getService(id);
    if (!svc) return null;
    svc.is_active = !svc.is_active;
    updateRowByField_(getSheet_('Services'), SERVICES_HEADERS_, 'id', id, { is_active: svc.is_active });
    return svc;
  },

  // ── Masters ────────────────────────────────────────────────────────────
  getAllMasters: function () {
    return sheetToObjects_(getSheet_('Masters')).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  },

  getMaster: function (id) {
    return sheetToObjects_(getSheet_('Masters')).find(function (m) { return m.id === id; });
  },

  getMastersForService: function (serviceId) {
    var masterIds = sheetToObjects_(getSheet_('MasterServices'))
      .filter(function (l) { return l.service_id === serviceId; })
      .map(function (l) { return l.master_id; });
    return Db.getAllMasters().filter(function (m) { return m.is_active === true && masterIds.indexOf(m.id) !== -1; });
  },

  createMaster: function (data) {
    var id = nextId_('nextMasterId');
    var master = { id: id, name: data.name, description: data.description || '', is_active: true, created_at: nowIso_() };
    appendRow_(getSheet_('Masters'), MASTERS_HEADERS_, master);
    return master;
  },

  toggleMasterActive: function (id) {
    var master = Db.getMaster(id);
    if (!master) return null;
    master.is_active = !master.is_active;
    updateRowByField_(getSheet_('Masters'), MASTERS_HEADERS_, 'id', id, { is_active: master.is_active });
    return master;
  },

  // ── Master <-> Service links ──────────────────────────────────────────
  getMasterServices: function (masterId) {
    var serviceIds = sheetToObjects_(getSheet_('MasterServices'))
      .filter(function (l) { return l.master_id === masterId; })
      .map(function (l) { return l.service_id; });
    return Db.getAllServices().filter(function (s) { return serviceIds.indexOf(s.id) !== -1; });
  },

  addMasterService: function (masterId, serviceId) {
    var sheet = getSheet_('MasterServices');
    var exists = sheetToObjects_(sheet).some(function (l) { return l.master_id === masterId && l.service_id === serviceId; });
    if (!exists) appendRow_(sheet, MASTER_SERVICES_HEADERS_, { master_id: masterId, service_id: serviceId });
  },

  removeMasterService: function (masterId, serviceId) {
    deleteRowsWhere_(getSheet_('MasterServices'), MASTER_SERVICES_HEADERS_,
      function (l) { return l.master_id === masterId && l.service_id === serviceId; });
  },

  // ── Working hours ─────────────────────────────────────────────────────
  getWorkingHours: function (masterId, dayOfWeek) {
    return sheetToObjects_(getSheet_('WorkingHours'))
      .find(function (h) { return h.master_id === masterId && h.day_of_week === dayOfWeek; });
  },

  getAllWorkingHours: function (masterId) {
    return sheetToObjects_(getSheet_('WorkingHours'))
      .filter(function (h) { return h.master_id === masterId; })
      .sort(function (a, b) { return a.day_of_week - b.day_of_week; });
  },

  setWorkingHour: function (masterId, dayOfWeek, startTime, endTime) {
    var sheet = getSheet_('WorkingHours');
    var existing = sheetToObjects_(sheet).find(function (h) { return h.master_id === masterId && h.day_of_week === dayOfWeek; });
    if (existing) {
      sheet.getRange(existing._row, WORKING_HOURS_HEADERS_.indexOf('start_time') + 1).setValue(startTime);
      sheet.getRange(existing._row, WORKING_HOURS_HEADERS_.indexOf('end_time') + 1).setValue(endTime);
    } else {
      appendRow_(sheet, WORKING_HOURS_HEADERS_, { master_id: masterId, day_of_week: dayOfWeek, start_time: startTime, end_time: endTime });
    }
  },

  deleteWorkingHour: function (masterId, dayOfWeek) {
    deleteRowsWhere_(getSheet_('WorkingHours'), WORKING_HOURS_HEADERS_,
      function (h) { return h.master_id === masterId && h.day_of_week === dayOfWeek; });
  },

  // ── Appointments ──────────────────────────────────────────────────────
  getBookedSlots: function (masterId, date) {
    return sheetToObjects_(getSheet_('Appointments'))
      .filter(function (a) { return a.master_id === masterId && a.appointment_date === date && a.status === 'confirmed'; })
      .map(function (a) { return { start_time: a.start_time, end_time: a.end_time }; });
  },

  isSlotAvailable: function (masterId, date, startTime, endTime) {
    var booked = Db.getBookedSlots(masterId, date);
    return !booked.some(function (b) { return !(endTime <= b.start_time || startTime >= b.end_time); });
  },

  createAppointment: function (data) {
    var id = nextId_('nextApptId');
    var appt = {
      id: id, user_id: data.userId, master_id: data.masterId, service_id: data.serviceId,
      appointment_date: data.date, start_time: data.startTime, end_time: data.endTime,
      status: 'confirmed', reminder_24h_sent: false, reminder_1h_sent: false, notes: '', created_at: nowIso_(),
    };
    appendRow_(getSheet_('Appointments'), APPOINTMENTS_HEADERS_, appt);
    return appt;
  },

  getUserAppointments: function (userId) {
    var today = todayStr_();
    return Db.joinAppointments_(function (a) { return a.user_id === userId && a.status === 'confirmed' && a.appointment_date >= today; })
      .sort(function (a, b) { return (a.appointment_date + a.start_time).localeCompare(b.appointment_date + b.start_time); });
  },

  getAppointmentById: function (id) {
    return Db.joinAppointments_(function (a) { return a.id === id; })[0];
  },

  cancelAppointment: function (id) {
    var sheet = getSheet_('Appointments');
    var appt = sheetToObjects_(sheet).find(function (a) { return a.id === id; });
    if (!appt) return null;
    sheet.getRange(appt._row, APPOINTMENTS_HEADERS_.indexOf('status') + 1).setValue('cancelled');
    appt.status = 'cancelled';
    return appt;
  },

  getAppointmentsByDate: function (date) {
    return Db.joinAppointments_(function (a) { return a.appointment_date === date && a.status === 'confirmed'; })
      .sort(function (a, b) { return String(a.start_time).localeCompare(String(b.start_time)); });
  },

  getUpcomingAppointments: function (limit) {
    var today = todayStr_();
    return Db.joinAppointments_(function (a) { return a.status === 'confirmed' && a.appointment_date >= today; })
      .sort(function (a, b) { return (a.appointment_date + a.start_time).localeCompare(b.appointment_date + b.start_time); })
      .slice(0, limit || 20);
  },

  // ── Reminders ─────────────────────────────────────────────────────────
  getPendingReminders24h: function () {
    return Db.pendingReminders_('reminder_24h_sent', 23.5 * 60, 24.5 * 60);
  },

  getPendingReminders1h: function () {
    return Db.pendingReminders_('reminder_1h_sent', 0.5 * 60, 1.5 * 60);
  },

  markReminderSent: function (id, type) {
    var sheet = getSheet_('Appointments');
    var col = type === '24h' ? 'reminder_24h_sent' : 'reminder_1h_sent';
    var appt = sheetToObjects_(sheet).find(function (a) { return a.id === id; });
    if (appt) sheet.getRange(appt._row, APPOINTMENTS_HEADERS_.indexOf(col) + 1).setValue(true);
  },

  // ── Internal ──────────────────────────────────────────────────────────
  joinAppointments_: function (predicate) {
    var appts = sheetToObjects_(getSheet_('Appointments')).filter(predicate);
    if (!appts.length) return [];
    var masters = sheetToObjects_(getSheet_('Masters'));
    var services = sheetToObjects_(getSheet_('Services'));
    var users = sheetToObjects_(getSheet_('Users'));
    return appts.map(function (a) {
      var master = masters.find(function (m) { return m.id === a.master_id; }) || {};
      var service = services.find(function (s) { return s.id === a.service_id; }) || {};
      var user = users.find(function (u) { return u.id === a.user_id; }) || {};
      return Object.assign({}, a, {
        master_name: master.name, service_name: service.name, price: service.price,
        tg_user_id: user.id,
        user_first_name: user.first_name, user_last_name: user.last_name, user_username: user.username,
      });
    });
  },

  pendingReminders_: function (sentCol, minMinutesAhead, maxMinutesAhead) {
    var now = new Date();
    return Db.joinAppointments_(function (a) {
      if (a.status !== 'confirmed' || a[sentCol] === true) return false;
      var apptDateTime = combineDateTime_(a.appointment_date, a.start_time);
      var diffMin = (apptDateTime.getTime() - now.getTime()) / 60000;
      return diffMin >= minMinutesAhead && diffMin <= maxMinutesAhead;
    });
  },
};
