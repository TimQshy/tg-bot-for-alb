// Route-level checks for the schedule API. Clerk is mocked out, so this
// exercises the handlers themselves — validation, which level a write lands
// on, and the fact that conflicts never block a save.
//
//   DATABASE_URL=postgres://... node --test --experimental-test-module-mocks src/admin.test.js
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

mock.module('./adminAuth.js', {
  namedExports: {
    authorizeAdmin: async () => ({ userId: 'test', isSystemAdmin: true }),
    clerk: () => { throw new Error('not used in these tests'); },
  },
});

const { db } = await import('./database.js');
const { adminRouter } = await import('./admin.js');

const SATURDAY = '2026-09-19';
let server;
let base;
let masterId;

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test.before(async () => {
  await db.init();
  masterId = (await db.createMaster({ name: 'Роут-мастер' })).id;

  const app = express();
  app.use(express.json());
  app.use('/admin', adminRouter);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/admin`;
});

test.after(async () => {
  await db.updateMaster(masterId, { name: 'Роут-мастер', isActive: false });
  server.close();
});

test('шаблон недели пишется и читается', async () => {
  const put = await call('PUT', '/api/schedule/template', {
    masterId, weekday: 5, isWorking: true,
    intervals: [{ from: '12:00', to: '19:00', breaks: [] }],
  });
  assert.equal(put.status, 200);

  const get = await call('GET', `/api/schedule/template?masterId=${masterId}`);
  assert.equal(get.body.length, 1);
  assert.equal(get.body[0].intervals[0].from, '12:00');
});

test('кривые интервалы отбиваются с понятным текстом', async () => {
  const res = await call('PUT', '/api/schedule/template', {
    masterId, weekday: 5, isWorking: true,
    intervals: [{ from: '19:00', to: '12:00', breaks: [] }],
  });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /позже начала/);
});

test('исключение на дату не трогает шаблон', async () => {
  const res = await call('PUT', '/api/schedule/override', {
    masterId, date: SATURDAY, kind: 'custom',
    intervals: [{ from: '12:00', to: '19:00', breaks: [{ from: '16:00', to: '17:00', note: 'личное' }] }],
  });
  assert.equal(res.status, 200);

  const template = await call('GET', `/api/schedule/template?masterId=${masterId}`);
  assert.equal(template.body[0].intervals[0].breaks.length, 0, 'шаблон должен остаться без перерыва');

  const day = await call('GET', `/api/schedule/day?masterId=${masterId}&date=${SATURDAY}`);
  assert.equal(day.body.source, 'override');
  assert.ok(!day.body.slots.some(s => s.start === '16:00' && s.status === 'free'));
});

test('«повторять каждую» переносит часы в шаблон', async () => {
  const res = await call('PUT', '/api/schedule/override', {
    masterId, date: SATURDAY, kind: 'custom', repeatWeekly: true,
    intervals: [{ from: '11:00', to: '20:00', breaks: [] }],
  });
  assert.equal(res.status, 200);

  const template = await call('GET', `/api/schedule/template?masterId=${masterId}`);
  const saturday = template.body.find(t => t.weekday === 5);
  assert.equal(saturday.intervals[0].from, '11:00');
  assert.equal(saturday.intervals[0].to, '20:00');
});

test('удаление исключения возвращает дату под шаблон', async () => {
  const del = await call('DELETE', `/api/schedule/override?masterId=${masterId}&date=${SATURDAY}`);
  assert.equal(del.status, 200);

  const day = await call('GET', `/api/schedule/day?masterId=${masterId}&date=${SATURDAY}`);
  assert.equal(day.body.source, 'template');
});

test('выходной на дату отдаёт пустые слоты', async () => {
  await call('PUT', '/api/schedule/override', { masterId, date: SATURDAY, kind: 'dayoff' });
  const day = await call('GET', `/api/schedule/day?masterId=${masterId}&date=${SATURDAY}`);
  assert.equal(day.body.isWorking, false);
  assert.deepEqual(day.body.slots, []);
  await call('DELETE', `/api/schedule/override?masterId=${masterId}&date=${SATURDAY}`);
});

test('превью считает слоты, ничего не сохраняя', async () => {
  const res = await call('POST', '/api/schedule/preview', {
    masterId, date: SATURDAY, kind: 'custom',
    intervals: [{ from: '10:00', to: '12:00', breaks: [] }],
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.slots.length);

  const day = await call('GET', `/api/schedule/day?masterId=${masterId}&date=${SATURDAY}`);
  assert.equal(day.body.source, 'template', 'превью не должно создавать исключение');
});

test('конфликт не блокирует сохранение', async () => {
  const service = await db.createService({
    name: 'Роут-услуга', durationMinutes: 60, slotStepMinutes: 60, price: 100,
  });
  await db.setServiceMasters(service.id, [masterId]);
  await db.upsertUser({ id: '996700000002', name: 'Клиент' });
  const appt = await db.createAppointment({
    userId: '996700000002', masterId, serviceId: service.id,
    date: SATURDAY, startTime: '16:00', endTime: '17:00',
  });

  const res = await call('PUT', '/api/schedule/override', {
    masterId, date: SATURDAY, kind: 'custom',
    intervals: [{ from: '11:00', to: '20:00', breaks: [{ from: '16:00', to: '17:00', note: 'личное' }] }],
  });
  assert.equal(res.status, 200, 'сохранение должно пройти');
  assert.equal(res.body.conflicts.length, 1);
  assert.equal(res.body.conflicts[0].id, appt.id);
  assert.equal((await db.getAppointmentById(appt.id)).status, 'confirmed');

  await db.cancelAppointment(appt.id);
  await db.updateService(service.id, {
    name: 'Роут-услуга', durationMinutes: 60, slotStepMinutes: 60, price: 100, isActive: false,
  });
});

test('мастера создаются и отключаются', async () => {
  const created = await call('POST', '/api/masters', { name: 'Новый', description: 'брови' });
  assert.equal(created.status, 200);
  assert.equal(created.body.is_active, true);

  const off = await call('PUT', `/api/masters/${created.body.id}`, { name: 'Новый', is_active: false });
  assert.equal(off.body.is_active, false);

  assert.equal((await call('POST', '/api/masters', { name: '  ' })).status, 400);
  assert.equal((await call('PUT', '/api/masters/999999', { name: 'Нет такого' })).status, 404);
});

test('услуга без записей удаляется, а с записями — только скрывается', async () => {
  const fresh = await db.createService({
    name: 'Удаляемая', durationMinutes: 30, slotStepMinutes: 30, price: 500,
  });
  await db.setServiceMasters(fresh.id, [masterId]);
  assert.equal((await call('DELETE', `/api/services/${fresh.id}`)).status, 200);
  assert.equal(await db.getService(fresh.id), undefined);
  assert.equal((await call('DELETE', `/api/services/${fresh.id}`)).status, 404);

  const booked = await db.createService({
    name: 'Занятая', durationMinutes: 30, slotStepMinutes: 30, price: 500,
  });
  await db.upsertUser({ id: '996700000003', name: 'Клиент' });
  await db.createAppointment({
    userId: '996700000003', masterId, serviceId: booked.id,
    date: SATURDAY, startTime: '09:00', endTime: '09:30',
  });

  const res = await call('DELETE', `/api/services/${booked.id}`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'in_use');
  assert.equal(res.body.appointments, 1);
  assert.ok(await db.getService(booked.id), 'услуга должна остаться');

  await db.updateService(booked.id, {
    name: 'Занятая', durationMinutes: 30, slotStepMinutes: 30, price: 500, isActive: false,
  });
});

test('мастер без записей удаляется вместе с графиком, с записями — нет', async () => {
  const fresh = await call('POST', '/api/masters', { name: 'Временный' });
  await call('PUT', '/api/schedule/template', {
    masterId: fresh.body.id, weekday: 0, isWorking: true,
    intervals: [{ from: '10:00', to: '18:00', breaks: [] }],
  });

  assert.equal((await call('DELETE', `/api/masters/${fresh.body.id}`)).status, 200);
  assert.equal(await db.getMaster(fresh.body.id), undefined);
  assert.deepEqual(await db.getScheduleTemplate(fresh.body.id), [], 'график должен уйти вместе с мастером');
  assert.equal((await call('DELETE', `/api/masters/${fresh.body.id}`)).status, 404);

  // masterId уже участвует в записях из предыдущих тестов
  const res = await call('DELETE', `/api/masters/${masterId}`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'in_use');
  assert.ok(res.body.appointments > 0);
  assert.ok(await db.getMaster(masterId), 'мастер должен остаться');
});

test('выключатель бота: PUT переключает, GET отдаёт состояние', async () => {
  const off = await call('PUT', '/api/bot-state', { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.enabled, false);
  assert.equal((await call('GET', '/api/bot-state')).body.enabled, false);

  const bad = await call('PUT', '/api/bot-state', { enabled: 'нет' });
  assert.equal(bad.status, 400);

  // Back on, or every later run of the suite starts with a silent bot.
  assert.equal((await call('PUT', '/api/bot-state', { enabled: true })).body.enabled, true);
});
