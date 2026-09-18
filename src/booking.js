import { db } from './database.js';
import { sendText } from './whatsapp.js';
import { sendMenu } from './menu.js';
import { getSession, setSession, clearSession } from './session.js';
import { formatDateShort, formatDateFull, formatPrice } from './utils.js';
import { getAvailableDates, getFreeSlots } from './schedule.js';
import * as waitlist from './waitlist.js';

const SLOTS_PAGE_SIZE = 9;
const MENU_PAGE_SIZE = 9; // + 1 row for "ещё", matches old MAX_LIST_ROWS-1 budget

const ADMIN_PHONES = () => (process.env.ADMIN_PHONES || '').split(',').map(s => s.trim()).filter(Boolean);

export function sendMainMenu(phone, greeting = 'Здравствуйте! Чем можем помочь?') {
  return sendMenu(phone, greeting, [
    { id: 'book', label: '✂️ Записаться' },
    { id: 'my_bookings', label: '📋 Мои записи' },
  ]);
}

// ── Step 0: start → show services ─────────────────────────────────────────
export async function start(phone) {
  const services = await db.getActiveServices();
  if (!services.length) {
    clearSession(phone);
    return sendText(phone, '😔 Нет доступных услуг. Свяжитесь с салоном.');
  }

  clearSession(phone);
  setSession(phone, { step: 'choose_service' });

  const items = services.slice(0, MENU_PAGE_SIZE).map(s => ({
    id: `svc:${s.id}`,
    label: `${s.name} — ${formatPrice(s.price)} · ${s.duration_minutes} мин`,
  }));

  return sendMenu(phone, '💅 Запись в салон\n\nВыберите услугу (ответьте цифрой):', items);
}

// ── Step 1: service chosen → show masters ───────────────────────────────
export async function chooseService(phone, serviceIdStr) {
  const session = getSession(phone);
  if (!session || session.step !== 'choose_service') return start(phone);

  const serviceId = parseInt(serviceIdStr, 10);
  const service = await db.getService(serviceId);
  if (!service) return start(phone);

  const masters = await db.getMastersForService(serviceId);
  if (!masters.length) {
    clearSession(phone);
    return sendText(phone, `😔 Нет доступных мастеров для «${service.name}».`);
  }

  setSession(phone, {
    step: 'choose_master',
    serviceId,
    serviceName: service.name,
    serviceDuration: service.duration_minutes,
    serviceStep: service.slot_step_minutes,
    servicePrice: service.price,
  });

  const items = masters.slice(0, MENU_PAGE_SIZE).map(m => ({
    id: `mst:${m.id}`,
    label: m.description ? `${m.name} — ${m.description}` : m.name,
  }));

  return sendMenu(
    phone,
    `💅 ${service.name}\n💰 ${formatPrice(service.price)} · ⏱ ${service.duration_minutes} мин\n\nВыберите мастера (ответьте цифрой):`,
    items
  );
}

// ── Step 2: master chosen → show dates ───────────────────────────────────
export async function chooseMaster(phone, masterIdStr) {
  const session = getSession(phone);
  if (!session || session.step !== 'choose_master') return start(phone);

  const masterId = parseInt(masterIdStr, 10);
  const master = await db.getMaster(masterId);
  if (!master) return start(phone);

  const dates = (await getAvailableDates(masterId, 30)).slice(0, MENU_PAGE_SIZE);
  if (!dates.length) {
    clearSession(phone);
    return sendText(phone, `😔 У мастера «${master.name}» нет свободных дат в ближайшее время.`);
  }

  setSession(phone, { ...session, step: 'choose_date', masterId, masterName: master.name });

  const items = dates.map(d => ({ id: `dt:${d}`, label: formatDateShort(d) }));

  return sendMenu(phone, `💅 ${session.serviceName}\n👩 ${master.name}\n\nВыберите дату (ответьте цифрой):`, items);
}

