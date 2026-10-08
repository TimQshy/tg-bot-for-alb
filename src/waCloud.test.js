// The WhatsApp Cloud API transport, with Meta and the database mocked — no
// network, no Postgres:
//
//   node --test --experimental-test-module-mocks src/waCloud.test.js
//
// What matters: outside the 24h window a message leaves as a template or not
// at all (Meta refuses free text there), and nothing Meta delivers twice or
// echoes back makes the bot answer twice or fall silent.
//
// The transport remembers who wrote when, so every test uses its own phone.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';

process.env.WA_PHONE_NUMBER_ID = '1000';
process.env.WA_ACCESS_TOKEN = 'token';
process.env.WA_APP_SECRET = 'app-secret';
process.env.WA_VERIFY_TOKEN = 'verify-me';
process.env.WA_TEMPLATE_LANG = 'ru';

const HOUR = 60 * 60 * 1000;
let lastInbound = null; // what db.lastInboundAt answers, for every phone

mock.module('./database.js', {
  namedExports: {
    db: {
      logMessage: async () => {},
      lastInboundAt: async () => lastInbound,
    },
  },
});

// Requests to Meta are recorded and answered by graphReply(); anything else
// (the local server in the webhook tests) goes through the real fetch.
const realFetch = globalThis.fetch;
const graphCalls = [];
let sentSeq = 0;
const okReply = () => ({ ok: true, body: { messages: [{ id: `wamid.SENT${++sentSeq}` }] } });
let graphReply = okReply;
globalThis.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://graph.facebook.com/')) return realFetch(url, opts);
  graphCalls.push({ url: String(url), method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
  const r = graphReply();
  return { ok: r.ok, json: async () => r.body };
};

const wa = await import('./waCloud.js');

const incoming = [];
const human = [];
let onIncomingHook = null;
await wa.connectWhatsApp(
  async (phone, msg) => {
    incoming.push({ phone, ...msg });
    if (onIncomingHook) await onIncomingHook(phone, msg);
  },
  async (phone, msg) => { human.push({ phone, ...msg }); },
);

function reset() {
  graphCalls.length = 0;
  incoming.length = 0;
  human.length = 0;
  lastInbound = null;
  graphReply = okReply;
  onIncomingHook = null;
}

test('при запуске проверяет доступ к номеру и считает себя подключённым', () => {
  assert.equal(graphCalls[0].url, 'https://graph.facebook.com/v26.0/1000');
  assert.equal(graphCalls[0].method, 'GET');
  assert.deepEqual(wa.getWaStatus(), { status: 'open', qrDataUrl: null, transport: 'cloud' });
});

test('клиент писал час назад — уходит обычный текст', async () => {
  reset();
  lastInbound = new Date(Date.now() - HOUR);
  await wa.sendText('996700000101', 'Здравствуйте!');

  assert.equal(graphCalls.length, 1);
  assert.equal(graphCalls[0].url, 'https://graph.facebook.com/v26.0/1000/messages');
  assert.deepEqual(graphCalls[0].body, {
    messaging_product: 'whatsapp', to: '996700000101', type: 'text', text: { body: 'Здравствуйте!' },
  });
});

test('вне 24 часов с шаблоном — уходит шаблон, параметры без переносов и пустот', async () => {
  reset();
  lastInbound = new Date(Date.now() - 25 * HOUR);
  await wa.sendText('996700000102', '⏰ Напоминание…', {
    template: { name: 'appt_reminder', params: ['завтра', 'Маникюр\nгель', '', 'Айгуль', '10:00 –   11:00'] },
  });

  assert.equal(graphCalls.length, 1);
  const { type, template } = graphCalls[0].body;
  assert.equal(type, 'template');
  assert.equal(template.name, 'appt_reminder');
  assert.deepEqual(template.language, { code: 'ru' });
  assert.deepEqual(
    template.components[0].parameters,
    ['завтра', 'Маникюр гель', '—', 'Айгуль', '10:00 – 11:00'].map(text => ({ type: 'text', text })),
  );
});

test('вне 24 часов без шаблона — Meta ничего не отправляем', async () => {
  reset();
  lastInbound = new Date(Date.now() - 25 * HOUR);
  await wa.sendText('996700000103', 'Адрес салона…');
  assert.equal(graphCalls.length, 0);
});

test('клиент никогда не писал и шаблона нет — тоже молчим', async () => {
  reset();
  await wa.sendText('996700000104', 'Привет');
  assert.equal(graphCalls.length, 0);
});

test('клиенту без телефона не отправляется ничего', async () => {
  reset();
  lastInbound = new Date();
  await wa.sendText('walkin:abc123', 'Вас записали');
  assert.equal(graphCalls.length, 0);
});

test('сеть упала — sendText не роняет разговор', async () => {
  reset();
  lastInbound = new Date();
  graphReply = () => { throw new TypeError('fetch failed'); };
  await assert.doesNotReject(wa.sendText('996700000105', 'Здравствуйте!'));
});

// Last among the sending tests: it leaves the status closed on purpose.
test('токен истёк — панель видит, что салон отключён', async () => {
  reset();
  lastInbound = new Date();
  graphReply = () => ({ ok: false, body: { error: { code: 190, message: 'Session has expired' } } });
  await wa.sendText('996700000106', 'Здравствуйте!');
  assert.equal(wa.getWaStatus().status, 'closed');
});

// ── Inbound ────────────────────────────────────────────────────────────────

function delivery(field, value, phoneNumberId = '1000') {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA1',
      changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, ...value } }],
    }],
  };
}

