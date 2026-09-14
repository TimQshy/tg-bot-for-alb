import crypto from 'crypto';
import { db } from './database.js';

const API_VERSION = 'v21.0';

function apiUrl() {
  return `https://graph.facebook.com/${API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

function trunc(str, n) {
  if (!str) return str;
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

async function callApi(body) {
  const res = await fetch(apiUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });
  if (!res.ok) {
    console.error('WhatsApp API error:', res.status, await res.text().catch(() => ''));
  }
  return res;
}

export async function sendText(to, text) {
  db.logMessage({ phone: to, direction: 'out', text }).catch(() => {});
  return callApi({ to, type: 'text', text: { body: text, preview_url: false } });
}

// buttons: [{id, title}], max 3
export async function sendButtons(to, bodyText, buttons) {
  return callApi({
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map(b => ({
          type: 'reply',
          reply: { id: b.id, title: trunc(b.title, 20) },
        })),
      },
    },
  });
}

// sections: [{ title, rows: [{id, title, description}] }], max 10 rows total across all sections
export async function sendList(to, { bodyText, buttonText, sections, footerText }) {
  const cleanSections = sections.map(s => ({
    title: trunc(s.title, 24),
    rows: s.rows.map(r => ({
      id: r.id,
      title: trunc(r.title, 24),
      ...(r.description ? { description: trunc(r.description, 72) } : {}),
    })),
  }));

  return callApi({
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      ...(footerText ? { footer: { text: footerText } } : {}),
      action: { button: trunc(buttonText, 20), sections: cleanSections },
    },
  });
}

export function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.WHATSAPP_APP_SECRET; // required — checked in bot.js REQUIRED_ENV
  if (!signatureHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
