// WhatsApp transport over Meta's official Cloud API — for a salon whose
// number can't risk the unofficial client in waBaileys.js. Picked per salon
// with WA_TRANSPORT=cloud (see whatsapp.js) and exports the same sendText /
// connectWhatsApp / getWaStatus.
//
// Meta only takes free text within 24h of the client's last message. Past
// that a send needs an approved template (WHATSAPP_CLOUD.md lists them); a
// send without one is dropped with a warning rather than refused by Meta.
import { db } from './database.js';
import { isWalkIn, rememberId } from './utils.js';

const GRAPH = 'https://graph.facebook.com/v26.0';
const WINDOW_MS = 24 * 60 * 60 * 1000;

let connectionStatus = 'connecting'; // 'connecting' | 'open' | 'closed'
let handlers = { onIncoming: async () => {}, onHumanReply: async () => {} };

// Ids of messages we sent. Coexistence echoes what staff send from the
// Business app; should Meta ever echo an API send too, the bot must not take
// its own message for a human taking over the chat.
const botSentIds = new Set();
// When each client last wrote, as this process saw it. webhook.js logs an
// inbound message without awaiting the insert, so the bot's first reply to a
// new client can query the database before the row is there.
const lastInboundSeen = new Map();

// Meta refuses a template parameter that is empty or holds a newline, a tab
// or more than four spaces in a row.
function templateParam(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim() || '—';
}

async function graph(path, body) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  return { ok: res.ok, body: await res.json().catch(() => ({})) };
}

async function inWindow(phone) {
  const at = lastInboundSeen.get(phone) ?? await db.lastInboundAt(phone).catch(() => null);
  return Boolean(at) && Date.now() - new Date(at).getTime() < WINDOW_MS;
}

function logSendError(to, error, template) {
  const code = error?.code;
  const what = template ? ` (template ${template.name})` : '';
  // 190: the token was revoked or expired — nothing will send until it's replaced.
  if (code === 190) connectionStatus = 'closed';
  if (code === 131047) {
    console.warn(`WhatsApp Cloud: Meta says ${to} is outside the 24h window, our check said inside${what}`);
    return;
  }
  console.error(`WhatsApp Cloud: send to ${to} failed${what}: ${code} ${error?.message}`);
}

export async function sendText(to, text, { template } = {}) {
  // A walk-in has no chat to write into — same rule as waBaileys.js.
  if (isWalkIn(to)) return;
  db.logMessage({ phone: to, direction: 'out', text }).catch(() => {});
  if (process.env.WA_LOG_OUTBOUND) console.log(`[OUT → ${to}]\n${text}\n---`);

  let message;
  if (await inWindow(to)) {
    message = { type: 'text', text: { body: text } };
  } else if (template) {
    message = {
      type: 'template',
      template: {
        name: template.name,
        language: { code: process.env.WA_TEMPLATE_LANG },
        components: [{
          type: 'body',
          parameters: template.params.map(p => ({ type: 'text', text: templateParam(p) })),
        }],
      },
    };
  } else {
    console.warn(`WARN: outside 24h window, no template — dropped message to ${to}`);
    return;
  }

  try {
    const { ok, body } = await graph(`${process.env.WA_PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp', to, ...message,
    });
    if (!ok) return logSendError(to, body.error, message.type === 'template' ? template : null);
    const id = body.messages?.[0]?.id;
    if (id) rememberId(botSentIds, id);
  } catch (err) {
    console.error(`WhatsApp Cloud: send to ${to} failed:`, err);
  }
}

// onIncoming(phone, { text, profileName }) — a client wrote to us.
// onHumanReply(phone, { text }) — staff answered that client from the
// WhatsApp Business app (coexistence echoes, see the webhook below).
export async function connectWhatsApp(onIncoming, onHumanReply = async () => {}) {
  handlers = { onIncoming, onHumanReply };
  try {
    const { ok, body } = await graph(process.env.WA_PHONE_NUMBER_ID);
    connectionStatus = ok ? 'open' : 'closed';
    if (ok) console.log('WhatsApp Cloud: connected');
    else console.error('WhatsApp Cloud: credentials check failed:', body.error?.code, body.error?.message);
  } catch (err) {
    connectionStatus = 'closed';
    console.error('WhatsApp Cloud: credentials check failed:', err);
  }
}

export function getWaStatus() {
  return { status: connectionStatus, qrDataUrl: null, transport: 'cloud' };
}
