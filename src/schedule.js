// The one place free slots are computed. Every surface that offers a time to
// a client — the WhatsApp flow, the waitlist, the admin panel — goes through
// getFreeSlots(), so a break added in the panel closes the same slot
// everywhere at once.
//
// Two levels of schedule: schedule_template holds the standing week,
// schedule_override replaces it outright for a single date. A date with an
// override ignores the template completely; removing the override is what
// puts the date back under the template (see the schema comment in
// database.js).
import { db } from './database.js';
import { addDays, getDayOfWeek, todayStr, nowMinutes, toMinutes, toTimeString } from './utils.js';

const DAY_END = 24 * 60;

const BUFFER_MIN = Math.max(0, parseInt(process.env.SLOT_BUFFER_MINUTES || '0', 10) || 0);
const MIN_LEAD_MIN = Math.max(0, parseInt(process.env.MIN_LEAD_MINUTES || '0', 10) || 0);

export const DEFAULT_STEP_MIN = 30;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function parseHHMM(value, what) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value.slice(0, 5))) {
    fail('bad_time', `${what}: ожидается время в формате ЧЧ:ММ`);
  }
  const min = toMinutes(value);
  if (!Number.isInteger(min) || min < 0 || min > DAY_END) fail('bad_time', `${what}: время вне суток`);
  return min;
}

// Accepts the jsonb shape and returns it normalised (sorted, seconds
// trimmed, breaks sorted), or throws { code, message } for the API to turn
// into a 400. Rules: to > from, intervals of one day never overlap, a break
// lies inside its own interval.
export function validateIntervals(intervals) {
  if (!Array.isArray(intervals) || !intervals.length) fail('no_intervals', 'Добавьте хотя бы один рабочий интервал');

  const parsed = intervals.map((iv, i) => {
    const from = parseHHMM(iv?.from, `интервал ${i + 1}`);
    const to = parseHHMM(iv?.to, `интервал ${i + 1}`);
    if (to <= from) fail('bad_interval', `Интервал ${i + 1}: конец должен быть позже начала`);

    const breaks = (Array.isArray(iv?.breaks) ? iv.breaks : []).map((br, j) => {
      const bFrom = parseHHMM(br?.from, `перерыв ${j + 1}`);
      const bTo = parseHHMM(br?.to, `перерыв ${j + 1}`);
      if (bTo <= bFrom) fail('bad_break', `Перерыв ${j + 1}: конец должен быть позже начала`);
      if (bFrom < from || bTo > to) {
        fail('break_outside', `Перерыв ${toTimeString(bFrom)}–${toTimeString(bTo)} не попадает в рабочее время`);
      }
      const note = typeof br?.note === 'string' ? br.note.trim().slice(0, 120) : '';
      return { from: bFrom, to: bTo, note };
    }).sort((a, b) => a.from - b.from);

    for (let j = 1; j < breaks.length; j++) {
      if (breaks[j].from < breaks[j - 1].to) fail('breaks_overlap', 'Перерывы пересекаются');
    }
    return { from, to, breaks };
  }).sort((a, b) => a.from - b.from);

  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].from < parsed[i - 1].to) fail('intervals_overlap', 'Рабочие интервалы пересекаются');
  }

  return parsed.map(iv => ({
    from: toTimeString(iv.from),
    to: toTimeString(iv.to),
    breaks: iv.breaks.map(b => ({ from: toTimeString(b.from), to: toTimeString(b.to), note: b.note })),
  }));
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

// Pure: no database, no clock. The panel's editor previews unsaved intervals
// through this same function, which is why it takes minStartMin rather than
// working out "now" itself.
export function computeSlots({
  intervals = [],
  durationMin,
  stepMin = DEFAULT_STEP_MIN,
  booked = [],
  bufferMin = 0,
  minStartMin = 0,
}) {
  if (!durationMin || durationMin <= 0) return [];
  const step = stepMin > 0 ? stepMin : DEFAULT_STEP_MIN;

  const busy = booked.map(b => ({
    start: toMinutes(b.start_time ?? b.start),
    end: toMinutes(b.end_time ?? b.end),
  }));

  const slots = [];
  for (const iv of intervals) {
    const ivStart = toMinutes(iv.from);
    const ivEnd = toMinutes(iv.to);
    const breaks = (iv.breaks || []).map(b => ({ start: toMinutes(b.from), end: toMinutes(b.to), note: b.note || '' }));

    for (let s = ivStart; s + durationMin <= ivEnd; s += step) {
      const e = s + durationMin;
      if (s < minStartMin) continue; // already past, or inside the lead time

      const hitBreak = breaks.find(b => overlaps(s, e, b.start, b.end));
      if (hitBreak) {
        slots.push({ start: toTimeString(s), end: toTimeString(e), status: 'break', note: hitBreak.note });
        continue;
      }
      // The buffer is dead time on both sides of an appointment, so widen
      // the appointment rather than the slot.
      const taken = busy.some(b => overlaps(s, e, b.start - bufferMin, b.end + bufferMin));
      slots.push({ start: toTimeString(s), end: toTimeString(e), status: taken ? 'busy' : 'free' });
    }
  }
  return slots;
}

