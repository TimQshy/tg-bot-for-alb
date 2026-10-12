// The "на ноябрь запись откроется 1 ноября" gate: when it holds, what it
// says, and how far ahead it lets a client book. The database is mocked.
//
//   node --test --experimental-test-module-mocks src/salonInfo.test.js
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let settings = {};
mock.module('./database.js', {
  namedExports: { db: { getSettings: async () => ({ ...settings }) } },
});

const { getBookingGate, getBookableDays, gateMessage } = await import('./salonInfo.js');

test('ворота на 1-е число читаются как открытие месяца', () => {
  assert.equal(gateMessage('2026-11-01'), 'Запись на ноябрь откроется 1 ноября');
  assert.equal(gateMessage('2026-11-15'), 'Запись на даты с 15 ноября откроется 15 ноября');
});

test('до даты открытия окно обрезано по последний день перед ней', async () => {
  settings = { booking_opens_on: '2026-11-01', booking_horizon_days: '60' };
  const gate = await getBookingGate('2026-10-12');
  assert.equal(gate.lastOpenDate, '2026-10-31');
  assert.equal(await getBookableDays('2026-10-12'), 19);
  assert.equal(await getBookableDays('2026-10-31'), 0);
});

test('в день открытия и после ворота сами пропадают', async () => {
  settings = { booking_opens_on: '2026-11-01', booking_horizon_days: '60' };
  assert.equal(await getBookingGate('2026-11-01'), null);
  assert.equal(await getBookableDays('2026-11-02'), 60);
});

test('без настройки или с мусором — ограничения нет', async () => {
  settings = { booking_horizon_days: '30' };
  assert.equal(await getBookingGate('2026-10-12'), null);
  settings = { booking_opens_on: 'ноябрь', booking_horizon_days: '30' };
  assert.equal(await getBookableDays('2026-10-12'), 30);
});

test('горизонт короче ворот — работает горизонт', async () => {
  settings = { booking_opens_on: '2026-12-01', booking_horizon_days: '14' };
  assert.equal(await getBookableDays('2026-10-12'), 14);
});
