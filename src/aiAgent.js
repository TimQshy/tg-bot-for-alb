// Conversational booking agent: DeepSeek with tools, so free-form text like
// "привет, запишите меня на маникюр в субботу после обеда" is answered with
// the real schedule and can end in a real appointment row — no numbered menu
// in between. The numbered flow in booking.js stays as it is; a client who
// writes "меню" or replies with a digit still gets it.
//
// Every tool here goes through schedule.js/booking.js, never straight to SQL,
// so breaks, buffers, lead time and the waitlist behave exactly as they do in
// the menu flow and in the admin panel.
import { db } from './database.js';
import { chat } from './ai.js';
import { getFreeSlotsForService } from './schedule.js';
import {
  createAppointmentFor,
  cancelAppointmentFor,
  rescheduleAppointmentFor,
} from './booking.js';
import { addressMessage, getSalonInfo, getBookingHorizonDays, HORIZON_MAX } from './salonInfo.js';
import { join as joinWaitlist, waitlistEnabled } from './waitlist.js';
import {
  todayStr, addDays, formatDateFull, formatPrice,
  toMinutes, toTimeString, DAYS_FULL_EXPORT, getDayOfWeek,
} from './utils.js';

// How far ahead the agent is allowed to look for dates comes from the salon's
// own setting — the same one the numbered date list uses, so the two surfaces
// never disagree about whether November is open. The rest is how much of the
// conversation it remembers.
const CALENDAR_DAYS = 14;
const HISTORY_MAX = 16; // user+assistant messages, tool traffic excluded
const HISTORY_TTL_MS = 30 * 60 * 1000;
const MAX_TOOL_ROUNDS = 6;
const MAX_TIMES_LISTED = 24;

export const agentEnabled = () =>
  !!process.env.DEEPSEEK_API_KEY && process.env.AI_AGENT !== 'off';

// ── Conversation memory ────────────────────────────────────────────────────
// In memory on purpose, like session.js: a restart drops the small talk, and
// appointments are in Postgres either way. Only user/assistant turns are
// kept — tool calls and their results are re-derived each turn from live
// data, so a stale "10:00 свободно" can never be replayed as fact.
const histories = new Map();

function getHistory(phone) {
  const h = histories.get(phone);
  if (!h) return [];
  if (Date.now() - h.updatedAt > HISTORY_TTL_MS) {
    histories.delete(phone);
    return [];
  }
  return h.messages;
}

function pushHistory(phone, messages) {
  const next = [...getHistory(phone), ...messages].slice(-HISTORY_MAX);
  histories.set(phone, { messages: next, updatedAt: Date.now() });
}

export function clearHistory(phone) {
  histories.delete(phone);
  followUps.delete(phone);
}

// Messages the tools want sent after the model's own reply — the address
// block once a booking is made. Queued rather than sent from inside the tool
// so they land after the confirmation the client is reading, not before it.
const followUps = new Map();

function queueFollowUp(phone, text) {
  if (!text) return;
  followUps.set(phone, [...(followUps.get(phone) || []), text]);
}

export function takeFollowUps(phone) {
  const queued = followUps.get(phone) || [];
  followUps.delete(phone);
  return queued;
}

// ── Prompt ─────────────────────────────────────────────────────────────────
// The next two weeks spelled out, because asking a model to work out what
// date "суббота" is drifts by a day surprisingly often.
function calendarText() {
  const today = todayStr();
  const lines = [];
  for (let i = 0; i < CALENDAR_DAYS; i++) {
    const date = addDays(today, i);
    const weekday = DAYS_FULL_EXPORT[getDayOfWeek(date)].toLowerCase();
    const mark = i === 0 ? ' — сегодня' : i === 1 ? ' — завтра' : '';
    lines.push(`${date} (${weekday})${mark}`);
  }
  return lines.join('\n');
}

