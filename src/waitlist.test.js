// The queue's rules, with the database, WhatsApp and the schedule mocked:
//
//   node --test --experimental-test-module-mocks src/waitlist.test.js
//
// What matters here is who gets offered what. FIFO, one live offer at a time,
// and — the part that is easy to get wrong — a place in the queue that
// survives silence and refusal, while the window that was refused moves on to
// the next person.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const DATE = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
const MASTER_ID = 3;
const SERVICE = { id: 7, name: 'Маникюр', duration_minutes: 60, slot_step_minutes: 30 };

// One free window on the date, which is what every offer here is about.
let freeSlots = [{ start: '15:00', end: '16:00', status: 'free' }];
let taken = false;

let entries = [];
let offers = [];
let nextOfferId = 1;
const menus = [];
const texts = [];

const dateOf = v => String(v).slice(0, 10);

mock.module('./database.js', {
  namedExports: {
    db: {
      getSettings: async () => ({}),
      getService: async id => (id === SERVICE.id ? SERVICE : null),

      listWaitlist: async ({ date }) =>
        entries.filter(e => dateOf(e.desired_date) === date && e.status === 'waiting'),

      getWaitlistEntry: async id => entries.find(e => e.id === id),

      getLiveOffer: async (masterId, date) =>
        offers.find(o => o.status === 'sent' && dateOf(o.desired_date) === date &&
          entries.find(e => e.id === o.waitlist_id)?.master_id === masterId),

      // The real query's point, in JS: oldest waiting entry that has not been
      // asked about this exact window.
      getNextWaitingFor: async (masterId, date, start, end) =>
        entries.find(e =>
          e.master_id === masterId && dateOf(e.desired_date) === date && e.status === 'waiting' &&
          !String(e.user_id).startsWith('walkin:') &&
          !offers.some(o => o.waitlist_id === e.id && o.start_time === start && o.end_time === end)),

      createWaitlistOffer: async (waitlistId, { date, startTime, endTime }) => {
        const offer = {
          id: nextOfferId++, waitlist_id: waitlistId, desired_date: date,
          start_time: startTime, end_time: endTime, status: 'sent',
        };
        offers.push(offer);
        return offer;
      },

      getWaitlistOffer: async id => {
        const offer = offers.find(o => o.id === id);
        if (!offer) return undefined;
        const entry = entries.find(e => e.id === offer.waitlist_id);
        return {
          ...offer,
          user_id: entry.user_id, master_id: entry.master_id, service_id: entry.service_id,
          entry_status: entry.status, service_name: SERVICE.name, master_name: 'Айгуль',
        };
      },

      markWaitlistOfferStatus: async (id, status) => {
        const offer = offers.find(o => o.id === id);
        offer.status = status;
        return offer;
      },

      markWaitlistStatus: async (id, status) => {
        const entry = entries.find(e => e.id === id);
        entry.status = status;
        return entry;
      },

      updateWaitlistEntry: async (id, { serviceId, masterId, date }) => {
        const entry = entries.find(e => e.id === id);
        Object.assign(entry, { service_id: serviceId, master_id: masterId, desired_date: date });
        return entry;
      },
      expireStaleWaitlistOffers: async () => [],
      getWaitlistTargets: async () => [{ master_id: MASTER_ID, date: DATE }],
      isSlotAvailable: async () => !taken,
      createAppointment: async () => ({ id: 555 }),
      findActiveWaitlistFor: async () => undefined,
      addToWaitlist: async entry => entry,
    },
  },
});

mock.module('./whatsapp.js', {
  namedExports: { sendText: async (to, text) => { texts.push({ to, text }); } },
});

mock.module('./menu.js', {
  namedExports: { sendMenu: async (to, text, items) => { menus.push({ to, text, items }); } },
});

mock.module('./schedule.js', {
  namedExports: { getFreeSlotsForService: async () => freeSlots },
});

mock.module('./session.js', {
  namedExports: { getSession: () => null, clearSession: () => {}, setSession: () => {} },
});

mock.module('./booking.js', {
  namedExports: { sendAddress: async () => {}, sendMainMenu: async () => {} },
});

const waitlist = await import('./waitlist.js');

