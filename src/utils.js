const DAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const DAYS_FULL  = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const MONTHS_GEN = ['января','февраля','марта','апреля','мая','июня',
                    'июля','августа','сентября','октября','ноября','декабря'];
const MONTHS_SHORT = ['янв','фев','мар','апр','май','июн',
                      'июл','авг','сен','окт','ноя','дек'];

// Everything is reckoned in the salon's timezone, not the server's and not
// the client's. Reading UTC here made "today" flip hours early or late for
// the salon, which moved the cut-off for same-day slots with it. 'sv-SE'
// formats as YYYY-MM-DD, which is what the rest of the code expects.
const TZ = process.env.TIMEZONE || 'Europe/Moscow';

export function todayStr() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date());
}

// Minutes since midnight, in the salon's timezone.
export function nowMinutes() {
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
  return toMinutes(hhmm);
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

// Slots live in src/schedule.js — see getFreeSlots(), the single source for
// every surface that offers a time to a client.

export const DAYS_SHORT_EXPORT = DAYS_SHORT;
export const DAYS_FULL_EXPORT  = DAYS_FULL;

// Postgres returns numeric as a string ("1500.00"), which is not what a
// client should see in a chat message.
export function formatPrice(value) {
  return `${Math.round(Number(value)).toLocaleString('ru-RU')} сом`;
}