async function buildSystemPrompt(phone) {
  const [services, masters, appts, user, salon, horizonDays] = await Promise.all([
    db.getActiveServices(),
    db.getActiveMasters(),
    db.getUserAppointments(phone),
    db.getUser(phone),
    getSalonInfo(),
    getBookingHorizonDays(),
  ]);
  const waitlistOn = await waitlistEnabled();

  // Which master does which service — the agent needs it to pick a master_id
  // without a round trip, and to answer "кто делает маникюр?".
  const serviceLines = [];
  for (const s of services) {
    const who = await db.getMastersForService(s.id);
    // Spelled out so the agent can explain a refusal ("только до 12:30")
    // instead of just reporting an empty list of times.
    const limits = [];
    const from = s.earliest_start ? String(s.earliest_start).slice(0, 5) : null;
    const till = s.latest_start ? String(s.latest_start).slice(0, 5) : null;
    if (from || till) {
      limits.push(`начало записи ${from ? `не раньше ${from}` : ''}${from && till ? ', ' : ''}${till ? `не позже ${till}` : ''}`);
    }
    if (s.blocks_day) limits.push('занимает весь день мастера — в этот день к нему больше никого не записать');

    serviceLines.push(
      `- id=${s.id} | ${s.name} | от ${formatPrice(s.price)} | ${s.duration_minutes} мин | ` +
        `мастера: ${who.map(m => `${m.name} (id=${m.id})`).join(', ') || 'нет'}` +
        (limits.length ? ` | ${limits.join('; ')}` : '')
    );
  }

  const masterLines = masters.map(
    m => `- id=${m.id} | ${m.name}${m.description ? ` — ${m.description}` : ''}`
  );

  const apptLines = appts.map(a => {
    const date = String(a.appointment_date).slice(0, 10);
    return `- #${a.id} | ${a.service_name} | ${a.master_name} | ${date} ` +
      `${String(a.start_time).slice(0, 5)}–${String(a.end_time).slice(0, 5)}`;
  });

  const knownName = user?.name && user.name !== phone ? user.name : null;

  return `Ты — администратор салона красоты, отвечаешь клиенту в WhatsApp. Ты не бот с меню, ты живой консультант: ведёшь обычный разговор, сам смотришь расписание и сам оформляешь записи.

ЯЗЫК
Отвечай на том языке, на котором пишет клиент. Русский — отвечай по-русски. Кыргызча жазса — кыргызча жооп бер. Смешанный — отвечай на том, который преобладает. Названия услуг и имена мастеров не переводи.

СТИЛЬ
Коротко, тепло, по делу: 1–4 предложения. Без канцелярита и без списков на десять пунктов. Времена перечисляй компактно: «свободно 10:00, 11:30, 15:00». Эмодзи — максимум один на сообщение.
Это WhatsApp, а не markdown: никаких **, ##, --- и таблиц — клиент увидит эти символы как есть. Жирный — одинарные *звёздочки*, список — просто строки через перенос.

ЦЕНЫ
Все цены ориентировочные, указаны «от». Итог зависит от длины и густоты волос, их состояния и расхода материалов. Всегда говори «от X сом» и, если уместно, коротко поясняй, от чего зависит итог. Точную сумму мастер называет на консультации перед работой.

ЧТО ТЫ УМЕЕШЬ САМ (через инструменты)
- посмотреть свободное и занятое время на дату: check_availability
- найти ближайшие даты со свободными окнами: find_dates
- записать клиента: create_booking
- показать его записи: list_my_bookings
- перенести запись: reschedule_booking
- отменить запись: cancel_booking${waitlistOn ? '\n- поставить в лист ожидания, если на нужную дату нет времени: join_waitlist' : ''}

ПРАВИЛА РАБОТЫ
1. Никогда не выдумывай услуги, мастеров, цены, даты и свободное время. Свободное время называй ТОЛЬКО из ответа check_availability или find_dates.
2. Перед create_booking у тебя должны быть: услуга, мастер, дата, время — и явное согласие клиента на это время. Если мастер клиенту не важен, выбери любого, у кого есть это время, и назови его имя.
3. Если названного времени нет — так и скажи, что занято, и сразу предложи 2–3 ближайших свободных варианта.${waitlistOn ? ' Если клиенту нужна именно эта дата и другие варианты он не хочет — предложи лист ожидания: освободится место, напишем первому. Согласился — вызови join_waitlist. Очередь ведётся по конкретному мастеру, поэтому уточни, к какому именно, если он ещё не выбран.' : ''}
4. Перед reschedule_booking и cancel_booking убедись, о какой именно записи речь (если их несколько — уточни или покажи список через list_my_bookings).
5. После успешной записи/переноса/отмены подтверди одним коротким сообщением с датой, временем, мастером и номером записи (#id). Адрес после записи бот отправляет сам отдельным сообщением — не дублируй его в подтверждении.
6. Если клиент не знает имени, спроси его имя ДО записи и передай в create_booking параметром client_name${knownName ? ' (сейчас клиент записан как «' + knownName + '» — переспрашивать не надо)' : ''}.
7. Вопросы не про салон (услуги, цены, мастера, запись) — вежливо скажи, что помогаешь только с этим.
8. Работаешь с датами не дальше чем на ${horizonDays} дней вперёд. Прошедшие даты не предлагай.
9. У некоторых услуг есть ограничения (окно начала, занятость мастера на весь день) — они указаны в списке услуг. Если клиент просит время вне окна, объясни правило простыми словами («сложное окрашивание длится долго, поэтому начинаем только утром») и предложи подходящие варианты из check_availability.

${salon.address ? `САЛОН
Адрес: ${salon.address}${salon.address_note ? `\nКак найти: ${salon.address_note}` : ''}${salon.map_url ? `\nКарта: ${salon.map_url}` : ''}
Если клиент спрашивает, где вы находитесь или как добраться — отвечай этими данными и ничего не добавляй от себя.

` : ''}КАЛЕНДАРЬ (сегодня ${todayStr()})
${calendarText()}

УСЛУГИ
${serviceLines.join('\n') || '(нет активных услуг)'}

МАСТЕРА
${masterLines.join('\n') || '(нет активных мастеров)'}

КЛИЕНТ
Телефон: ${phone}${knownName ? `\nИмя: ${knownName}` : '\nИмя: неизвестно, спроси перед записью'}
Его активные записи:
${apptLines.join('\n') || '(нет активных записей)'}`;
}