// ── Step 3: date chosen → show time slots ────────────────────────────────
export async function chooseDate(phone, dateStr) {
  const session = getSession(phone);
  if (!session || session.step !== 'choose_date') return start(phone);

  const slots = await getFreeSlots(session.masterId, dateStr, session.serviceDuration, {
    stepMin: session.serviceStep,
  });
  if (!slots.length) {
    setSession(phone, { ...session, step: 'waitlist_offer', date: dateStr });
    return sendMenu(
      phone,
      `😔 На эту дату нет свободных слотов у ${session.masterName}.\n\n` +
        `Встать в лист ожидания? Если кто-то отменит запись — напишем вам первому.`,
      [
        { id: 'waitlist_join', label: '⏳ Встать в очередь' },
        { id: 'main_menu', label: '⬅️ В меню' },
      ]
    );
  }

  setSession(phone, { ...session, step: 'choose_slot', date: dateStr, slots, slotPage: 0 });
  return sendSlotsPage(phone);
}

async function sendSlotsPage(phone) {
  const session = getSession(phone);
  if (!session || session.step !== 'choose_slot') return start(phone);

  const page = session.slotPage || 0;
  const pageSlots = session.slots.slice(page * SLOTS_PAGE_SIZE, (page + 1) * SLOTS_PAGE_SIZE);
  const hasMore = session.slots.length > (page + 1) * SLOTS_PAGE_SIZE;

  const items = pageSlots.map(s => ({ id: `slot:${s.start}|${s.end}`, label: `${s.start}–${s.end}` }));
  if (hasMore) items.push({ id: 'more_slots', label: '▶️ Ещё время' });

  return sendMenu(
    phone,
    `💅 ${session.serviceName}\n👩 ${session.masterName}\n📅 ${formatDateFull(session.date)}\n\nВыберите время (ответьте цифрой):`,
    items
  );
}

export async function nextSlotsPage(phone) {
  const session = getSession(phone);
  if (!session || session.step !== 'choose_slot') return start(phone);
  setSession(phone, { ...session, slotPage: (session.slotPage || 0) + 1 });
  return sendSlotsPage(phone);
}

// ── Step 4: slot chosen → confirmation screen ────────────────────────────
export async function chooseSlot(phone, encoded) {
  const session = getSession(phone);
  if (!session || session.step !== 'choose_slot') return start(phone);

  const [startTime, endTime] = encoded.split('|');
  setSession(phone, { ...session, step: 'confirm', startTime, endTime });

  const s = getSession(phone);
  return sendMenu(
    phone,
    `✅ Подтвердите запись:\n\n` +
      `💅 Услуга: ${s.serviceName}\n` +
      `👩 Мастер: ${s.masterName}\n` +
      `📅 Дата: ${formatDateFull(s.date)}\n` +
      `🕐 Время: ${s.startTime} – ${s.endTime}\n` +
      `💰 Стоимость: ${formatPrice(s.servicePrice)}`,
    [
      { id: 'confirm', label: '✅ Подтвердить' },
      { id: 'cancel', label: '❌ Отмена' },
    ]
  );
}

// ── Step 5: confirmed → create appointment ───────────────────────────────
export async function confirm(phone) {
  const session = getSession(phone);
  if (!session || session.step !== 'confirm') return start(phone);
  const s = session;

  const available = await db.isSlotAvailable(s.masterId, s.date, s.startTime, s.endTime);
  if (!available) {
    clearSession(phone);
    await sendText(phone, '😔 Этот слот только что заняли. Начните запись заново.');
    return sendMainMenu(phone);
  }

  const appt = await db.createAppointment({
    userId: phone,
    masterId: s.masterId,
    serviceId: s.serviceId,
    date: s.date,
    startTime: s.startTime,
    endTime: s.endTime,
  });

  clearSession(phone);

  await sendText(
    phone,
    `🎉 Запись подтверждена!\n\n` +
      `💅 ${s.serviceName}\n` +
      `👩 ${s.masterName}\n` +
      `📅 ${formatDateFull(s.date)}\n` +
      `🕐 ${s.startTime} – ${s.endTime}\n` +
      `💰 ${formatPrice(s.servicePrice)}\n\n` +
      `📋 Номер записи: #${appt.id}\n\n` +
      `До встречи! 👋`
  );

  const userAppt = await db.getAppointmentById(appt.id);
  const adminText =
    `📩 Новая запись #${appt.id}\n\n` +
    `👤 ${userAppt.user_name} (${phone})\n` +
    `💅 ${s.serviceName}\n` +
    `👩 ${s.masterName}\n` +
    `📅 ${formatDateFull(s.date)}\n` +
    `🕐 ${s.startTime} – ${s.endTime}\n\n` +
    `Чтобы отменить, напишите: cancel ${appt.id}`;

  for (const adminPhone of ADMIN_PHONES()) {
    sendText(adminPhone, adminText).catch(() => {});
  }
}