function clientMessage(from, id, message) {
  return delivery('messages', {
    contacts: [{ profile: { name: 'Айнура' }, wa_id: from }],
    messages: [{ from, id, timestamp: '1790000000', ...message }],
  });
}

const text = body => ({ type: 'text', text: { body } });

test('сообщение клиента доходит до бота с номером и именем', async () => {
  reset();
  await wa.handleDelivery(clientMessage('996700000201', 'wamid.IN1', text('Привет')));
  assert.deepEqual(incoming, [{ phone: '996700000201', text: 'Привет', profileName: 'Айнура' }]);
});

test('голосовое или фото доходит с пустым текстом — бот не молчит', async () => {
  reset();
  await wa.handleDelivery(clientMessage('996700000202', 'wamid.IN2', { type: 'audio', audio: { id: 'm1' } }));
  assert.deepEqual(incoming, [{ phone: '996700000202', text: '', profileName: 'Айнура' }]);
});

test('реакция ответа не получает', async () => {
  reset();
  await wa.handleDelivery(clientMessage('996700000203', 'wamid.IN3', { type: 'reaction', reaction: { emoji: '👍' } }));
  assert.equal(incoming.length, 0);
});

test('повторная доставка того же сообщения — один ответ', async () => {
  reset();
  const d = clientMessage('996700000204', 'wamid.IN4', text('Привет'));
  await wa.handleDelivery(d);
  await wa.handleDelivery(d);
  assert.equal(incoming.length, 1);
});

test('доставка для чужого номера салона отбрасывается', async () => {
  reset();
  const d = clientMessage('996700000205', 'wamid.IN5', text('Привет'));
  d.entry[0].changes[0].value.metadata.phone_number_id = '2000';
  await wa.handleDelivery(d);
  assert.equal(incoming.length, 0);
});

test('первый ответ новому клиенту уходит текстом, даже если база ещё не записала его сообщение', async () => {
  reset();
  lastInbound = null; // the insert in webhook.js hasn't landed yet
  onIncomingHook = phone => wa.sendText(phone, 'Здравствуйте! Выберите услугу');
  await wa.handleDelivery(clientMessage('996700000206', 'wamid.IN6', text('Привет')));

  assert.equal(graphCalls.length, 1);
  assert.equal(graphCalls[0].body.type, 'text');
});

test('ответ администратора из приложения Business передаётся как ручной ответ', async () => {
  reset();
  await wa.handleDelivery(delivery('smb_message_echoes', {
    message_echoes: [{ from: '996555000000', to: '996700000207', id: 'wamid.ECHO1', type: 'text', text: { body: 'Сейчас посмотрю' } }],
  }));
  assert.deepEqual(human, [{ phone: '996700000207', text: 'Сейчас посмотрю' }]);
});

