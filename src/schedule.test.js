// The five acceptance scenarios for the two-level schedule, plus the edge
// cases that were easy to get wrong. Needs a Postgres to talk to:
//
//   DATABASE_URL=postgres://... node --test src/schedule.test.js
//
// It creates its own master and service and cleans up after itself, so it is
// safe against a scratch database, not against production data.
import test from 'node:test';
import assert from 'node:assert/strict';

import { db } from './database.js';
import {
  applyBlocks, computeSlots, getAvailableDates, getDaySchedule, getFreeSlots,
  getFreeSlotsForService, isFullyBlocked, validateIntervals,
} from './schedule.js';

const SATURDAY = '2026-09-19'; // a Saturday, weekday 5
const NEXT_SATURDAY = '2026-09-26';

const hours = (from, to, breaks = []) => [{ from, to, breaks }];
const starts = slots => slots.map(s => s.start);

let masterId;
let service;

test.before(async () => {
  await db.init();
  const master = await db.createMaster({ name: 'Тест-мастер', description: null });
  masterId = master.id;
  service = await db.createService({
    name: 'Тест-услуга', durationMinutes: 60, slotStepMinutes: 60, price: 1000,
  });
});

test.after(async () => {
  // schedule_template and schedule_override cascade from the master.
  await db.updateMaster(masterId, { name: 'Тест-мастер', isActive: false });
  await db.updateService(service.id, {
    name: 'Тест-услуга', durationMinutes: 60, slotStepMinutes: 60, price: 1000, isActive: false,
  });
});

// ── 1. A break on one date closes that slot, and only there ────────────────
test('перерыв на дате убирает слот только на этой дате', async () => {
  await db.upsertTemplateDay(masterId, 5, true, hours('12:00', '19:00'));
  await db.upsertOverride(masterId, SATURDAY, 'custom',
    hours('12:00', '19:00', [{ from: '16:00', to: '17:00', note: 'личное' }]));

  const onDate = await getFreeSlots(masterId, SATURDAY, 60, { stepMin: 60 });
  assert.ok(!starts(onDate).includes('16:00'), '16:00 должен быть закрыт перерывом');
  assert.deepEqual(starts(onDate), ['12:00', '13:00', '14:00', '15:00', '17:00', '18:00']);

  const otherSaturday = await getFreeSlots(masterId, NEXT_SATURDAY, 60, { stepMin: 60 });
  assert.deepEqual(starts(otherSaturday), ['12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00']);
});

// ── 2. Editing the template leaves the overridden date alone ───────────────
test('правка шаблона не переписывает дату с исключением', async () => {
  await db.upsertTemplateDay(masterId, 5, true, hours('10:00', '18:00'));

  const day = await getDaySchedule(masterId, SATURDAY);
  assert.equal(day.source, 'override');
  assert.equal(day.intervals[0].from, '12:00');
  assert.equal(day.intervals[0].to, '19:00');
  assert.equal(day.intervals[0].breaks.length, 1);

  const next = await getDaySchedule(masterId, NEXT_SATURDAY);
  assert.equal(next.source, 'template');
  assert.equal(next.intervals[0].from, '10:00');
});

// ── 3. "Back to the template" deletes the row, it does not copy hours ──────
test('вернуть шаблон — дата снова следует за шаблоном', async () => {
  await db.deleteOverride(masterId, SATURDAY);

  const day = await getDaySchedule(masterId, SATURDAY);
  assert.equal(day.source, 'template');
  assert.equal(day.intervals[0].from, '10:00');
  assert.equal(day.intervals[0].to, '18:00');
  assert.equal(await db.getOverride(masterId, SATURDAY), null);

  // And a later template edit reaches the date, which a copy would not.
  await db.upsertTemplateDay(masterId, 5, true, hours('11:00', '17:00'));
  const after = await getDaySchedule(masterId, SATURDAY);
  assert.equal(after.intervals[0].from, '11:00');
});

// ── 4. A day off yields no slots at all ────────────────────────────────────
test('выходной на дату отдаёт пустой список', async () => {
  await db.upsertOverride(masterId, SATURDAY, 'dayoff', []);

  const day = await getDaySchedule(masterId, SATURDAY);
  assert.equal(day.isWorking, false);
  assert.deepEqual(await getFreeSlots(masterId, SATURDAY, 60, { stepMin: 60 }), []);

  await db.deleteOverride(masterId, SATURDAY);
});

