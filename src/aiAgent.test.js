// The agent loop and its tools, with DeepSeek, the database and the booking
// writes all mocked — so this runs without a database and without network:
//
//   node --test --experimental-test-module-mocks src/aiAgent.test.js
//
// What's worth pinning down here is the part the model can't be trusted with:
// a time it invents must not become an appointment, and a foreign booking id
// must not be cancellable.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.DEEPSEEK_API_KEY = 'test-key';

const SERVICE = { id: 7, name: 'Маникюр', price: '1500.00', duration_minutes: 60, slot_step_minutes: 30 };
const MASTER = { id: 3, name: 'Айгуль', description: null };
const CLIENT = '996700111222';
const DATE = '2026-09-19';

// Free 10:00 and 15:00, busy 11:00 — what check_availability should report
// and what create_booking must hold the model to.
const SLOTS = [
  { start: '10:00', end: '11:00', status: 'free' },
  { start: '11:00', end: '12:00', status: 'busy' },
  { start: '15:00', end: '16:00', status: 'free' },
];

const created = [];
const cancelled = [];
const rescheduled = [];

// Scripted DeepSeek turns: each call to chat() shifts one off.
let replies = [];
const sent = [];

mock.module('./ai.js', {
  namedExports: {
    chat: async ({ messages }) => {
      sent.push(messages.at(-1));
      const next = replies.shift();
      if (!next) throw new Error('no scripted reply left');
      return next;
    },
  },
});

mock.module('./database.js', {
  namedExports: {
    db: {
      getActiveServices: async () => [SERVICE],
      getActiveMasters: async () => [MASTER],
      getMastersForService: async () => [MASTER],
      getService: async id => (id === SERVICE.id ? SERVICE : null),
      getMaster: async id => (id === MASTER.id ? MASTER : null),
      getUser: async () => ({ id: CLIENT, name: 'Айнура' }),
      setUserNameIfUnknown: async () => {},
      getUserAppointments: async () => [],
      getAppointmentById: async id =>
        id === 42
          ? {
              id: 42, user_id: CLIENT, status: 'confirmed', master_id: MASTER.id,
              service_id: SERVICE.id, appointment_date: DATE, start_time: '10:00:00',
              end_time: '11:00:00', service_name: SERVICE.name, master_name: MASTER.name,
              user_name: 'Айнура', price: SERVICE.price,
            }
          : { id, user_id: 'someone-else', status: 'confirmed' },
    },
  },
});

mock.module('./schedule.js', {
  namedExports: {
    getFreeSlotsForService: async (_service, _masterId, _date, opts = {}) =>
      opts.includeBusy ? SLOTS : SLOTS.filter(s => s.status === 'free'),
  },
});

mock.module('./booking.js', {
  namedExports: {
    createAppointmentFor: async (phone, data) => {
      created.push({ phone, ...data });
      return { id: 101 };
    },
    cancelAppointmentFor: async (phone, id) => {
      cancelled.push({ phone, id });
      return true;
    },
    rescheduleAppointmentFor: async (phone, id, data) => {
      rescheduled.push({ phone, id, ...data });
      return { id };
    },
  },
});

const { runAgent, clearHistory } = await import('./aiAgent.js');

const toolCall = (name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const answer = content => ({ role: 'assistant', content });

// The tool result the model saw, as the loop handed it over.
const lastToolResult = () => JSON.parse(sent.filter(m => m.role === 'tool').at(-1).content);

test.beforeEach(() => {
  replies = [];
  sent.length = 0;
  created.length = 0;
  cancelled.length = 0;
  rescheduled.length = 0;
  clearHistory(CLIENT);
});

test('свободное и занятое время уходит в модель раздельно', async () => {
  replies = [
    toolCall('check_availability', { date: DATE, service_id: SERVICE.id }),
    answer('Свободно 10:00 и 15:00, 11:00 уже занято.'),
  ];

  const reply = await runAgent(CLIENT, 'что свободно в субботу?');
  assert.match(reply, /10:00/);

  const result = lastToolResult();
  assert.deepEqual(result.masters[0].free, ['10:00', '15:00']);
  assert.deepEqual(result.masters[0].busy, ['11:00']);
});

test('запись создаётся на реальный слот, конец считается по длительности', async () => {
  replies = [
    toolCall('create_booking', {
      service_id: SERVICE.id, master_id: MASTER.id, date: DATE, start_time: '15:00',
    }),
    answer('Записала вас на 15:00, номер #101.'),
  ];

  const reply = await runAgent(CLIENT, 'давайте на 15:00');
  assert.match(reply, /#101/);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0], {
    phone: CLIENT, serviceId: SERVICE.id, masterId: MASTER.id,
    date: DATE, startTime: '15:00', endTime: '16:00',
  });
});

test('придуманное время не становится записью', async () => {
  replies = [
    toolCall('create_booking', {
      service_id: SERVICE.id, master_id: MASTER.id, date: DATE, start_time: '11:00',
    }),
    answer('11:00 занято, есть 10:00 и 15:00.'),
  ];

  await runAgent(CLIENT, 'запишите на 11');
  assert.equal(created.length, 0);

  const result = lastToolResult();
  assert.match(result.error, /11:00/);
  assert.deepEqual(result.free, ['10:00', '15:00']);
});

test('прошедшая дата отклоняется', async () => {
  replies = [
    toolCall('check_availability', { date: '2020-01-01', service_id: SERVICE.id }),
    answer('Эта дата уже прошла.'),
  ];

  await runAgent(CLIENT, 'запишите на 1 января 2020');
  assert.match(lastToolResult().error, /прошла/);
});

test('чужую запись отменить нельзя', async () => {
  replies = [
    toolCall('cancel_booking', { appointment_id: 999 }),
    answer('Такой записи у вас нет.'),
  ];

  await runAgent(CLIENT, 'отмени запись 999');
  assert.equal(cancelled.length, 0);
  assert.match(lastToolResult().error, /нет/);
});

test('своя запись отменяется', async () => {
  replies = [
    toolCall('cancel_booking', { appointment_id: 42 }),
    answer('Отменила запись #42.'),
  ];

  await runAgent(CLIENT, 'отмени, не смогу прийти');
  assert.deepEqual(cancelled, [{ phone: CLIENT, id: 42 }]);
});

test('перенос идёт на свободный слот и исключает саму запись', async () => {
  replies = [
    toolCall('reschedule_booking', { appointment_id: 42, date: DATE, start_time: '15:00' }),
    answer('Перенесла на 15:00.'),
  ];

  await runAgent(CLIENT, 'перенесите на 15');
  assert.deepEqual(rescheduled, [
    { phone: CLIENT, id: 42, date: DATE, startTime: '15:00', endTime: '16:00' },
  ]);
});

test('модель, зациклившаяся на инструментах, не отвечает пустотой', async () => {
  replies = Array.from({ length: 8 }, () =>
    toolCall('check_availability', { date: DATE, service_id: SERVICE.id })
  );

  assert.equal(await runAgent(CLIENT, 'а когда?'), null);
});
