import { db } from './database.js';

const DAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const DAYS_FULL  = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const MONTHS_GEN = ['января','февраля','марта','апреля','мая','июня',
                    'июля','августа','сентября','октября','ноября','декабря'];
const MONTHS_SHORT = ['янв','фев','мар','апр','май','июн',
                      'июл','авг','сен','окт','ноя','дек'];

export function todayStr() {
  return new Date().toISOString().split('T')[0];
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

// Returns 0=Mon … 6=Sun  (ISO weekday convention)
export function getDayOfWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const jsDay = d.getUTCDay(); // 0=Sun
  return jsDay === 0 ? 6 : jsDay - 1;
}

// "18 июл, Пт"
export function formatDateShort(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}, ${DAYS_SHORT[getDayOfWeek(dateStr)]}`;
}

// "18 июля (пятница)"
export function formatDateFull(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return `${d.getUTCDate()} ${MONTHS_GEN[d.getUTCMonth()]} (${DAYS_FULL[getDayOfWeek(dateStr)].toLowerCase()})`;
}

// "09:30" → 570
export function toMinutes(timeStr) {
  const [h, m] = timeStr.slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}

// 570 → "09:30"
export function toTimeString(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// Generate free time slots given working hours, service duration, and booked slots
export function generateSlots(startTime, endTime, durationMin, bookedSlots) {
  const start = toMinutes(startTime);
  const end   = toMinutes(endTime);
  const slots = [];

  for (let s = start; s + durationMin <= end; s += 30) {
    const e = s + durationMin;
    const overlaps = bookedSlots.some(b => {
      const bs = toMinutes(b.start_time);
      const be = toMinutes(b.end_time);
      return !(e <= bs || s >= be);
    });
    if (!overlaps) slots.push({ start: toTimeString(s), end: toTimeString(e) });
  }
  return slots;
}

// Returns date strings (next `days` days) where the master has working hours
export async function getAvailableDates(masterId, days = 14) {
  const dates = [];
  for (let i = 1; i <= days; i++) {
    const dateStr = addDays(todayStr(), i);
    const dow = getDayOfWeek(dateStr);
    const hours = await db.getWorkingHours(masterId, dow);
    if (hours) dates.push(dateStr);
  }
  return dates;
}

// Returns free time slots for master on a given date
export async function getTimeSlotsForMaster(masterId, dateStr, durationMin, excludeApptId = null) {
  const dow = getDayOfWeek(dateStr);
  const hours = await db.getWorkingHours(masterId, dow);
  if (!hours) return [];
  const booked = await db.getBookedSlots(masterId, dateStr, excludeApptId);
  return generateSlots(hours.start_time, hours.end_time, durationMin, booked);
}

export const DAYS_SHORT_EXPORT = DAYS_SHORT;
export const DAYS_FULL_EXPORT  = DAYS_FULL;