// ── Cancel-during-flow ────────────────────────────────────────────────────
export async function cancelFlow(phone) {
  clearSession(phone);
  await sendText(phone, 'Запись отменена.');
  return sendMainMenu(phone);
}

// ── My bookings ────────────────────────────────────────────────────────────
export async function showMyBookings(phone) {
  clearSession(phone);
  const appts = await db.getUserAppointments(phone);

  if (!appts.length) {
    return sendMenu(phone, '📋 У вас нет активных записей.', [{ id: 'book', label: '✂️ Записаться' }]);
  }

  let text = '📋 Ваши записи:\n\n';
  for (const a of appts) {
    text +=
      `💅 ${a.service_name}\n` +
      `👩 ${a.master_name}\n` +
      `📅 ${formatDateFull(String(a.appointment_date).slice(0, 10))}\n` +
      `🕐 ${String(a.start_time).slice(0, 5)} – ${String(a.end_time).slice(0, 5)}  ·  💰 ${formatPrice(a.price)}\n` +
      `#${a.id}\n\n`;
  }
  await sendText(phone, text.trim());

  const items = appts.slice(0, MENU_PAGE_SIZE).map(a => ({
    id: `cancel_appt:${a.id}`,
    label: `Отменить #${a.id} (${a.service_name} · ${String(a.start_time).slice(0, 5)})`,
  }));
  items.push({ id: 'book', label: '✂️ Новая запись' });

  return sendMenu(phone, 'Действия (ответьте цифрой):', items);
}

export async function startCancelAppt(phone, apptIdStr) {
  const apptId = parseInt(apptIdStr, 10);
  const appt = await db.getAppointmentById(apptId);

  if (!appt || appt.status !== 'confirmed' || appt.user_id !== phone) {
    return sendText(phone, 'Запись не найдена или уже отменена.');
  }

  return sendMenu(
    phone,
    `❓ Отменить запись?\n\n` +
      `💅 ${appt.service_name}\n` +
      `👩 ${appt.master_name}\n` +
      `📅 ${formatDateFull(String(appt.appointment_date).slice(0, 10))}\n` +
      `🕐 ${String(appt.start_time).slice(0, 5)} – ${String(appt.end_time).slice(0, 5)}`,
    [
      { id: `confirm_cancel:${apptId}`, label: '✅ Да, отменить' },
      { id: 'my_bookings', label: '⬅️ Назад' },
    ]
  );
}

export async function confirmCancelAppt(phone, apptIdStr) {
  const apptId = parseInt(apptIdStr, 10);
  const appt = await db.getAppointmentById(apptId);

  if (!appt || appt.status !== 'confirmed' || appt.user_id !== phone) {
    return sendText(phone, 'Запись уже отменена.');
  }

  await db.cancelAppointment(apptId);
  await sendText(phone, '✅ Запись отменена.');
  waitlist.notifyNext(appt.master_id, String(appt.appointment_date).slice(0, 10)).catch(() => {});
  return sendMainMenu(phone);
}

// ── Admin cancel (admin replies "cancel <id>" to a new-booking notification) ─
export async function handleAdminCancel(phone, apptIdStr) {
  if (!ADMIN_PHONES().includes(phone)) return; // silently ignore non-admins

  const apptId = parseInt(apptIdStr, 10);
  const appt = await db.getAppointmentById(apptId);

  if (!appt || appt.status !== 'confirmed') {
    return sendText(phone, `Запись #${apptId} уже отменена или не найдена.`);
  }

  await db.cancelAppointment(apptId);
  await sendText(phone, `✅ Запись #${apptId} отменена. Клиент уведомлён.`);

  await sendText(
    appt.user_id,
    `❌ Ваша запись отменена салоном\n\n` +
      `💅 ${appt.service_name}\n` +
      `👩 ${appt.master_name}\n` +
      `📅 ${formatDateFull(String(appt.appointment_date).slice(0, 10))}\n` +
      `🕐 ${String(appt.start_time).slice(0, 5)} – ${String(appt.end_time).slice(0, 5)}\n\n` +
      `Для новой записи напишите "меню".`
  );

  waitlist.notifyNext(appt.master_id, String(appt.appointment_date).slice(0, 10)).catch(() => {});
}
