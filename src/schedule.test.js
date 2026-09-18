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
import { computeSlots, getDaySchedule, getFreeSlots, validateIntervals } from './schedule.js';

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