// ── 5. A break over an existing appointment flags it, keeps it ─────────────
test('перерыв поверх записи: запись остаётся, слот закрыт', async () => {
  const { findConflicts } = await import('./schedule.js');
  await db.upsertUser({ id: '996700000001', name: 'Клиент' });
  await db.upsertTemplateDay(masterId, 5, true, hours('12:00', '19:00'));
  const appt = await db.createAppointment({
    userId: '996700000001', masterId, serviceId: service.id,
    date: SATURDAY, startTime: '16:00', endTime: '17:00',
  });

  const intervals = hours('12:00', '19:00', [{ from: '16:00', to: '17:00', note: 'личное' }]);
  const conflicts = await findConflicts(masterId, SATURDAY, intervals);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].id, appt.id);
  assert.equal(conflicts[0].reason, 'break');

  await db.upsertOverride(masterId, SATURDAY, 'custom', intervals);
  assert.equal((await db.getAppointmentById(appt.id)).status, 'confirmed');
  assert.ok(!starts(await getFreeSlots(masterId, SATURDAY, 60, { stepMin: 60 })).includes('16:00'));

  await db.cancelAppointment(appt.id);
  await db.deleteOverride(masterId, SATURDAY);
});

// ── Edges ──────────────────────────────────────────────────────────────────
test('перерыв на границе просто укорачивает день', () => {
  const slots = computeSlots({
    intervals: hours('12:00', '17:00', [{ from: '16:00', to: '17:00' }]),
    durationMin: 60, stepMin: 60,
  });
  assert.deepEqual(starts(slots.filter(s => s.status === 'free')), ['12:00', '13:00', '14:00', '15:00']);
});

test('буфер между клиентами закрывает соседние слоты', () => {
  const slots = computeSlots({
    intervals: hours('12:00', '16:00'),
    durationMin: 60, stepMin: 60,
    booked: [{ start_time: '13:00', end_time: '14:00' }],
    bufferMin: 15,
  });
  assert.deepEqual(starts(slots.filter(s => s.status === 'free')), ['15:00']);
});

test('несколько интервалов в дне', () => {
  const slots = computeSlots({
    intervals: [
      { from: '10:00', to: '12:00', breaks: [] },
      { from: '15:00', to: '17:00', breaks: [] },
    ],
    durationMin: 60, stepMin: 60,
  });
  assert.deepEqual(starts(slots), ['10:00', '11:00', '15:00', '16:00']);
});

test('валидация отбивает кривые интервалы', () => {
  assert.throws(() => validateIntervals([]), /интервал/i);
  assert.throws(() => validateIntervals([{ from: '18:00', to: '12:00' }]), /позже начала/);
  assert.throws(() => validateIntervals([
    { from: '10:00', to: '14:00' }, { from: '13:00', to: '16:00' },
  ]), /пересекаются/);
  assert.throws(() => validateIntervals([
    { from: '10:00', to: '14:00', breaks: [{ from: '15:00', to: '16:00' }] },
  ]), /не попадает/);

  const ok = validateIntervals([
    { from: '15:00', to: '17:00' },
    { from: '10:00', to: '14:00', breaks: [{ from: '12:00', to: '13:00', note: ' обед ' }] },
  ]);
  assert.equal(ok[0].from, '10:00', 'интервалы должны отсортироваться');
  assert.equal(ok[0].breaks[0].note, 'обед');
});

// ── Long services: a start window, and taking the master's whole day ───────
// The case this exists for: сложное окрашивание runs for hours, so it may
// only start in the morning, and on the day it is booked the master takes
// nobody else.
test('окно начала обрезает поздние слоты', () => {
  const slots = computeSlots({
    intervals: [{ from: '09:00', to: '19:00', breaks: [] }],
    durationMin: 60, stepMin: 60,
    minStartMin: 10 * 60,   // не раньше 10:00
    maxStartMin: 12.5 * 60, // не позже 12:30
  });
  assert.deepEqual(starts(slots), ['10:00', '11:00', '12:00']);
});

test('услуга с окном и блокировкой дня забирает у мастера весь день', async (t) => {
  const long = await db.createService({
    name: 'Тест-окрашивание', durationMinutes: 120, slotStepMinutes: 60, price: 7000,
    earliestStart: '09:00', latestStart: '12:30', blocksDay: true,
  });
  t.after(async () => {
    await db.updateService(long.id, {
      name: 'Тест-окрашивание', durationMinutes: 120, slotStepMinutes: 60, price: 7000, isActive: false,
    });
  });

  await db.upsertOverride(masterId, NEXT_SATURDAY, 'custom', hours('09:00', '19:00'));

  // Начало ограничено окном: 13:00 и позже уже не предлагаются, хотя день
  // работает до 19:00.
  const offered = await getFreeSlotsForService(long, masterId, NEXT_SATURDAY);
  assert.deepEqual(starts(offered), ['09:00', '10:00', '11:00', '12:00']);

  await db.upsertUser({ id: 'test-blocks-day', name: 'Тест-клиент' });
  const appt = await db.createAppointment({
    userId: 'test-blocks-day', masterId, serviceId: long.id,
    date: NEXT_SATURDAY, startTime: '09:00', endTime: '11:00',
  });
  t.after(() => db.cancelAppointment(appt.id));

  // Обычная услуга в этот день больше не записывается — ни в 17:00, куда
  // окрашивание физически не дотягивается.
  assert.deepEqual(await getFreeSlotsForService(service, masterId, NEXT_SATURDAY), []);
  // …и сама длинная услуга на этот день тоже уже не встаёт.
  assert.deepEqual(await getFreeSlotsForService(long, masterId, NEXT_SATURDAY), []);
  // Соседняя дата не задета.
  assert.ok((await getFreeSlotsForService(service, masterId, SATURDAY)).length > 0);
});

