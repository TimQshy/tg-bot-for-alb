// Express app: health check, privacy page, and the /admin panel. WhatsApp
// messages no longer arrive here — Baileys delivers them in-process (see
// whatsapp.js connectWhatsApp), which calls handleIncoming() directly.
import express from 'express';
import { db } from './database.js';
import { sendText } from './whatsapp.js';
import { getLastMenu, resolveMenuReply, clearLastMenu } from './menu.js';
import { getSession, clearSession } from './session.js';
import * as booking from './booking.js';
import * as waitlist from './waitlist.js';
import { adminRouter } from './admin.js';
import { instagramRouter, instagramEnabled } from './instagram.js';
import { askAI } from './ai.js';

const GREETING_WORDS = ['старт', 'start', 'меню', 'menu', 'привет', 'hi', 'hello'];
const ADMIN_PHONES = () => (process.env.ADMIN_PHONES || '').split(',').map(s => s.trim()).filter(Boolean);

export const app = express();

// rawBody is kept so instagram.js can check Meta's X-Hub-Signature-256,
// which is computed over the exact bytes received.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/', (_req, res) => res.send('OK'));

// Instagram comment/DM auto-replies, mounted only for the salon that has
// IG_VERIFY_TOKEN set. Behind nginx the public URL is
// https://<domain>/s/<slug>/webhook/instagram — that is what goes into the
// Meta app's Callback URL.
if (instagramEnabled) {
  app.use('/webhook/instagram', instagramRouter);
  if (!process.env.IG_APP_SECRET) {
    console.warn('IG_APP_SECRET is not set — incoming Instagram webhooks are not verified');
  }
  console.log('Instagram auto-replies enabled');
}

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

// In production nginx strips the /s/<slug> prefix before proxying, but the
// panel is written against it — mounting both keeps the app runnable without
// nginx in front. The slug in the path is never trusted: requireAuth checks
// the token against this process's own SALON_SLUG, not against the URL.
app.use('/admin', adminRouter);
app.use('/s/:slug/admin', adminRouter);

// ── Inbound messages — called by whatsapp.js for every incoming chat message ─
export async function handleIncoming(phone, { text, profileName }) {
  await db.upsertUser({ id: phone, name: profileName || phone });
  db.logMessage({ phone, direction: 'in', text }).catch(() => {});

  const trimmed = (text || '').trim();

  // Admin action that doesn't depend on a numbered menu still being valid
  // (a new-booking notification can arrive while the admin is mid-menu
  // elsewhere) — see booking.js confirm().
  const cancelMatch = ADMIN_PHONES().includes(phone) && /^cancel\s+(\d+)$/i.exec(trimmed);
  if (cancelMatch) {
    return booking.handleAdminCancel(phone, cancelMatch[1]);
  }

  const replyId = resolveMenuReply(phone, text);

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

  const lower = trimmed.toLowerCase();
  if (GREETING_WORDS.includes(lower)) {
    clearSession(phone);
    return booking.sendMainMenu(phone);
  }

  const pendingMenu = getLastMenu(phone);
  const session = getSession(phone);

  // A menu is showing but the reply didn't resolve to one of its numbers —
  // nudge back rather than silently falling through to the FSM/AI below.
  if (pendingMenu && trimmed) {
    return sendText(phone, `Ответьте цифрой из списка выше (1–${pendingMenu.length}). Или напишите "меню".`);
  }

  // Free text mid-FSM-step with no menu recorded (shouldn't normally happen
  // since every FSM step shows a menu, but session TTL/restart edge cases
  // can leave this stale) — nudge back to the menu instead of the FSM
  // silently misreading the text as something else.
  if (session) {
    clearLastMenu(phone);
    return booking.sendMainMenu(phone, 'Начнём заново. Чем можем помочь?');
  }

  // Free text, no active session/menu: try the FAQ AI consultant before
  // giving up.
  if (text) {
    const result = await askAI(text);
    if (result) {
      console.log(`[ai] answered via ${result.model} for ${phone}`);
      return sendText(phone, result.answer);
    }
  }
  return booking.sendMainMenu(phone);
}
