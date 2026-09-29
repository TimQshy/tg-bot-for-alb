// WhatsApp transport — connects as a linked device over the WhatsApp Web
// protocol (Baileys), no Meta Business account/App Review needed. Session
// lives in Postgres (see waAuth.js) so it survives redeploys; only needs a
// fresh QR scan if the linked device is actually logged out.
import { makeWASocket, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
import P from 'pino';
import QRCode from 'qrcode';
import { db } from './database.js';
import { useDbAuthState } from './waAuth.js';
import { isWalkIn } from './utils.js';
import { makeInboundFilter, rememberId, fromJid, rotateAdvSecret, withAdvSecret } from './waInbound.js';

const logger = P({ level: process.env.WHATSAPP_LOG_LEVEL || 'silent' });

let sock = null;
let latestQrDataUrl = null;
let connectionStatus = 'connecting'; // 'connecting' | 'open' | 'closed'

// Ids of messages this process sent. Everything the linked account sends
// echoes back through messages.upsert with fromMe=true — the bot's own
// sends included — so this set is what tells "the admin typed this on their
// phone" apart from "we just sent this ourselves". Bounded: only the last
// few hundred matter, an echo arrives within seconds of the send.
const botSentIds = new Set();
// Shared across reconnects: a redelivered copy can arrive on the new socket.
const classifyInbound = makeInboundFilter({ botSentIds });

function rememberSentId(id) {
  rememberId(botSentIds, id);
}

function toJid(phone) {
  return phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
}


export function getWaStatus() {
  return { status: connectionStatus, qrDataUrl: connectionStatus === 'open' ? null : latestQrDataUrl };
}

export async function sendText(to, text) {
  // A walk-in the salon entered without a phone has no chat to write into.
  // Dropped here rather than at every call site, so reminders, cancellations
  // and confirmations all stay silent for them without each one remembering.
  if (isWalkIn(to)) return;
  db.logMessage({ phone: fromJid(toJid(to)), direction: 'out', text }).catch(() => {});
  if (process.env.WA_LOG_OUTBOUND) console.log(`[OUT → ${to}]\n${text}\n---`);
  if (!sock || connectionStatus !== 'open') {
    console.error('WhatsApp not connected, dropping outbound message to', to);
    return;
  }
  try {
    const sent = await sock.sendMessage(toJid(to), { text });
    if (sent?.key?.id) rememberSentId(sent.key.id);
  } catch (err) {
    console.error('WhatsApp send error:', err);
  }
}

// onIncoming(phone, { text, profileName }) — a client wrote to us.
// onHumanReply(phone, { text })  — someone answered that client by hand from
// one of the account's own devices (see the fromMe branch below).
export async function connectWhatsApp(onIncoming, onHumanReply = async () => {}) {
  const { state, saveCreds } = await useDbAuthState();
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // WhatsApp retiring the QR's adv secret mid-pairing — see rotateAdvSecret.
  let lastQr = null;
  const withCurrentAdvSecret = (qr) => withAdvSecret(qr, state.creds.advSecretKey);
  sock.ws.on('CB:notification,type:companion_reg_refresh', async () => {
    if (!rotateAdvSecret(state.creds)) return;
    await saveCreds();
    console.log('WhatsApp: companion_reg_refresh, rotated adv secret and re-rendered the QR');
    if (lastQr) latestQrDataUrl = await QRCode.toDataURL(withCurrentAdvSecret(lastQr));
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      lastQr = qr;
      latestQrDataUrl = await QRCode.toDataURL(withCurrentAdvSecret(qr));
      connectionStatus = 'closed';
      console.log('WhatsApp: scan QR in the admin panel to link the device');
    }

    if (connection === 'open') {
      connectionStatus = 'open';
      latestQrDataUrl = null;
      console.log('WhatsApp: connected');
    }

    if (connection === 'close') {
      connectionStatus = 'closed';
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        // Why WhatsApp dropped us (device_removed, conflict, …) lives in the
        // error's data/message, not the status code — keep it for diagnosis.
        const err = lastDisconnect?.error;
        console.error('WhatsApp: logout reason:', err?.message, JSON.stringify(err?.data ?? null));
        console.error('WhatsApp: device logged out, clearing session — rescan QR in the admin panel');
        await db.waAuthDelete('creds').catch(() => {});
        latestQrDataUrl = null;
      }

      console.log('WhatsApp: connection closed, reconnecting…', statusCode || '');
      connectWhatsApp(onIncoming, onHumanReply).catch(err => console.error('WhatsApp reconnect failed:', err));
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const m of messages) {
      const inbound = classifyInbound(m);
      if (!inbound) continue;

      if (inbound.kind === 'human') {
        try {
          await onHumanReply(inbound.phone, { text: inbound.text });
        } catch (err) {
          console.error('Human reply handling error:', err);
        }
        continue;
      }

      try {
        await onIncoming(inbound.phone, { text: inbound.text, profileName: inbound.profileName });
      } catch (err) {
        console.error('Incoming message handling error:', err);
      }
    }
  });

  return sock;
}
