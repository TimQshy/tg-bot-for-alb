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
