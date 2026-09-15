import express from 'express';
import { db } from './database.js';
import { verifySignature, sendText } from './whatsapp.js';
import { getSession, clearSession } from './session.js';
import * as booking from './booking.js';
import * as waitlist from './waitlist.js';
import { adminRouter } from './admin.js';
import { askAI } from './ai.js';

const GREETING_WORDS = ['старт', 'start', 'меню', 'menu', 'привет', 'hi', 'hello'];

export const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get('/', (_req, res) => res.send('OK'));

app.get('/privacy', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>Политика конфиденциальности</title></head>
<body style="font-family: sans-serif; max-width: 640px; margin: 40px auto; line-height: 1.5;">
<h1>Политика конфиденциальности</h1>
<p>Этот WhatsApp-бот используется для записи клиентов салона красоты на услуги.</p>
<p>Мы собираем только данные, необходимые для записи: имя, номер телефона, выбранные услуги и время визита. Эти данные используются исключительно для обработки записи и напоминаний и не передаются третьим лицам.</p>
<p>По вопросам удаления своих данных — напишите боту в WhatsApp.</p>
</body>
</html>`);
});

app.use('/admin', adminRouter);

// ── Webhook verification (Meta calls this once when you save the webhook URL) ─
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ── Inbound messages ─────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const signature = req.get('x-hub-signature-256');
  if (!verifySignature(req.rawBody, signature)) {
    return res.sendStatus(401);
  }

  res.sendStatus(200); // ack immediately, WhatsApp retries on timeout/non-2xx

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return; // status update or other event, nothing to do

    const phone = message.from;
    const profileName = value?.contacts?.[0]?.profile?.name;

    let text = null;
    let replyId = null;

    if (message.type === 'text') {
      text = message.text?.body || '';
    } else if (message.type === 'interactive') {
      const interactive = message.interactive;
      if (interactive.type === 'button_reply') replyId = interactive.button_reply.id;
      else if (interactive.type === 'list_reply') replyId = interactive.list_reply.id;
    }

    await handleIncoming(phone, { text, replyId, profileName });
  } catch (err) {
    console.error('Webhook handling error:', err);
  }
});

async function handleIncoming(phone, { text, replyId, profileName }) {
  await db.upsertUser({ id: phone, name: profileName || phone });
  db.logMessage({ phone, direction: 'in', text: text || replyId }).catch(() => {});

  if (replyId?.startsWith('admin:cancel:')) {
    return booking.handleAdminCancel(phone, replyId.split(':')[2]);
  }

  if (replyId === 'book') return booking.start(phone);
  if (replyId === 'my_bookings') return booking.showMyBookings(phone);
  if (replyId === 'main_menu') {
    clearSession(phone);
    return booking.sendMainMenu(phone);
  }
  if (replyId?.startsWith('svc:')) return booking.chooseService(phone, replyId.slice(4));
  if (replyId?.startsWith('mst:')) return booking.chooseMaster(phone, replyId.slice(4));
  if (replyId?.startsWith('dt:')) return booking.chooseDate(phone, replyId.slice(3));
  if (replyId === 'more_slots') return booking.nextSlotsPage(phone);
  if (replyId?.startsWith('slot:')) return booking.chooseSlot(phone, replyId.slice(5));
  if (replyId === 'confirm') return booking.confirm(phone);
  if (replyId === 'cancel') return booking.cancelFlow(phone);
  if (replyId?.startsWith('cancel_appt:')) return booking.startCancelAppt(phone, replyId.split(':')[1]);
  if (replyId?.startsWith('confirm_cancel:')) return booking.confirmCancelAppt(phone, replyId.split(':')[1]);
  if (replyId === 'waitlist_join') return waitlist.handleJoin(phone);
  if (replyId?.startsWith('waitlist:confirm:')) return waitlist.handleOfferConfirm(phone, replyId.split(':')[2]);
  if (replyId?.startsWith('waitlist:decline:')) return waitlist.handleOfferDecline(phone, replyId.split(':')[2]);

  const lower = (text || '').trim().toLowerCase();
  if (GREETING_WORDS.includes(lower)) {
    clearSession(phone);
    return booking.sendMainMenu(phone);
  }

  // Free text while mid-flow: nudge back to buttons, don't hand it to the AI
  // (would conflict with the booking FSM reading session state).
  const session = getSession(phone);
  if (session) {
    return booking.sendMainMenu(phone, 'Пожалуйста, используйте кнопки выше 👆 Или напишите "меню".');
  }

  // Free text, no active session: try the FAQ AI consultant before giving up.
  if (text) {
    const result = await askAI(text);
    if (result) {
      console.log(`[ai] answered via ${result.model} for ${phone}`);
      return sendText(phone, result.answer);
    }
  }
  return booking.sendMainMenu(phone);
}
