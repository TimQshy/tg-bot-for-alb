// Manual dev helper: sends a signed fake WhatsApp Cloud API webhook POST to a
// locally running bot (npm start), so you can drive the booking flow without
// a real WhatsApp Business number. Not part of the app — safe to delete.
//
// Usage:
//   WHATSAPP_APP_SECRET=devsecret123 node test-webhook.mjs <phone> text "меню"
//   WHATSAPP_APP_SECRET=devsecret123 node test-webhook.mjs <phone> button book
//   WHATSAPP_APP_SECRET=devsecret123 node test-webhook.mjs <phone> list "svc:1"
//
// button/list value = the id you'd get from tapping a WhatsApp button/list row
// (see src/booking.js for the ids: book, my_bookings, svc:<id>, mst:<id>,
// dt:<date>, "slot:<start>|<end>" (quote it — has a pipe), confirm, cancel, ...)
import crypto from 'crypto';

const SECRET = process.env.WHATSAPP_APP_SECRET;
const URL = process.env.WEBHOOK_URL || 'http://localhost:3000/webhook';
const PHONE = process.argv[2];
const KIND = process.argv[3];
const arg = process.argv[4] || '';

if (!SECRET || !PHONE || !KIND) {
  console.error('usage: WHATSAPP_APP_SECRET=... node test-webhook.mjs <phone> text|button|list <value>');
  process.exit(1);
}

function envelope(message) {
  return {
    entry: [{
      changes: [{
        value: {
          contacts: [{ profile: { name: 'Тест Клиент' } }],
          messages: [message],
        },
      }],
    }],
  };
}

let message;
if (KIND === 'text') {
  message = { from: PHONE, type: 'text', text: { body: arg } };
} else if (KIND === 'button') {
  message = { from: PHONE, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: arg } } };
} else if (KIND === 'list') {
  message = { from: PHONE, type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: arg } } };
} else {
  console.error('kind must be: text | button | list');
  process.exit(1);
}

const body = JSON.stringify(envelope(message));
const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');

const res = await fetch(URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig },
  body,
});
console.log(res.status, await res.text());