// ── Tools ──────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'check_availability',
      description:
        'Свободное и занятое время на конкретную дату. Без master_id — по всем мастерам, которые делают эту услугу.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Дата в формате YYYY-MM-DD' },
          service_id: { type: 'integer', description: 'id услуги — от неё зависит длительность' },
          master_id: { type: 'integer', description: 'id мастера, если клиент выбрал конкретного' },
        },
        required: ['date', 'service_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_dates',
      description:
        'Ближайшие даты, где есть свободные окна под услугу, с первыми свободными временами на каждую дату.',
      parameters: {
        type: 'object',
        properties: {
          service_id: { type: 'integer' },
          master_id: { type: 'integer', description: 'если клиент хочет конкретного мастера' },
          days: { type: 'integer', description: 'сколько дней вперёд смотреть, по умолчанию 14' },
          from_date: { type: 'string', description: 'с какой даты искать, YYYY-MM-DD; по умолчанию с сегодня' },
        },
        required: ['service_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_booking',
      description:
        'Создать запись. Вызывай только после явного согласия клиента на конкретные услугу, мастера, дату и время.',
      parameters: {
        type: 'object',
        properties: {
          service_id: { type: 'integer' },
          master_id: { type: 'integer' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          start_time: { type: 'string', description: 'HH:MM, ровно одно из свободных времён' },
          client_name: { type: 'string', description: 'имя клиента, если он его назвал' },
        },
        required: ['service_id', 'master_id', 'date', 'start_time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_my_bookings',
      description: 'Активные записи этого клиента с их номерами (#id).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reschedule_booking',
      description: 'Перенести существующую запись клиента на другую дату/время. Услуга и мастер не меняются.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: { type: 'integer' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          start_time: { type: 'string', description: 'HH:MM' },
        },
        required: ['appointment_id', 'date', 'start_time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'join_waitlist',
      description:
        'Поставить клиента в лист ожидания на дату, где нет свободного времени. ' +
        'Вызывай, когда клиент хочет именно эту дату и согласен подождать отмены.',
      parameters: {
        type: 'object',
        properties: {
          service_id: { type: 'integer' },
          master_id: { type: 'integer', description: 'id мастера, к которому клиент хочет попасть' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          client_name: { type: 'string', description: 'имя клиента, если он его назвал' },
        },
        required: ['service_id', 'master_id', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_booking',
      description: 'Отменить запись клиента. Вызывай только после явного подтверждения отмены.',
      parameters: {
        type: 'object',
        properties: { appointment_id: { type: 'integer' } },
        required: ['appointment_id'],
      },
    },
  },
];

// ── Tool implementations ───────────────────────────────────────────────────
const isPastDate = date => date < todayStr();

// The salon's booking horizon, as a check rather than a hint: the prompt says
// how far ahead it may work, this is what stops it when it forgets. The panel
// is deliberately not limited this way — the salon books whatever it likes.
async function beyondHorizon(date) {
  return date > addDays(todayStr(), await getBookingHorizonDays());
}

async function slotsFor(masterId, date, service, { includeBusy = false, excludeApptId = null } = {}) {
  return getFreeSlotsForService(service, masterId, date, { includeBusy, excludeApptId });
}

async function mastersFor(service, masterId) {
  if (masterId) {
    const m = await db.getMaster(masterId);
    return m ? [m] : [];
  }
  return db.getMastersForService(service.id);
}

async function toolCheckAvailability({ date, service_id, master_id }) {
  const service = await db.getService(service_id);
  if (!service) return { error: 'Услуга не найдена' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return { error: 'Дата должна быть в формате YYYY-MM-DD' };
  if (isPastDate(date)) return { error: 'Эта дата уже прошла' };
  if (await beyondHorizon(date)) return { error: 'На эту дату запись ещё не открыта — она слишком далеко' };

  const masters = await mastersFor(service, master_id);
  if (!masters.length) return { error: 'Нет мастеров для этой услуги' };

  const result = [];
  for (const m of masters) {
    const slots = await slotsFor(m.id, date, service, { includeBusy: true });
    result.push({
      master_id: m.id,
      master: m.name,
      works: slots.length > 0,
      free: slots.filter(s => s.status === 'free').map(s => s.start).slice(0, MAX_TIMES_LISTED),
      busy: slots.filter(s => s.status !== 'free').map(s => s.start).slice(0, MAX_TIMES_LISTED),
    });
  }
  return { date, service: service.name, duration_min: service.duration_minutes, masters: result };
}

async function toolFindDates({ service_id, master_id, days, from_date }) {
  const service = await db.getService(service_id);
  if (!service) return { error: 'Услуга не найдена' };

  const masters = await mastersFor(service, master_id);
  if (!masters.length) return { error: 'Нет мастеров для этой услуги' };

  // The salon's horizon caps how far a search may run, but only from today:
  // a search starting a month out still gets its own window, it just cannot
  // walk past the horizon's end.
  const horizonDays = await getBookingHorizonDays();
  const span = Math.min(Math.max(parseInt(days, 10) || 14, 1), HORIZON_MAX);
  const today = todayStr();
  let start = /^\d{4}-\d{2}-\d{2}$/.test(from_date || '') ? from_date : today;
  if (start < today) start = today;

  const lastDate = addDays(today, horizonDays);
  const dates = [];
  for (let i = 0; i < span && dates.length < 10; i++) {
    const date = addDays(start, i);
    if (date > lastDate) break;
    for (const m of masters) {
      const free = await slotsFor(m.id, date, service);
      if (!free.length) continue;
      dates.push({
        date,
        master_id: m.id,
        master: m.name,
        free: free.map(s => s.start).slice(0, 8),
        free_count: free.length,
      });
    }
  }
  return { service: service.name, from: start, dates };
}

// Only times the schedule actually offers are bookable: a client asking for
// 10:17 or for a slot that doesn't fit before a break must be told no, not
// squeezed in behind getFreeSlots' back.
async function resolveSlot(masterId, date, service, startTime, excludeApptId = null) {
  if (!/^\d{1,2}:\d{2}$/.test(startTime || '')) return { error: 'Время должно быть в формате ЧЧ:ММ' };
  const normalised = toTimeString(toMinutes(startTime.padStart(5, '0')));
  const slots = await slotsFor(masterId, date, service, { excludeApptId });
  const hit = slots.find(s => s.start === normalised);
  if (!hit) {
    return {
      error: `Время ${normalised} недоступно`,
      free: slots.map(s => s.start).slice(0, MAX_TIMES_LISTED),
    };
  }
  return { start: hit.start, end: hit.end };
}

async function toolCreateBooking(phone, { service_id, master_id, date, start_time, client_name }) {
  const service = await db.getService(service_id);
  if (!service) return { error: 'Услуга не найдена' };
  const master = await db.getMaster(master_id);
  if (!master) return { error: 'Мастер не найден' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return { error: 'Дата должна быть в формате YYYY-MM-DD' };
  if (isPastDate(date)) return { error: 'Эта дата уже прошла' };
  if (await beyondHorizon(date)) return { error: 'На эту дату запись ещё не открыта — она слишком далеко' };

  const slot = await resolveSlot(master_id, date, service, start_time);
  if (slot.error) return slot;

  if (client_name) await db.setUserNameIfUnknown(phone, client_name.trim().slice(0, 80));

  const appt = await createAppointmentFor(phone, {
    serviceId: service_id,
    masterId: master_id,
    date,
    startTime: slot.start,
    endTime: slot.end,
  });
  if (!appt) return { error: 'Это время только что заняли, предложи другое' };

  queueFollowUp(phone, await addressMessage());

  return {
    ok: true,
    appointment_id: appt.id,
    service: service.name,
    master: master.name,
    date,
    date_human: formatDateFull(date),
    start: slot.start,
    end: slot.end,
    price_from: formatPrice(service.price),
  };
}

async function toolListMyBookings(phone) {
  const appts = await db.getUserAppointments(phone);
  return {
    bookings: appts.map(a => ({
      appointment_id: a.id,
      service: a.service_name,
      service_id: a.service_id,
      master: a.master_name,
      master_id: a.master_id,
      date: String(a.appointment_date).slice(0, 10),
      start: String(a.start_time).slice(0, 5),
      end: String(a.end_time).slice(0, 5),
      price_from: formatPrice(a.price),
    })),
  };
}

async function toolRescheduleBooking(phone, { appointment_id, date, start_time }) {
  const appt = await db.getAppointmentById(appointment_id);
  if (!appt || appt.status !== 'confirmed' || appt.user_id !== phone) {
    return { error: 'Такой записи нет или она уже отменена' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return { error: 'Дата должна быть в формате YYYY-MM-DD' };
  if (isPastDate(date)) return { error: 'Эта дата уже прошла' };
  if (await beyondHorizon(date)) return { error: 'На эту дату запись ещё не открыта — она слишком далеко' };

  const service = await db.getService(appt.service_id);
  // The appointment's own slot must not count as busy when it moves inside
  // the same day.
  const slot = await resolveSlot(appt.master_id, date, service, start_time, appointment_id);
  if (slot.error) return slot;

  const updated = await rescheduleAppointmentFor(phone, appointment_id, {
    date, startTime: slot.start, endTime: slot.end,
  });
  if (!updated) return { error: 'Это время только что заняли, предложи другое' };

  return {
    ok: true,
    appointment_id,
    service: appt.service_name,
    master: appt.master_name,
    date,
    date_human: formatDateFull(date),
    start: slot.start,
    end: slot.end,
  };
}

// The queue needs a master: it is FIFO per (master, date), and "любой
// мастер" has nobody to free a slot. The agent picks one and says whose
// queue it is, the same way it picks a master for a booking.
async function toolJoinWaitlist(phone, { service_id, master_id, date, client_name }) {
  if (!(await waitlistEnabled())) return { error: 'Лист ожидания сейчас не работает' };

  const service = await db.getService(service_id);
  if (!service) return { error: 'Услуга не найдена' };
  const master = await db.getMaster(master_id);
  if (!master) return { error: 'Мастер не найден' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return { error: 'Дата должна быть в формате YYYY-MM-DD' };
  if (isPastDate(date)) return { error: 'Эта дата уже прошла' };
  if (await beyondHorizon(date)) return { error: 'На эту дату запись ещё не открыта — она слишком далеко' };

  // Free time on the date means there is nothing to wait for — booking it is
  // the answer, and a queue entry behind an empty slot would never fire.
  const free = await slotsFor(master_id, date, service);
  if (free.length) {
    return {
      error: 'На эту дату есть свободное время — предложи записаться, очередь не нужна',
      free: free.map(s => s.start).slice(0, MAX_TIMES_LISTED),
    };
  }

  if (client_name) await db.setUserNameIfUnknown(phone, client_name.trim().slice(0, 80));

  const result = await joinWaitlist({ userId: phone, masterId: master_id, serviceId: service_id, date });
  if (result.reason === 'disabled') return { error: 'Лист ожидания сейчас не работает' };

  return {
    ok: true,
    already_waiting: result.reason === 'already_waiting',
    service: service.name,
    master: master.name,
    date,
    date_human: formatDateFull(date),
  };
}

async function toolCancelBooking(phone, { appointment_id }) {
  const appt = await db.getAppointmentById(appointment_id);
  if (!appt || appt.status !== 'confirmed' || appt.user_id !== phone) {
    return { error: 'Такой записи нет или она уже отменена' };
  }
  const ok = await cancelAppointmentFor(phone, appointment_id);
  if (!ok) return { error: 'Не удалось отменить, запись уже неактивна' };
  return { ok: true, appointment_id, service: appt.service_name, master: appt.master_name };
}

async function runTool(phone, name, args) {
  switch (name) {
    case 'check_availability': return toolCheckAvailability(args);
    case 'find_dates':         return toolFindDates(args);
    case 'create_booking':     return toolCreateBooking(phone, args);
    case 'list_my_bookings':   return toolListMyBookings(phone);
    case 'reschedule_booking': return toolRescheduleBooking(phone, args);
    case 'join_waitlist':      return toolJoinWaitlist(phone, args);
    case 'cancel_booking':     return toolCancelBooking(phone, args);
    default: return { error: `Неизвестный инструмент ${name}` };
  }
}

// ── Agent loop ─────────────────────────────────────────────────────────────
// Returns the reply text, or null if DeepSeek is unavailable/failed — the
// caller then falls back to the numbered menu.
export async function runAgent(phone, userText) {
  if (!agentEnabled()) return null;

  const system = await buildSystemPrompt(phone);
  const tools = (await waitlistEnabled()) ? TOOLS : TOOLS.filter(t => t.function.name !== 'join_waitlist');
  const turn = [{ role: 'user', content: userText }];
  const messages = [{ role: 'system', content: system }, ...getHistory(phone), ...turn];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const message = await chat({ messages, tools });
      messages.push(message);

      const calls = message.tool_calls || [];
      if (!calls.length) {
        const answer = (message.content || '').trim();
        if (!answer) return null;
        pushHistory(phone, [...turn, { role: 'assistant', content: answer }]);
        return answer;
      }

      for (const call of calls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          args = {};
        }
        let result;
        try {
          result = await runTool(phone, call.function.name, args);
        } catch (err) {
          console.error(`[agent] tool ${call.function.name} failed:`, err.message);
          result = { error: 'Техническая ошибка, попробуй другой вариант' };
        }
        console.log(`[agent] ${phone} ${call.function.name}(${JSON.stringify(args)})`);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }
    // Ran out of rounds — the model is looping on tools instead of answering.
    console.warn(`[agent] ${phone}: tool round limit reached`);
    return null;
  } catch (err) {
    console.error('[agent] failed:', err.message);
    return null;
  }
}
