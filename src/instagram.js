// Instagram auto-responder. Someone comments on a post or writes in Direct,
// we send them the requested info. A comment is answered with a private
// reply (a DM addressed by comment id — the one way to message someone who
// never wrote to us first); if their DMs are closed that call fails, and we
// answer publicly under the comment instead.
//
// A comment gets exactly one message back. The private reply is the single
// exception Instagram makes for someone who never wrote to us and it does
// not open the 24-hour window — only their own reply does. So a multi-part
// answer reaches a commenter as its first part alone; the whole chain goes
// out only in Direct, once they have written.
//
// Deliberately separate from the WhatsApp booking flow: no FSM, no session,
// no reminders. Instagram's 24-hour messaging window makes proactive
// messages impossible anyway, so bookings stay on WhatsApp.
import crypto from 'crypto';
import express from 'express';
import { db } from './database.js';
import { botEnabled } from './botState.js';
import { splitText } from './utils.js';
import { answerQuestion } from './igAi.js';

const GRAPH = 'https://graph.instagram.com/v21.0';

// Instagram rejects any single direct message over this: "Length of param
// message[text] must be less than or equal to 2000". The panel splits long
// answers into a chain before they are saved; this is what it validates
// against and what the send path falls back to.
export const IG_MESSAGE_LIMIT = 2000;

// A closed (private) account cannot be reached in Direct at all — the
// private reply just fails. The only way left to say anything to that person
// is a public comment under their own comment, so that is what we do.
//
// The salon edits this text on the Instagram screen; the environment
// variable stays as the seed for an instance that has never touched it.
export const CLOSED_DM_KEY = 'closed_dm_text';

export const DEFAULT_CLOSED_DM_TEXT =
  process.env.IG_CLOSED_DM_TEXT ||
  'У вас закрытый аккаунт — мы не можем написать вам в директ. ' +
  'Напишите нам сами в сообщения, и мы всё вышлем 🙂';

export async function closedDmText() {
  return (await db.getIgConfig(CLOSED_DM_KEY)) || DEFAULT_CLOSED_DM_TEXT;
}

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

// Returns the chain of messages to send, in order, or null when nothing
// matched. Every message is re-checked against the 2000-character limit
// here too: rows saved before the chain existed are one long text, and the
// panel is not the only thing that can write to the table.
async function matchReply(text) {
  const lower = (text || '').trim().toLowerCase();
  for (const row of await db.getIgReplies()) {
    const keyword = row.keyword.trim().toLowerCase();
    if (!keyword) continue;
    if (keyword === '*' || lower.includes(keyword)) {
      return row.parts.flatMap(part => splitText(part, IG_MESSAGE_LIMIT));
    }
  }
  return null;
}

// Messages are sent one at a time and awaited in turn — Instagram keeps the
// order they arrive in, and firing them together is how a three-part answer
// shows up shuffled. Stops at the first failure: the rest of a chain whose
// opening message never arrived only makes the thread confusing.
async function sendChain(recipient, parts) {
  for (const [i, text] of parts.entries()) {
    const res = await call('POST', '/me/messages', { recipient, message: { text } });
    if (!res.ok) return { ok: false, first: i === 0, status: res.status, body: res.body };
  }
  return { ok: true };
}

// The AI's answer, shaped like a chain so both paths can treat it the same
// way. It is always one message — the model is asked for one and the answer
// is capped well under the 2000 Instagram allows.
async function askAi(userId, text, history) {
  const answer = await answerQuestion(userId, text, { history });
  if (!answer) return null;
  console.log(`[ig-ai] answered ${userId} (${answer.length} chars)`);
  return [answer];
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

  // The keyword list gets first refusal: it is free, instant and says
  // exactly what the owner wrote. Only a question it has no row for is
  // worth an AI call — and if the AI has nothing either, the bot stays
  // quiet, which is what it did before any of this existed.
  const parts = (await matchReply(text)) || await askAi(value.from?.id || commentId, text, false);
  if (!parts?.length) return;

  // Exactly one message reaches a commenter, and this is it. A private reply
  // is the single exception Instagram makes for someone who never wrote to
  // us; it does not open the 24-hour window, so message two comes back as
  // "This message is sent outside of allowed window" (code 10, subcode
  // 2534022). The rest of the chain is not attempted — it cannot succeed,
  // and the failed call would only bury the log.
  const dm = await sendChain({ comment_id: commentId }, parts.slice(0, 1));
  if (dm.ok) {
    const held = parts.length - 1;
    console.log(
      `[ig] private reply sent for comment ${commentId}` +
      (held ? ` — 1 msg, ${held} held back (one private reply per comment)` : '')
    );
    return;
  }

  console.log(`[ig] private reply failed (${dm.status}): ${dm.body}`);
  // Only a failed *first* message means we never reached them — a chain that
  // broke halfway has already been delivered in part, and telling that person
  // publicly that we cannot reach them would be nonsense.
  if (!dm.first) return;

  const pub = await call('POST', `/${commentId}/replies`, {
    message: (await closedDmText()).slice(0, IG_MESSAGE_LIMIT),
  });
  console.log(`[ig] public comment reply ${pub.ok ? 'sent' : `failed: ${pub.body}`}`);
}

async function handleMessage(event) {
  if (!(await botEnabled())) return;
  const message = event.message;
  const senderId = event.sender?.id;
  if (!message || message.is_echo || !senderId) return;
  const eventId = message.mid || `${senderId}:${event.timestamp}`;
  if (!(await db.claimIgEvent(`m:${eventId}`))) return;

  // In Direct the AI keeps the previous turns, because here the person can
  // actually follow up — «а сколько длится?» means nothing on its own.
  const parts = (await matchReply(message.text || '')) || await askAi(senderId, message.text, true);
  if (!parts?.length) return;

  const res = await sendChain({ id: senderId }, parts);
  console.log(`[ig] dm to ${senderId} ${res.ok ? `sent (${parts.length} msg)` : `failed: ${res.body}`}`);
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
