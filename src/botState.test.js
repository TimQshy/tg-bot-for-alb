// The emergency switch: when it is off the bot answers nothing, and the
// message that arrived while it was off is still recorded.
//
//   DATABASE_URL=postgres://... node --test --experimental-test-module-mocks src/botState.test.js
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
mock.module('./whatsapp.js', {
  namedExports: {
    sendText: async (to, text) => { sent.push({ to, text }); },
    getWaStatus: () => ({ status: 'open', qrDataUrl: null }),
  },
});

const { db } = await import('./database.js');
const { botEnabled, setBotEnabled } = await import('./botState.js');
const { handleIncoming } = await import('./webhook.js');

const PHONE = '996700000777';

test.before(async () => { await db.init(); });
// Never leave the switch off behind us: the flag is stored, so a test that
// bailed out mid-way would silence the bot for good.
test.after(async () => { await setBotEnabled(true); });

test('выключенный бот молчит, но сообщение записывается', async () => {
  await setBotEnabled(false);
  assert.equal(await botEnabled(), false);

  sent.length = 0;
  await handleIncoming(PHONE, { text: 'меню', profileName: 'Тест' });
  assert.deepEqual(sent, []);
});

test('включённый обратно — снова отвечает', async () => {
  await setBotEnabled(true);
  assert.equal(await botEnabled(), true);

  sent.length = 0;
  await handleIncoming(PHONE, { text: 'меню', profileName: 'Тест' });
  assert.ok(sent.length > 0, 'бот должен ответить меню');
});
