// WhatsApp transport — connects as a linked device over the WhatsApp Web
// protocol (Baileys), no Meta Business account/App Review needed. Session
// lives in Postgres (see waAuth.js) so it survives redeploys; only needs a
// fresh QR scan if the linked device is actually logged out.
import { makeWASocket, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
import P from 'pino';
import QRCode from 'qrcode';
import { db } from './database.js';
import { useDbAuthState } from './waAuth.js';

const logger = P({ level: process.env.WHATSAPP_LOG_LEVEL || 'silent' });

let sock = null;
let latestQrDataUrl = null;
let connectionStatus = 'connecting'; // 'connecting' | 'open' | 'closed'

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
  db.logMessage({ phone: fromJid(toJid(to)), direction: 'out', text }).catch(() => {});
  if (process.env.WA_LOG_OUTBOUND) console.log(`[OUT → ${to}]\n${text}\n---`);
  if (!sock || connectionStatus !== 'open') {
    console.error('WhatsApp not connected, dropping outbound message to', to);
    return;
  }
  try {
    await sock.sendMessage(toJid(to), { text });
  } catch (err) {
    console.error('WhatsApp send error:', err);
  }
}

// onIncoming(phone, { text, profileName })
export async function connectWhatsApp(onIncoming) {
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

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQrDataUrl = await QRCode.toDataURL(qr);
      connectionStatus = 'closed';
      console.log('WhatsApp: scan QR at /admin/wa-qr to link the device');
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
        console.error('WhatsApp: device logged out, clearing session — rescan QR at /admin/wa-qr');
        await db.waAuthDelete('creds').catch(() => {});
        latestQrDataUrl = null;
      }

      console.log('WhatsApp: connection closed, reconnecting…', statusCode || '');
      connectWhatsApp(onIncoming).catch(err => console.error('WhatsApp reconnect failed:', err));
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const m of messages) {
      if (m.key.fromMe) continue;
      const jid = m.key.remoteJid;
      if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

      const text = m.message?.conversation || m.message?.extendedTextMessage?.text || null;
      const phone = fromJid(jid);

      try {
        await onIncoming(phone, { text, profileName: m.pushName || undefined });
      } catch (err) {
        console.error('Incoming message handling error:', err);
      }
    }
  });

  return sock;
}
