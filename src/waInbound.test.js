// Which WhatsApp messages the bot answers, and the QR secret handling for
// pairing. Both broke live on 2026-09-29: one "Привет" got three main menus
// (an undecryptable stub plus two redeliveries), and new devices couldn't link
// because the QR kept a secret WhatsApp had retired. No socket, no database:
//
//   node --test src/waInbound.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeInboundFilter, rotateAdvSecret, withAdvSecret, HUMAN_ECHO_MAX_AGE_MS } from './waInbound.js';

const NOW = 1_790_000_000_000;
const CLIENT = '996707160409@s.whatsapp.net';

let seq = 0;
function msg({ id = `ID${++seq}`, jid = CLIENT, alt, fromMe = false, message = { conversation: 'Привет' }, ...rest } = {}) {
  return {
    key: { id, remoteJid: jid, remoteJidAlt: alt, fromMe },
    message,
    messageTimestamp: NOW / 1000,
    pushName: 'Айнура',
    ...rest,
  };
}

function filter(botSentIds = new Set()) {
  return makeInboundFilter({ botSentIds, now: () => NOW });
}

test('обычное сообщение клиента доходит до бота', () => {
  assert.deepEqual(filter()(msg()), {
    kind: 'client', phone: '996707160409', text: 'Привет', profileName: 'Айнура',
  });
});

test('текст с превью ссылки тоже читается', () => {
  const r = filter()(msg({ message: { extendedTextMessage: { text: 'вот адрес https://2gis.kg' } } }));
  assert.equal(r.text, 'вот адрес https://2gis.kg');
});

test('нерасшифрованная заглушка и два повтора — один ответ', () => {
  const classify = filter();
  const answered = [
    msg({ id: 'A1', message: null, messageStubType: 2 }), // failed decrypt
    msg({ id: 'A1' }),
    msg({ id: 'A1' }),
  ].map(classify).filter(Boolean);
  assert.equal(answered.length, 1);
  assert.equal(answered[0].text, 'Привет');
});

test('служебные сообщения и реакции не получают ответа', () => {
  const classify = filter();
  assert.equal(classify(msg({ message: { protocolMessage: { type: 0 } } })), null);
  assert.equal(classify(msg({ message: { reactionMessage: { text: '👍' } } })), null);
  assert.equal(classify(msg({ message: { senderKeyDistributionMessage: {} } })), null);
});

test('фото без подписи всё ещё доходит — бот отвечает меню, а не молчит', () => {
  const r = filter()(msg({ message: { imageMessage: {} } }));
  assert.equal(r.kind, 'client');
  assert.equal(r.text, null);
});

test('группы и статусы игнорируются', () => {
  const classify = filter();
  assert.equal(classify(msg({ jid: '120363000000@g.us' })), null);
  assert.equal(classify(msg({ jid: 'status@broadcast' })), null);
});

test('LID-контакт отвечает на реальный номер из remoteJidAlt', () => {
  const r = filter()(msg({ jid: '234888003350628@lid', alt: CLIENT }));
  assert.equal(r.phone, '996707160409');
});

test('своё эхо не считается ответом админа', () => {
  const sent = new Set(['OUT1']);
  assert.equal(filter(sent)(msg({ id: 'OUT1', fromMe: true })), null);
});

test('ответ админа с телефона включает takeover', () => {
  const r = filter()(msg({ fromMe: true, message: { conversation: 'Сейчас посмотрю' } }));
  assert.deepEqual(r, { kind: 'human', phone: '996707160409', text: 'Сейчас посмотрю' });
});

test('старое эхо после переподключения takeover не включает', () => {
  const r = filter()(msg({ fromMe: true, messageTimestamp: (NOW - HUMAN_ECHO_MAX_AGE_MS - 1000) / 1000 }));
  assert.equal(r, null);
});

test('пустое служебное эхо с телефона не глушит бота', () => {
  // Was "[takeover] admin replied to 234888003350628" with empty text.
  const r = filter()(msg({ fromMe: true, jid: '234888003350628@lid', message: { protocolMessage: {} } }));
  assert.equal(r, null);
});

test('companion_reg_refresh меняет ключ до привязки, а QR получает новый', () => {
  const creds = { advSecretKey: 'OLD' };
  assert.equal(rotateAdvSecret(creds), true);
  assert.notEqual(creds.advSecretKey, 'OLD');
  assert.equal(Buffer.from(creds.advSecretKey, 'base64').length, 32);

  const qr = '2@ref,noise,identity,OLD,platform';
  assert.equal(withAdvSecret(qr, creds.advSecretKey), `2@ref,noise,identity,${creds.advSecretKey},platform`);
});

test('у привязанного устройства ключ не трогаем — иначе сломается сессия', () => {
  const creds = { advSecretKey: 'KEEP', me: { id: '996551711706:3@s.whatsapp.net' } };
  assert.equal(rotateAdvSecret(creds), false);
  assert.equal(creds.advSecretKey, 'KEEP');
});