test('длинная услуга не встаёт на день, где уже есть обычная запись', async (t) => {
  const long = await db.createService({
    name: 'Тест-окрашивание-2', durationMinutes: 120, slotStepMinutes: 60, price: 7000,
    earliestStart: '09:00', latestStart: '12:30', blocksDay: true,
  });
  t.after(async () => {
    await db.updateService(long.id, {
      name: 'Тест-окрашивание-2', durationMinutes: 120, slotStepMinutes: 60, price: 7000, isActive: false,
    });
  });

  await db.upsertOverride(masterId, NEXT_SATURDAY, 'custom', hours('09:00', '19:00'));
  await db.upsertUser({ id: 'test-blocks-day-2', name: 'Тест-клиент' });
  const appt = await db.createAppointment({
    userId: 'test-blocks-day-2', masterId, serviceId: service.id,
    date: NEXT_SATURDAY, startTime: '17:00', endTime: '18:00',
  });
  t.after(() => db.cancelAppointment(appt.id));

  assert.deepEqual(await getFreeSlotsForService(long, masterId, NEXT_SATURDAY), []);
  // Обычная услуга в этот день по-прежнему записывается.
  assert.ok((await getFreeSlotsForService(service, masterId, NEXT_SATURDAY)).length > 0);
});

// ── Закрытые часы салона ───────────────────────────────────────────────────
// Блок — поверх графика: сам график остаётся, время просто уходит из выдачи.
test('закрытые часы салона убирают слоты, но не трогают график мастера', async (t) => {
  await db.upsertOverride(masterId, NEXT_SATURDAY, 'custom', hours('12:00', '19:00'));
  const block = await db.createSalonBlock({
    date: NEXT_SATURDAY, startTime: '14:00', endTime: '16:00', note: 'уборка',
  });
  t.after(() => db.deleteSalonBlock(block.id));

  const slots = await getFreeSlots(masterId, NEXT_SATURDAY, 60, { stepMin: 60 });
  assert.deepEqual(starts(slots), ['12:00', '13:00', '16:00', '17:00', '18:00']);

  // График мастера при этом нетронут — блок не исключение по дате.
  const day = await getDaySchedule(masterId, NEXT_SATURDAY);
  assert.deepEqual(day.intervals, [{ from: '12:00', to: '19:00', breaks: [] }]);

  // И соседняя дата свободна.
  assert.ok(starts(await getFreeSlots(masterId, SATURDAY, 60, { stepMin: 60 })).includes('14:00'));
});

test('блок на весь день закрывает дату целиком', async (t) => {
  await db.upsertOverride(masterId, NEXT_SATURDAY, 'custom', hours('12:00', '19:00'));
  const block = await db.createSalonBlock({
    date: NEXT_SATURDAY, startTime: '00:00', endTime: '24:00', note: null,
  });
  t.after(() => db.deleteSalonBlock(block.id));

  assert.deepEqual(await getFreeSlots(masterId, NEXT_SATURDAY, 60, { stepMin: 60 }), []);
  assert.ok(!(await getAvailableDates(masterId, 21)).includes(NEXT_SATURDAY));
});

test('applyBlocks и isFullyBlocked считают без базы', () => {
  const iv = hours('10:00', '18:00', [{ from: '13:00', to: '14:00', note: 'обед' }]);
  const cut = applyBlocks(iv, [{ start_time: '09:00:00', end_time: '12:00:00', note: '' }]);
  // Блок подрезан по краю интервала и не съел собственный перерыв мастера.
  assert.deepEqual(cut[0].breaks, [
    { from: '13:00', to: '14:00', note: 'обед' },
    { from: '10:00', to: '12:00', note: 'салон закрыт' },
  ]);

  assert.equal(isFullyBlocked(iv, [{ start_time: '09:00', end_time: '17:00' }]), false);
  assert.equal(isFullyBlocked(iv, [{ start_time: '09:00', end_time: '18:00' }]), true);
  // Два блока встык закрывают день не хуже одного длинного.
  assert.equal(isFullyBlocked(iv, [
    { start_time: '10:00', end_time: '14:00' },
    { start_time: '14:00', end_time: '18:00' },
  ]), true);
});