function seed() {
  entries = [
    { id: 1, user_id: '996700000001', master_id: MASTER_ID, service_id: SERVICE.id, desired_date: DATE, status: 'waiting', created_at: 1 },
    { id: 2, user_id: '996700000002', master_id: MASTER_ID, service_id: SERVICE.id, desired_date: DATE, status: 'waiting', created_at: 2 },
  ];
  offers = [];
  nextOfferId = 1;
  menus.length = 0;
  texts.length = 0;
  freeSlots = [{ start: '15:00', end: '16:00', status: 'free' }];
  taken = false;
  waitlist.clearWaitlistStateCache();
}

// notifyNext refuses to send outside working hours, which would make every
// test here depend on the clock. force skips that, exactly as the panel's
// "предложить сейчас" does.
const offerNow = () => waitlist.notifyNext(MASTER_ID, DATE, { force: true });

test('освободившееся окно уходит первому в очереди', async () => {
  seed();
  await offerNow();

  assert.equal(menus.length, 1);
  assert.equal(menus[0].to, '996700000001');
  assert.match(menus[0].text, /15:00/);
  assert.deepEqual(offers.map(o => [o.waitlist_id, o.status]), [[1, 'sent']]);
});

test('пока ждём ответа, второе предложение не уходит', async () => {
  seed();
  await offerNow();
  await offerNow();

  assert.equal(menus.length, 1);
  assert.equal(offers.length, 1);
});

test('слот увели у ждущего — очередь не висит до конца дня', async () => {
  seed();
  await offerNow();

  // Окно заняли мимо очереди, и на дате освободилось другое.
  taken = true;
  freeSlots = [{ start: '17:00', end: '18:00', status: 'free' }];
  await offerNow();

  assert.equal(offers[0].status, 'expired', 'предложение на занятое время закрыто');
  assert.equal(offers.length, 2);
  assert.equal(offers[1].start_time, '17:00');
});

test('отказ не выбрасывает из очереди, а окно уходит следующему', async () => {
  seed();
  await offerNow();
  await waitlist.handleOfferDecline('996700000001', String(offers[0].id));

  assert.equal(offers[0].status, 'declined');
  assert.equal(entries[0].status, 'waiting', 'отказавшийся остаётся в очереди');
  assert.equal(menus.at(-1).to, '996700000002', 'окно ушло следующему');
  assert.match(texts.at(-1).text, /остаётесь в очереди/i);
});

test('молчание до конца дня передаёт окно следующему, место сохраняется', async () => {
  seed();
  await offerNow();

  // Что делает ночной прогон: предложение протухло, но строка очереди цела.
  offers[0].status = 'expired';
  await offerNow();

  assert.equal(entries[0].status, 'waiting');
  assert.equal(menus.at(-1).to, '996700000002');
  assert.deepEqual(offers.map(o => o.waitlist_id), [1, 2]);
});

test('согласие создаёт запись и закрывает место в очереди', async () => {
  seed();
  await offerNow();
  await waitlist.handleOfferConfirm('996700000001', String(offers[0].id));

  assert.equal(offers[0].status, 'accepted');
  assert.equal(entries[0].status, 'booked');
  assert.match(texts.find(t => t.to === '996700000001').text, /#555/);
});

test('нет свободного времени — никому ничего не уходит', async () => {
  seed();
  freeSlots = [];
  await offerNow();

  assert.equal(menus.length, 0);
  assert.equal(offers.length, 0);
});

test('выключенный лист ожидания молчит', async () => {
  seed();
  mock.method(await import('./database.js').then(m => m.db), 'getSettings',
    async () => ({ waitlist_enabled: '0' }));
  waitlist.clearWaitlistStateCache();

  await offerNow();
  assert.equal(menus.length, 0);

  mock.restoreAll();
  waitlist.clearWaitlistStateCache();
});

test('клиент без телефона очередь не держит — предложения идут мимо него', async () => {
  seed();
  entries[0].user_id = 'walkin:abc';

  await offerNow();

  assert.equal(menus.length, 1);
  assert.equal(menus[0].to, '996700000002', 'окно ушло следующему, у кого есть чат');
  assert.equal((await waitlist.offerEntryNow(1)).reason, 'no_contact');
});

test('перенос на другую дату закрывает живое предложение', async () => {
  seed();
  await offerNow();

  const other = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
  await waitlist.updateEntry(1, { serviceId: SERVICE.id, masterId: MASTER_ID, date: other });

  assert.equal(offers[0].status, 'expired');
  assert.equal(dateOf(entries[0].desired_date), other);
  assert.equal(entries[0].status, 'waiting', 'место в очереди не трогаем');
});