// What actually governs a date: the override if there is one, otherwise the
// weekday template, otherwise nothing.
export async function getDaySchedule(masterId, dateStr) {
  const override = await db.getOverride(masterId, dateStr);
  if (override) {
    return {
      source: 'override',
      kind: override.kind,
      isWorking: override.kind === 'custom',
      intervals: override.kind === 'custom' ? (override.intervals || []) : [],
    };
  }

  const template = await db.getTemplateDay(masterId, getDayOfWeek(dateStr));
  if (!template) return { source: 'none', kind: null, isWorking: false, intervals: [] };

  return {
    source: 'template',
    kind: null,
    isWorking: !!template.is_working,
    intervals: template.is_working ? (template.intervals || []) : [],
  };
}

// Free slots for one master on one date. Pass includeBusy to get the taken
// and break-covered slots too, which is what the panel's preview renders.
export async function getFreeSlots(masterId, dateStr, serviceDurationMin, opts = {}) {
  const {
    stepMin = DEFAULT_STEP_MIN,
    bufferMin = BUFFER_MIN,
    minLeadMin = MIN_LEAD_MIN,
    excludeApptId = null,
    includeBusy = false,
  } = opts;

  const day = await getDaySchedule(masterId, dateStr);
  if (!day.isWorking || !day.intervals.length) return [];

  const booked = await db.getBookedSlots(masterId, dateStr, excludeApptId);
  const slots = computeSlots({
    intervals: day.intervals,
    durationMin: serviceDurationMin,
    stepMin,
    booked,
    bufferMin,
    minStartMin: dateStr === todayStr() ? nowMinutes() + minLeadMin : 0,
  });

  return includeBusy ? slots : slots.filter(s => s.status === 'free');
}

// Same computation as getFreeSlots, but over intervals the salon has typed
// and not yet saved — the editor's preview. Busy and break-covered slots are
// included so the preview can mark them.
export async function previewSlots(masterId, dateStr, intervals, { durationMin, stepMin } = {}) {
  const booked = await db.getBookedSlots(masterId, dateStr);
  return computeSlots({
    intervals,
    durationMin: durationMin || 60,
    stepMin: stepMin || DEFAULT_STEP_MIN,
    booked,
    bufferMin: BUFFER_MIN,
    minStartMin: dateStr === todayStr() ? nowMinutes() + MIN_LEAD_MIN : 0,
  });
}

// Appointments a set of intervals would cut across — booked into a new break,
// or left outside the working time entirely. Saving is never blocked on
// these; the panel shows them and offers to reschedule.
export async function findConflicts(masterId, dateStr, intervals) {
  const appts = await db.listAppointments({
    dateFrom: dateStr, dateTo: dateStr, masterId, status: 'confirmed',
  });

  const windows = intervals.map(iv => ({
    start: toMinutes(iv.from),
    end: toMinutes(iv.to),
    breaks: (iv.breaks || []).map(b => ({ start: toMinutes(b.from), end: toMinutes(b.to), note: b.note || '' })),
  }));

  const conflicts = [];
  for (const a of appts) {
    const start = toMinutes(a.start_time);
    const end = toMinutes(a.end_time);

    const host = windows.find(w => start >= w.start && end <= w.end);
    if (!host) {
      conflicts.push({ id: a.id, user_name: a.user_name, service_name: a.service_name,
        start: toTimeString(start), end: toTimeString(end), reason: 'outside' });
      continue;
    }
    const hitBreak = host.breaks.find(b => overlaps(start, end, b.start, b.end));
    if (hitBreak) {
      conflicts.push({ id: a.id, user_name: a.user_name, service_name: a.service_name,
        start: toTimeString(start), end: toTimeString(end), reason: 'break', note: hitBreak.note });
    }
  }
  return conflicts;
}

// Dates in the next `days` days on which the master works at all. Used by the
// WhatsApp flow before it asks for a time, so a day off — template or
// override — never makes the list.
export async function getAvailableDates(masterId, days = 14) {
  const dates = [];
  const today = todayStr();
  for (let i = 1; i <= days; i++) {
    const date = addDays(today, i);
    const day = await getDaySchedule(masterId, date);
    if (day.isWorking && day.intervals.length) dates.push(date);
  }
  return dates;
}
