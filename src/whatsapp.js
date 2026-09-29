// WhatsApp transport — connects as a linked device over the WhatsApp Web
// protocol (Baileys), no Meta Business account/App Review needed. Session
// lives in Postgres (see waAuth.js) so it survives redeploys; only needs a
// fresh QR scan if the linked device is actually logged out.
import { makeWASocket, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
import { randomBytes } from 'crypto';
import P from 'pino';
import QRCode from 'qrcode';
import { db } from './database.js';
import { useDbAuthState } from './waAuth.js';
import { isWalkIn } from './utils.js';

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
const SENT_IDS_MAX = 500;
// A fromMe echo older than this is history replay, not a live reply.
const HUMAN_ECHO_MAX_AGE_MS = 2 * 60 * 1000;

function rememberSentId(id) {
  botSentIds.add(id);
  if (botSentIds.size > SENT_IDS_MAX) {
    const oldest = botSentIds.values();
    for (let i = 0; i < SENT_IDS_MAX / 5; i++) botSentIds.delete(oldest.next().value);
  }
}

function toJid(phone) {
  return phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
}

function fromJid(jid) {
  return jid.split('@')[0];
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

  // Since late July 2026 WhatsApp sends companion_reg_refresh mid-pairing to
  // retire the adv secret advertised in the QR. Baileys rc14 only acks it,
  // so the QR keeps the retired secret and the phone answers "can't link new
  // devices right now" (Baileys issue #2737, unreleased fix in PR #2765).
  // Workaround until a release ships it: rotate the secret ourselves and
  // re-render the QR on screen with it. pair-success reads
  // state.creds.advSecretKey at verification time, so mutating it is enough.
  let lastQr = null;
  const withCurrentAdvSecret = (qr) => {
    // QR payload: ref,noiseKey,identityKey,advSecret,platformId
    const parts = qr.split(',');
    parts[parts.length - 2] = state.creds.advSecretKey;
    return parts.join(',');
  };
  sock.ws.on('CB:notification,type:companion_reg_refresh', async () => {
    if (state.creds.me) return; // already paired — the secret verifies the session
    state.creds.advSecretKey = randomBytes(32).toString('base64');
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
      const jid = m.key.remoteJid;
      if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

      // Privacy-mode contacts address by LID (an opaque per-account id), not
      // phone number — the real number.@s.whatsapp.net jid, when WhatsApp
      // shares it, is on remoteJidAlt. Prefer whichever side is the actual
      // phone-number jid so `phone` stays a real number everywhere else in
      // the app (admin panel, ADMIN_PHONES matching, booking confirmations).
      const pnJid = [jid, m.key.remoteJidAlt].find(j => j?.endsWith('@s.whatsapp.net'));
      const phone = fromJid(pnJid || jid);

      const text = m.message?.conversation || m.message?.extendedTextMessage?.text || null;

      if (m.key.fromMe) {
        // Our own send echoing back — ignore.
        if (botSentIds.has(m.key.id)) continue;
        // On reconnect WhatsApp can replay recent messages; an old echo must
        // not re-trigger a takeover long after the fact (and after a restart
        // botSentIds is empty, so even our own sends would look human).
        const ageMs = Date.now() - Number(m.messageTimestamp || 0) * 1000;
        if (ageMs > HUMAN_ECHO_MAX_AGE_MS) continue;

        try {
          await onHumanReply(phone, { text });
        } catch (err) {
          console.error('Human reply handling error:', err);
        }
        continue;
      }

      try {
        await onIncoming(phone, { text, profileName: m.pushName || undefined });
      } catch (err) {
        console.error('Incoming message handling error:', err);
      }
    }
  });

  return sock;
}