test('эхо собственной отправки бота не считается ответом человека', async () => {
  reset();
  lastInbound = new Date();
  graphReply = () => ({ ok: true, body: { messages: [{ id: 'wamid.BOT1' }] } });
  await wa.sendText('996700000208', 'Ваша запись подтверждена');

  await wa.handleDelivery(delivery('smb_message_echoes', {
    message_echoes: [{ from: '996555000000', to: '996700000208', id: 'wamid.BOT1', type: 'text', text: { body: 'Ваша запись подтверждена' } }],
  }));
  assert.equal(human.length, 0);
});

// ── The HTTP surface Meta talks to ─────────────────────────────────────────

async function withServer(fn) {
  const app = express();
  // Same rawBody hook as webhook.js: the signature covers the exact bytes.
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/webhook/whatsapp', wa.waCloudRouter);
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/webhook/whatsapp`);
  } finally {
    server.close();
  }
}

const sign = raw => 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(raw).digest('hex');

test('проверка подписки Meta: верный токен — challenge, чужой — 403', async () => {
  await withServer(async url => {
    const ok = await realFetch(`${url}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '42');

    const bad = await realFetch(`${url}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`);
    assert.equal(bad.status, 403);
  });
});

test('доставка с неверной подписью — 403 и ничего не обработано', async () => {
  reset();
  await withServer(async url => {
    const raw = JSON.stringify(clientMessage('996700000209', 'wamid.IN9', text('Привет')));
    const res = await realFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=forged' },
      body: raw,
    });
    assert.equal(res.status, 403);
  });
  assert.equal(incoming.length, 0);
});

test('подписанная доставка — 200 сразу, сообщение обработано', async () => {
  reset();
  await withServer(async url => {
    const raw = JSON.stringify(clientMessage('996700000210', 'wamid.IN10', text('Привет')));
    const res = await realFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(raw) },
      body: raw,
    });
    assert.equal(res.status, 200);
  });
  // Processing runs after the 200 — give it a tick to land.
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(incoming.map(m => m.phone), ['996700000210']);
});

// ── Status follows what Meta actually answers ─────────────────────────────

test('отправка прошла — панель снова видит подключение, даже после сбоя при запуске', async () => {
  reset();
  lastInbound = new Date();
  graphReply = () => ({ ok: false, body: { error: { code: 190, message: 'Session has expired' } } });
  await wa.sendText('996700000301', 'Здравствуйте!');
  assert.equal(wa.getWaStatus().status, 'closed');

  graphReply = okReply;
  await wa.sendText('996700000301', 'Здравствуйте!');
  assert.equal(wa.getWaStatus().status, 'open');
});

test('доступ к аккаунту WhatsApp отозван — панель видит отключение', async () => {
  reset();
  lastInbound = new Date();
  for (const error of [{ code: 10 }, { code: 200 }, { code: 100, error_subcode: 33 }]) {
    graphReply = okReply;
    await wa.sendText('996700000302', 'Здравствуйте!');
    assert.equal(wa.getWaStatus().status, 'open');

    graphReply = () => ({ ok: false, body: { error: { message: 'Permission denied', ...error } } });
    await wa.sendText('996700000302', 'Здравствуйте!');
    assert.equal(wa.getWaStatus().status, 'closed', JSON.stringify(error));
  }
});

test('голосовое или фото от администратора из приложения тоже ставит бота на паузу', async () => {
  reset();
  await wa.handleDelivery(delivery('smb_message_echoes', {
    message_echoes: [
      { from: '996555000000', to: '996700000303', id: 'wamid.ECHO_AUDIO', type: 'audio', audio: { id: 'm2' } },
      { from: '996555000000', to: '996700000303', id: 'wamid.ECHO_REACT', type: 'reaction', reaction: { emoji: '👍' } },
    ],
  }));
  assert.deepEqual(human, [{ phone: '996700000303', text: null }]);
});
