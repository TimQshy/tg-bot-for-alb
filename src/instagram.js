// Instagram auto-responder. Someone comments on a post or writes in Direct,
// we send them the requested info. A comment is answered with a private
// reply (a DM addressed by comment id — the one way to message someone who
// never wrote to us first); if their DMs are closed that call fails, and we
// answer publicly under the comment instead.
//
// Deliberately separate from the WhatsApp booking flow: no FSM, no session,
// no reminders. Instagram's 24-hour messaging window makes proactive
// messages impossible anyway, so bookings stay on WhatsApp.
import crypto from 'crypto';
import express from 'express';
import { db } from './database.js';
import { botEnabled } from './botState.js';

const GRAPH = 'https://graph.instagram.com/v21.0';

const CLOSED_DM_TEXT =
  process.env.IG_CLOSED_DM_TEXT ||
  'У вас закрыт директ — напишите нам в сообщения, всё вышлем 🙂';

let cachedUsername = null;

async function token() {
  return (await db.getIgConfig('token')) || process.env.IG_TOKEN || '';
}

async function call(method, path, payload) {
  const options = {
    method,
    headers: { Authorization: `Bearer ${await token()}` },
  };
  if (payload) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(payload);
  }
  const res = await fetch(`${GRAPH}${path}`, options);
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

// Our own replies arrive back through the same webhook; ignoring them keeps
// the bot from answering itself.
async function myUsername() {
  if (cachedUsername !== null) return cachedUsername;
  const res = await call('GET', '/me?fields=username');
  cachedUsername = res.ok ? (JSON.parse(res.body).username || '') : '';
  return cachedUsername;
}

async function matchReply(text) {
  const lower = (text || '').trim().toLowerCase();
  for (const row of await db.getIgReplies()) {
    const keyword = row.keyword.trim().toLowerCase();
    if (!keyword) continue;
    if (keyword === '*' || lower.includes(keyword)) return row.reply;
  }
  return null;
}

async function handleComment(value) {
  // The panel's emergency switch covers Instagram too — checked before the
  // event is claimed, so nothing is silently marked as handled.
  if (!(await botEnabled())) return;
  const commentId = value.id;
  const text = value.text || '';
  const author = value.from?.username || '';
  if (!commentId) return;
  if (author && author === (await myUsername())) return;
  if (!(await db.claimIgEvent(`c:${commentId}`))) return;

  const reply = await matchReply(text);
  if (!reply) return;

  const dm = await call('POST', '/me/messages', {
    recipient: { comment_id: commentId },
    message: { text: reply },
  });
  if (dm.ok) {
    console.log(`[ig] private reply sent for comment ${commentId}`);
    return;
  }

  console.log(`[ig] private reply failed (${dm.status}): ${dm.body}`);
  const pub = await call('POST', `/${commentId}/replies`, { message: CLOSED_DM_TEXT });
  console.log(`[ig] public comment reply ${pub.ok ? 'sent' : `failed: ${pub.body}`}`);
}

async function handleMessage(event) {
  if (!(await botEnabled())) return;
  const message = event.message;
  const senderId = event.sender?.id;
  if (!message || message.is_echo || !senderId) return;
  const eventId = message.mid || `${senderId}:${event.timestamp}`;
  if (!(await db.claimIgEvent(`m:${eventId}`))) return;

  const reply = await matchReply(message.text || '');
  if (!reply) return;

  const res = await call('POST', '/me/messages', {
    recipient: { id: senderId },
    message: { text: reply },
  });
  console.log(`[ig] dm to ${senderId} ${res.ok ? 'sent' : `failed: ${res.body}`}`);
}

// Meta signs every delivery with the app secret. Needs the exact bytes that
// were sent, hence the rawBody captured by express.json's verify hook in
// webhook.js.
function signatureValid(req) {
  const secret = process.env.IG_APP_SECRET;
  if (!secret) return true; // enabled without a secret: warned about at startup
  const header = req.get('x-hub-signature-256') || '';
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.alloc(0)).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Only one salon uses Instagram; the rest run the same image with these
// variables unset, and for them the webhook route is never mounted at all.
export const instagramEnabled = Boolean(process.env.IG_VERIFY_TOKEN);

export const instagramRouter = express.Router();

instagramRouter.get('/', (req, res) => {
  const q = req.query;
  if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === process.env.IG_VERIFY_TOKEN) {
    return res.send(q['hub.challenge']);
  }
  res.sendStatus(403);
});

instagramRouter.post('/', (req, res) => {
  if (!signatureValid(req)) {
    console.warn('[ig] bad signature, dropping delivery');
    return res.sendStatus(403);
  }

  // Answer first: Meta retries for days on anything that isn't a prompt 200,
  // and the work below can outlive its timeout.
  res.sendStatus(200);

  for (const entry of req.body?.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === 'comments') {
        handleComment(change.value).catch(err => console.error('[ig] comment failed:', err));
      }
    }
    for (const event of entry.messaging || []) {
      handleMessage(event).catch(err => console.error('[ig] message failed:', err));
    }
  }
});

/**
 * Long-lived tokens last 60 days and must be refreshed while still valid.
 * Called monthly from the scheduler; the refreshed token replaces the stored
 * one, so IG_TOKEN in the environment is only ever the initial seed.
 */
export async function refreshIgToken() {
  if (!instagramEnabled) return;
  const current = await token();
  if (!current) return;
  const url =
    'https://graph.instagram.com/refresh_access_token' +
    `?grant_type=ig_refresh_token&access_token=${encodeURIComponent(current)}`;
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) {
    console.error('[ig] token refresh failed:', body);
    return;
  }
  const data = JSON.parse(body);
  await db.setIgConfig('token', data.access_token);
  console.log(`[ig] token refreshed, expires_in ${data.expires_in}`);
}
