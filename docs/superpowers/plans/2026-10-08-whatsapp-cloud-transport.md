# WhatsApp Cloud API Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each salon run its WhatsApp on either Baileys (today) or Meta's official Cloud API, chosen with `WA_TRANSPORT` in its env file.

**Architecture:** `src/whatsapp.js` becomes a switch that re-exports `sendText` / `connectWhatsApp` / `getWaStatus` from either `src/waBaileys.js` (today's code, moved) or the new `src/waCloud.js`. Cloud API inbound arrives on an Express router mounted at `/webhook/whatsapp`. Messages sent outside Meta's 24h window go as approved templates, which the out-of-window call sites name through a new optional `{ template }` argument.

**Tech Stack:** Node 20 ESM, Express 4, `pg`, built-in `fetch`, `node --test` with `--experimental-test-module-mocks`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-08-whatsapp-cloud-transport-design.md`

## Global Constraints

- `WA_TRANSPORT` is `baileys` (default when unset) or `cloud`. Existing env files must work unchanged.
- Cloud API env vars: `WA_PHONE_NUMBER_ID`, `WA_ACCESS_TOKEN`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `WA_TEMPLATE_LANG` (`ru`). With `WA_TRANSPORT=cloud` the process exits at startup listing any that are missing.
- Graph API base URL: `https://graph.facebook.com/v26.0` (latest as of 2026-07-29).
- 24h window = 24 × 60 × 60 × 1000 ms since the client's last inbound message.
- Outside the window: template if the call site gave one, otherwise no request and the log line `WARN: outside 24h window, no template — dropped message to <phone>`.
- Template parameters: whitespace runs collapsed to one space, trimmed, empty → `—`.
- The 11 template names, exactly: `appt_reminder`, `appt_confirm`, `appt_cancelled_by_salon`, `appt_moved_by_salon`, `appt_created_by_salon`, `waitlist_offer`, `admin_new_booking`, `admin_client_cancelled`, `admin_booking_moved`, `admin_waitlist_booking`, `admin_unconfirmed`.
- Menus stay numbered text. No native buttons.
- No new npm dependencies. Comments match the surrounding style: explain why, not what. Test names are in Russian, like the existing tests.
- Commit messages follow the repo convention: `type: описание по-русски`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A new client's very first message.** `webhook.js:81` logs inbound messages without awaiting the insert, so the bot's first reply can query `messages` before the row exists. That reply must still go as plain text, not be dropped as "outside the window". Pinned in Task 3 (`первый ответ новому клиенту…`).
2. **Meta echoing the bot's own API send** through `smb_message_echoes`. It must not count as a human takeover, or the bot would mute itself after every reply. Pinned in Task 3 (`эхо собственной отправки…`).
3. **Graph API unreachable** (DNS, timeout, `fetch` throws). `sendText` must resolve, not throw, because booking flows `await` it mid-conversation. Pinned in Task 2 (`сеть упала…`).
4. **Access token revoked or expired mid-run.** The admin panel must show the salon as disconnected. Pinned in Task 2 (`токен истёк…`).
5. **A voice note or photo from a client.** It must still reach the bot, with empty text, exactly as Baileys passes it. A silent bot looks broken. Pinned in Task 3 (`голосовое…`).

---

### Task 1: Shared Meta helpers in `utils.js`

Moves two helpers so `waCloud.js` can use them without loading Instagram or Baileys code: the bounded id set (`rememberId`, now in `waInbound.js`) and Meta's webhook signature check (`signatureValid`, now private in `instagram.js`).

**Files:**
- Modify: `src/utils.js` (add `import crypto`, `rememberId`, `metaSignatureValid`)
- Modify: `src/waInbound.js:8-21` (remove `IDS_MAX` and `rememberId`, import from utils)
- Modify: `src/whatsapp.js:11` (import `rememberId` from utils)
- Modify: `src/instagram.js:16,178-190,207` (drop the local `signatureValid` and `crypto` import)
- Test: `src/utils.test.js`

**Interfaces:**
- Produces: `rememberId(set: Set, id: any): void` keeps the set at no more than 500 entries. `metaSignatureValid(req: { rawBody?: Buffer, get(name): string|undefined }, secret: string|undefined): boolean` returns true when `secret` is falsy.

- [ ] **Step 1: Write the failing tests**

In `src/utils.test.js`, change the import line and add the `crypto` import:

```js
import crypto from 'crypto';
import { splitText, formatPrice, rememberId, metaSignatureValid } from './utils.js';
```

Append at the end of the file:

```js
test('подпись Meta: верная проходит, чужая и пустая — нет', () => {
  const rawBody = Buffer.from('{"entry":[]}');
  const signed = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(rawBody).digest('hex');
  const req = header => ({ rawBody, get: () => header });

  assert.equal(metaSignatureValid(req(signed), 's3cret'), true);
  assert.equal(metaSignatureValid(req(signed), 'other-secret'), false);
  assert.equal(metaSignatureValid(req(''), 's3cret'), false);
  assert.equal(metaSignatureValid(req(undefined), 's3cret'), false);
  // Instagram's behaviour today: no secret configured → accepted, warned at startup.
  assert.equal(metaSignatureValid(req(''), undefined), true);
});

test('rememberId не даёт набору расти бесконечно и помнит свежие id', () => {
  const set = new Set();
  for (let i = 0; i < 1000; i++) rememberId(set, i);
  assert.ok(set.size <= 500, `size ${set.size}`);
  assert.ok(set.has(999));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/utils.test.js`
Expected: FAIL with `SyntaxError: The requested module './utils.js' does not provide an export named 'metaSignatureValid'` (or `rememberId`).

- [ ] **Step 3: Add the helpers to `src/utils.js`**

At the very top of `src/utils.js`, before `const DAYS_SHORT`:

```js
import crypto from 'crypto';
```

At the end of `src/utils.js`:

```js
// Bounded set of recently seen message ids: a redelivery or an echo arrives
// within seconds, so only the last few hundred matter.
const IDS_MAX = 500;
export function rememberId(set, id) {
  set.add(id);
  if (set.size > IDS_MAX) {
    const oldest = set.values();
    for (let i = 0; i < IDS_MAX / 5; i++) set.delete(oldest.next().value);
  }
}

// Meta signs every webhook delivery — Instagram and WhatsApp Cloud alike —
// with the app secret, over the exact bytes it sent, hence the rawBody kept
// by express.json's verify hook in webhook.js. No secret configured means
// accepted: callers warn about that at startup.
export function metaSignatureValid(req, secret) {
  if (!secret) return true;
  const header = req.get('x-hub-signature-256') || '';
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.alloc(0)).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Point the old locations at the new helpers**

In `src/waInbound.js`, delete lines 8 (`const IDS_MAX = 500;`) and 13–21 (the comment block above `rememberId` and the function itself). Add to the imports at the top:

```js
import { rememberId } from './utils.js';
```

Then run `grep -n "IDS_MAX\|rememberId" src/waInbound.js`. Expected: only the import line and the call `rememberId(seen, m.key.id);`.

In `src/whatsapp.js` line 11, change

```js
import { makeInboundFilter, rememberId, fromJid, rotateAdvSecret, withAdvSecret } from './waInbound.js';
```

to

```js
import { makeInboundFilter, fromJid, rotateAdvSecret, withAdvSecret } from './waInbound.js';
```

and change line 10 from `import { isWalkIn } from './utils.js';` to:

```js
import { isWalkIn, rememberId } from './utils.js';
```

In `src/instagram.js`, delete line 16 (`import crypto from 'crypto';`) and the whole `signatureValid` function with its comment (lines 178–190). Change line 20 from `import { splitText } from './utils.js';` to:

```js
import { splitText, metaSignatureValid } from './utils.js';
```

and in the POST handler change `if (!signatureValid(req)) {` to:

```js
  if (!metaSignatureValid(req, process.env.IG_APP_SECRET)) {
```

Run `grep -n "crypto\|signatureValid" src/instagram.js`. Expected: only the `metaSignatureValid` import and its one call.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test src/utils.test.js src/waInbound.test.js && node --test --experimental-test-module-mocks src/igAi.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/utils.js src/utils.test.js src/waInbound.js src/whatsapp.js src/instagram.js
git commit -m "refactor: rememberId и проверка подписи Meta переехали в utils

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `waCloud.js` sending: window, templates, status

**Files:**
- Create: `src/waCloud.js`
- Create: `src/waCloud.test.js`
- Modify: `src/database.js` (add `lastInboundAt` after `logMessage`, around line 807)

**Interfaces:**
- Consumes: `rememberId`, `isWalkIn` from `src/utils.js` (Task 1). `db.logMessage({ phone, direction, text })`.
- Produces:
  - `db.lastInboundAt(phone: string): Promise<Date|null>`.
  - From `src/waCloud.js`: `sendText(to: string, text: string, opts?: { template?: { name: string, params: any[] } }): Promise<void>`, `connectWhatsApp(onIncoming, onHumanReply?): Promise<void>`, `getWaStatus(): { status: 'connecting'|'open'|'closed', qrDataUrl: null, transport: 'cloud' }`.
  - Module-private state Task 3 writes into: `lastInboundSeen: Map<phone, ms>`, `botSentIds: Set`, `handlers: { onIncoming, onHumanReply }`.

- [ ] **Step 1: Add `lastInboundAt` to `src/database.js`**

Right after the `logMessage` method (ends around line 807), add:

```js
  // When the client last wrote — WhatsApp Cloud API only lets free text
  // through within 24h of it (see waCloud.js). null: they never wrote.
  async lastInboundAt(phone) {
    const { rows } = await pool.query(
      `SELECT MAX(created_at) AS at FROM messages WHERE phone=$1 AND direction='in'`,
      [phone]
    );
    return rows[0].at;
  },
```

(No test of its own: it's a single `MAX` over the existing `idx_messages_phone`, and Task 2's tests mock it.)

- [ ] **Step 2: Write the failing tests**

Create `src/waCloud.test.js`:

```js
// The WhatsApp Cloud API transport, with Meta and the database mocked — no
// network, no Postgres:
//
//   node --test --experimental-test-module-mocks src/waCloud.test.js
//
// What matters: outside the 24h window a message leaves as a template or not
// at all (Meta refuses free text there), and nothing Meta delivers twice or
// echoes back makes the bot answer twice or fall silent.
//
// The transport remembers who wrote when, so every test uses its own phone.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';

process.env.WA_PHONE_NUMBER_ID = '1000';
process.env.WA_ACCESS_TOKEN = 'token';
process.env.WA_APP_SECRET = 'app-secret';
process.env.WA_VERIFY_TOKEN = 'verify-me';
process.env.WA_TEMPLATE_LANG = 'ru';

const HOUR = 60 * 60 * 1000;
let lastInbound = null; // what db.lastInboundAt answers, for every phone

mock.module('./database.js', {
  namedExports: {
    db: {
      logMessage: async () => {},
      lastInboundAt: async () => lastInbound,
    },
  },
});

// Requests to Meta are recorded and answered by graphReply(); anything else
// (the local server in the webhook tests) goes through the real fetch.
const realFetch = globalThis.fetch;
const graphCalls = [];
let sentSeq = 0;
const okReply = () => ({ ok: true, body: { messages: [{ id: `wamid.SENT${++sentSeq}` }] } });
let graphReply = okReply;
globalThis.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://graph.facebook.com/')) return realFetch(url, opts);
  graphCalls.push({ url: String(url), method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
  const r = graphReply();
  return { ok: r.ok, json: async () => r.body };
};

const wa = await import('./waCloud.js');

const incoming = [];
const human = [];
let onIncomingHook = null;
await wa.connectWhatsApp(
  async (phone, msg) => {
    incoming.push({ phone, ...msg });
    if (onIncomingHook) await onIncomingHook(phone, msg);
  },
  async (phone, msg) => { human.push({ phone, ...msg }); },
);

function reset() {
  graphCalls.length = 0;
  incoming.length = 0;
  human.length = 0;
  lastInbound = null;
  graphReply = okReply;
  onIncomingHook = null;
}

test('при запуске проверяет доступ к номеру и считает себя подключённым', () => {
  assert.equal(graphCalls[0].url, 'https://graph.facebook.com/v26.0/1000');
  assert.equal(graphCalls[0].method, 'GET');
  assert.deepEqual(wa.getWaStatus(), { status: 'open', qrDataUrl: null, transport: 'cloud' });
});

test('клиент писал час назад — уходит обычный текст', async () => {
  reset();
  lastInbound = new Date(Date.now() - HOUR);
  await wa.sendText('996700000101', 'Здравствуйте!');

  assert.equal(graphCalls.length, 1);
  assert.equal(graphCalls[0].url, 'https://graph.facebook.com/v26.0/1000/messages');
  assert.deepEqual(graphCalls[0].body, {
    messaging_product: 'whatsapp', to: '996700000101', type: 'text', text: { body: 'Здравствуйте!' },
  });
});

test('вне 24 часов с шаблоном — уходит шаблон, параметры без переносов и пустот', async () => {
  reset();
  lastInbound = new Date(Date.now() - 25 * HOUR);
  await wa.sendText('996700000102', '⏰ Напоминание…', {
    template: { name: 'appt_reminder', params: ['завтра', 'Маникюр\nгель', '', 'Айгуль', '10:00 –   11:00'] },
  });

  assert.equal(graphCalls.length, 1);
  const { type, template } = graphCalls[0].body;
  assert.equal(type, 'template');
  assert.equal(template.name, 'appt_reminder');
  assert.deepEqual(template.language, { code: 'ru' });
  assert.deepEqual(
    template.components[0].parameters,
    ['завтра', 'Маникюр гель', '—', 'Айгуль', '10:00 – 11:00'].map(text => ({ type: 'text', text })),
  );
});

test('вне 24 часов без шаблона — Meta ничего не отправляем', async () => {
  reset();
  lastInbound = new Date(Date.now() - 25 * HOUR);
  await wa.sendText('996700000103', 'Адрес салона…');
  assert.equal(graphCalls.length, 0);
});

test('клиент никогда не писал и шаблона нет — тоже молчим', async () => {
  reset();
  await wa.sendText('996700000104', 'Привет');
  assert.equal(graphCalls.length, 0);
});

test('клиенту без телефона не отправляется ничего', async () => {
  reset();
  lastInbound = new Date();
  await wa.sendText('walkin:abc123', 'Вас записали');
  assert.equal(graphCalls.length, 0);
});

test('сеть упала — sendText не роняет разговор', async () => {
  reset();
  lastInbound = new Date();
  graphReply = () => { throw new TypeError('fetch failed'); };
  await assert.doesNotReject(wa.sendText('996700000105', 'Здравствуйте!'));
});

// Last among the sending tests: it leaves the status closed on purpose.
test('токен истёк — панель видит, что салон отключён', async () => {
  reset();
  lastInbound = new Date();
  graphReply = () => ({ ok: false, body: { error: { code: 190, message: 'Session has expired' } } });
  await wa.sendText('996700000106', 'Здравствуйте!');
  assert.equal(wa.getWaStatus().status, 'closed');
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test --experimental-test-module-mocks src/waCloud.test.js`
Expected: FAIL with `Cannot find module '…/src/waCloud.js'`.

- [ ] **Step 4: Create `src/waCloud.js`**

```js
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test --experimental-test-module-mocks src/waCloud.test.js`
Expected: PASS, 8 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/waCloud.js src/waCloud.test.js src/database.js
git commit -m "feat: отправка через WhatsApp Cloud API — окно 24 часа и шаблоны

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `waCloud.js` incoming: webhook router

**Files:**
- Modify: `src/waCloud.js` (add the `express` import, `metaSignatureValid` import, `seenIds`, `handleDelivery`, `waCloudRouter`)
- Test: `src/waCloud.test.js` (append)

**Interfaces:**
- Consumes: `metaSignatureValid(req, secret)` from Task 1. From Task 2: `handlers`, `lastInboundSeen`, `botSentIds`, `sendText`.
- Produces: `handleDelivery(body: object): Promise<void>` and `waCloudRouter: express.Router` (`GET /` is Meta's verify handshake, `POST /` is deliveries). Task 4 mounts the router.

- [ ] **Step 1: Write the failing tests**

Append to `src/waCloud.test.js`:

```js
// ── Inbound ────────────────────────────────────────────────────────────────

function delivery(field, value, phoneNumberId = '1000') {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA1',
      changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, ...value } }],
    }],
  };
}

function clientMessage(from, id, message) {
  return delivery('messages', {
    contacts: [{ profile: { name: 'Айнура' }, wa_id: from }],
    messages: [{ from, id, timestamp: '1790000000', ...message }],
  });
}

const text = body => ({ type: 'text', text: { body } });

test('сообщение клиента доходит до бота с номером и именем', async () => {
  reset();
  await wa.handleDelivery(clientMessage('996700000201', 'wamid.IN1', text('Привет')));
  assert.deepEqual(incoming, [{ phone: '996700000201', text: 'Привет', profileName: 'Айнура' }]);
});

test('голосовое или фото доходит с пустым текстом — бот не молчит', async () => {
  reset();
  await wa.handleDelivery(clientMessage('996700000202', 'wamid.IN2', { type: 'audio', audio: { id: 'm1' } }));
  assert.deepEqual(incoming, [{ phone: '996700000202', text: '', profileName: 'Айнура' }]);
});

test('реакция ответа не получает', async () => {
  reset();
  await wa.handleDelivery(clientMessage('996700000203', 'wamid.IN3', { type: 'reaction', reaction: { emoji: '👍' } }));
  assert.equal(incoming.length, 0);
});

test('повторная доставка того же сообщения — один ответ', async () => {
  reset();
  const d = clientMessage('996700000204', 'wamid.IN4', text('Привет'));
  await wa.handleDelivery(d);
  await wa.handleDelivery(d);
  assert.equal(incoming.length, 1);
});

test('доставка для чужого номера салона отбрасывается', async () => {
  reset();
  const d = clientMessage('996700000205', 'wamid.IN5', text('Привет'));
  d.entry[0].changes[0].value.metadata.phone_number_id = '2000';
  await wa.handleDelivery(d);
  assert.equal(incoming.length, 0);
});

test('первый ответ новому клиенту уходит текстом, даже если база ещё не записала его сообщение', async () => {
  reset();
  lastInbound = null; // the insert in webhook.js hasn't landed yet
  onIncomingHook = phone => wa.sendText(phone, 'Здравствуйте! Выберите услугу');
  await wa.handleDelivery(clientMessage('996700000206', 'wamid.IN6', text('Привет')));

  assert.equal(graphCalls.length, 1);
  assert.equal(graphCalls[0].body.type, 'text');
});

test('ответ администратора из приложения Business передаётся как ручной ответ', async () => {
  reset();
  await wa.handleDelivery(delivery('smb_message_echoes', {
    message_echoes: [{ from: '996555000000', to: '996700000207', id: 'wamid.ECHO1', type: 'text', text: { body: 'Сейчас посмотрю' } }],
  }));
  assert.deepEqual(human, [{ phone: '996700000207', text: 'Сейчас посмотрю' }]);
});

test('эхо собственной отправки бота не считается ответом человека', async () => {
  reset();
  lastInbound = new Date();
  graphReply = () => ({ ok: true, body: { messages: [{ id: 'wamid.BOT1' }] } });
  await wa.sendText('996700000208', 'Ваша запись подтверждена');

  await wa.handleDelivery(delivery('smb_message_echoes', {
    message_echoes: [{ from: '996555000000', to: '996700000208', id: 'wamid.BOT1', type: 'text', text: { body: 'Ваша запись подтверждена' } }],
  }));
  assert.equal(human.length, 0);
});

// ── The HTTP surface Meta talks to ─────────────────────────────────────────

async function withServer(fn) {
  const app = express();
  // Same rawBody hook as webhook.js: the signature covers the exact bytes.
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/webhook/whatsapp', wa.waCloudRouter);
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/webhook/whatsapp`);
  } finally {
    server.close();
  }
}

const sign = raw => 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(raw).digest('hex');

test('проверка подписки Meta: верный токен — challenge, чужой — 403', async () => {
  await withServer(async url => {
    const ok = await realFetch(`${url}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '42');

    const bad = await realFetch(`${url}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`);
    assert.equal(bad.status, 403);
  });
});

test('доставка с неверной подписью — 403 и ничего не обработано', async () => {
  reset();
  await withServer(async url => {
    const raw = JSON.stringify(clientMessage('996700000209', 'wamid.IN9', text('Привет')));
    const res = await realFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=forged' },
      body: raw,
    });
    assert.equal(res.status, 403);
  });
  assert.equal(incoming.length, 0);
});

test('подписанная доставка — 200 сразу, сообщение обработано', async () => {
  reset();
  await withServer(async url => {
    const raw = JSON.stringify(clientMessage('996700000210', 'wamid.IN10', text('Привет')));
    const res = await realFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(raw) },
      body: raw,
    });
    assert.equal(res.status, 200);
  });
  // Processing runs after the 200 — give it a tick to land.
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(incoming.map(m => m.phone), ['996700000210']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --experimental-test-module-mocks src/waCloud.test.js`
Expected: the 8 Task 2 tests pass; the new ones FAIL with `wa.handleDelivery is not a function` and `Cannot read properties of undefined` (no `waCloudRouter`).

- [ ] **Step 3: Implement the inbound half in `src/waCloud.js`**

Replace the two import lines at the top with:

```js
import express from 'express';
import { db } from './database.js';
import { isWalkIn, rememberId, metaSignatureValid } from './utils.js';
```

Right after `const lastInboundSeen = new Map();` add:

```js
// Ids Meta already delivered — it retries anything it isn't sure we got.
const seenIds = new Set();
```

At the end of the file add:

```js
// ── Inbound — Meta's webhook ───────────────────────────────────────────────

async function safely(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`${label} handling error:`, err);
  }
}

async function handleMessages(value) {
  for (const s of value.statuses || []) {
    if (s.status === 'failed') {
      console.error(`WhatsApp Cloud: message to ${s.recipient_id} failed:`, JSON.stringify(s.errors ?? null));
    }
  }

  const profileName = value.contacts?.[0]?.profile?.name || null;
  for (const m of value.messages || []) {
    if (!m.id || seenIds.has(m.id) || m.type === 'reaction') continue;
    rememberId(seenIds, m.id);
    lastInboundSeen.set(m.from, Date.now());
    // Photos, voice notes and the like still reach the bot, with no text —
    // exactly as Baileys passes them, so it answers rather than going quiet.
    const text = m.type === 'text' ? m.text?.body || '' : '';
    await safely('Incoming message', () => handlers.onIncoming(m.from, { text, profileName }));
  }
}

async function handleEchoes(value) {
  for (const e of value.message_echoes || []) {
    if (!e.id || seenIds.has(e.id) || botSentIds.has(e.id) || e.type !== 'text') continue;
    rememberId(seenIds, e.id);
    await safely('Human reply', () => handlers.onHumanReply(e.to, { text: e.text?.body || '' }));
  }
}

export async function handleDelivery(body) {
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      // One Meta app can serve several salons; only this one's number is ours.
      if (value.metadata?.phone_number_id !== process.env.WA_PHONE_NUMBER_ID) continue;
      if (change.field === 'messages') await handleMessages(value);
      else if (change.field === 'smb_message_echoes') await handleEchoes(value);
    }
  }
}

export const waCloudRouter = express.Router();

waCloudRouter.get('/', (req, res) => {
  const q = req.query;
  if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === process.env.WA_VERIFY_TOKEN) {
    return res.send(q['hub.challenge']);
  }
  res.sendStatus(403);
});

waCloudRouter.post('/', (req, res) => {
  if (!metaSignatureValid(req, process.env.WA_APP_SECRET)) {
    console.warn('WhatsApp Cloud: bad signature, dropping delivery');
    return res.sendStatus(403);
  }
  // Answer first: Meta retries anything that isn't a prompt 200.
  res.sendStatus(200);
  handleDelivery(req.body).catch(err => console.error('WhatsApp Cloud webhook error:', err));
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --experimental-test-module-mocks src/waCloud.test.js`
Expected: PASS, 19 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/waCloud.js src/waCloud.test.js
git commit -m "feat: входящие WhatsApp Cloud API — вебхук, дубли, ответы из приложения

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wire it in: the switch, webhook, env check, panel status

**Files:**
- Move: `src/whatsapp.js` → `src/waBaileys.js` (with `git mv`)
- Create: `src/whatsapp.js` (the switch)
- Modify: `src/waBaileys.js` (`getWaStatus` adds `transport: 'baileys'`)
- Modify: `src/webhook.js:1-6` (header comment, import, mount the router)
- Modify: `src/bot.js:7` (Cloud API env check)
- Modify: `src/admin.js:55-58` (`/api/wa-status` returns `transport`)
- Modify: `public/admin-dashboard.html` (`loadWaStatus`, around line 1235)
- Modify: `src/botState.test.js:9-14` (mock gains `webhookRouter`)
- Modify: `.env.example`

**Interfaces:**
- Consumes: `sendText`, `connectWhatsApp`, `getWaStatus`, `waCloudRouter` from `src/waCloud.js` (Tasks 2–3).
- Produces: `src/whatsapp.js` exports `sendText`, `connectWhatsApp`, `getWaStatus`, `webhookRouter` (`express.Router` or `null`). Every existing importer keeps working unchanged.

- [ ] **Step 1: Move the Baileys transport and add `transport` to its status**

```bash
git mv src/whatsapp.js src/waBaileys.js
```

In `src/waBaileys.js`, change `getWaStatus`:

```js
export function getWaStatus() {
  return {
    status: connectionStatus,
    qrDataUrl: connectionStatus === 'open' ? null : latestQrDataUrl,
    transport: 'baileys',
  };
}
```

- [ ] **Step 2: Create the switch `src/whatsapp.js`**

```js
// The salon's WhatsApp transport: Baileys (waBaileys.js — a linked device
// paired by QR) unless WA_TRANSPORT=cloud picks Meta's official Cloud API
// (waCloud.js). Both export the same three functions, and the rest of the
// app only ever imports from here.
const cloud = process.env.WA_TRANSPORT === 'cloud';
const impl = cloud ? await import('./waCloud.js') : await import('./waBaileys.js');

export const { sendText, connectWhatsApp, getWaStatus } = impl;
// Meta delivers Cloud API messages over HTTP; Baileys has no webhook.
export const webhookRouter = cloud ? impl.waCloudRouter : null;
```

(`bot.js` imports `dotenv/config` first, so `WA_TRANSPORT` is already set by the time this module runs.)

- [ ] **Step 3: Mount the router in `src/webhook.js`**

Replace the header comment (lines 1–3) with:

```js
// Express app: health check, privacy page, the /admin panel and Meta's
// webhooks. On Baileys, WhatsApp messages never arrive here — whatsapp.js
// delivers them in-process to handleIncoming(). On the Cloud API they come
// through /webhook/whatsapp (waCloud.js), which calls the same function.
```

Change line 6 from `import { sendText } from './whatsapp.js';` to:

```js
import { sendText, webhookRouter } from './whatsapp.js';
```

Right after the Instagram `if (instagramEnabled) { … }` block, add:

```js
// WhatsApp Cloud API deliveries, for a salon with WA_TRANSPORT=cloud. Behind
// nginx the public URL is https://<domain>/s/<slug>/webhook/whatsapp — that
// is the override_callback_uri set on the salon's WhatsApp Business account.
if (webhookRouter) {
  app.use('/webhook/whatsapp', webhookRouter);
  console.log('WhatsApp Cloud API webhook enabled');
}
```

In `src/botState.test.js`, add `webhookRouter: null,` to the `./whatsapp.js` mock's `namedExports` (after `getWaStatus`). It imports `webhook.js`, which now imports that name.

- [ ] **Step 4: Check the Cloud API env vars at startup in `src/bot.js`**

Replace line 7 (`const REQUIRED_ENV = [...]`) with:

```js
const REQUIRED_ENV = ['DATABASE_URL', 'CLERK_SECRET_KEY', 'SALON_SLUG'];
// Meta's Cloud API instead of the QR-linked device — see WHATSAPP_CLOUD.md.
if (process.env.WA_TRANSPORT === 'cloud') {
  REQUIRED_ENV.push('WA_PHONE_NUMBER_ID', 'WA_ACCESS_TOKEN', 'WA_APP_SECRET', 'WA_VERIFY_TOKEN', 'WA_TEMPLATE_LANG');
}
```

- [ ] **Step 5: Pass `transport` through `/api/wa-status` (`src/admin.js:55-58`)**

```js
adminRouter.get('/api/wa-status', (_req, res) => {
  const { status, qrDataUrl, transport } = getWaStatus();
  res.json({ salon: process.env.SALON_SLUG, status, qrDataUrl, transport });
});
```

- [ ] **Step 6: Show the Cloud API state in the panel**

In `public/admin-dashboard.html`, inside `loadWaStatus()`, insert right before `if (wa.status === 'open') {`:

```js
  // Cloud API salons have no QR to scan — the connection is Meta's token.
  if (wa.transport === 'cloud') {
    card.innerHTML = wa.status === 'open'
      ? '<h2><span class="wa-dot" style="background:#25C168"></span>Подключён</h2>' +
        '<p>Подключено через WhatsApp Cloud API.</p>'
      : '<h2><span class="wa-dot" style="background:#E5A400"></span>Cloud API: ошибка доступа</h2>' +
        '<p>Проверьте токен WA_ACCESS_TOKEN в настройках салона.</p>';
    return;
  }
```

- [ ] **Step 7: Document the env vars in `.env.example`**

Append after the `ADMIN_PHONES` block:

```
# WhatsApp transport. Unset or "baileys" — a linked device paired by QR in
# the admin panel (above). "cloud" — Meta's official WhatsApp Cloud API:
# no QR and no ban risk, but needs a verified business, approved message
# templates and these variables. Setup step by step: WHATSAPP_CLOUD.md.
# WA_TRANSPORT=cloud
# WA_PHONE_NUMBER_ID=
# WA_ACCESS_TOKEN=          # permanent system-user token, Meta Business Manager
# WA_APP_SECRET=
# WA_VERIFY_TOKEN=
# WA_TEMPLATE_LANG=ru
```

- [ ] **Step 8: Verify both transports load and the existing tests pass**

Run:

```bash
node --input-type=module -e "const m = await import('./src/whatsapp.js'); console.log(m.getWaStatus().transport, m.webhookRouter)"
WA_TRANSPORT=cloud node --input-type=module -e "const m = await import('./src/whatsapp.js'); console.log(m.getWaStatus(), typeof m.webhookRouter)"
```

Expected: `baileys null`, then `{ status: 'connecting', qrDataUrl: null, transport: 'cloud' } function`.

Run: `node --test --experimental-test-module-mocks src/waCloud.test.js src/waitlist.test.js src/aiAgent.test.js src/igAi.test.js && node --test src/utils.test.js src/waInbound.test.js`
Expected: PASS, 0 failures.

If `DATABASE_URL` points at a local Postgres, also run `node --test --experimental-test-module-mocks src/botState.test.js`. Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/whatsapp.js src/waBaileys.js src/webhook.js src/bot.js src/admin.js src/botState.test.js public/admin-dashboard.html .env.example
git commit -m "feat: выбор транспорта WhatsApp на салон — WA_TRANSPORT=cloud

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Template hints at the out-of-window call sites

Each place where the bot writes first passes the template that stands in for its text when the client is outside the window. Baileys ignores the hint, so nothing changes for Baileys salons.

**Files:**
- Modify: `src/menu.js:44-49` (`sendMenu` passes `template` through)
- Modify: `src/scheduler.js:23-31, 43-53, 70-77`
- Modify: `src/admin.js:287-294, 311-316, 786-790`
- Modify: `src/booking.js:368-375, 388-391, 409-417, 428-435, 452-459`
- Modify: `src/waitlist.js:167-177, 225-229`
- Test: `src/waitlist.test.js`

**Interfaces:**
- Consumes: `sendText(to, text, { template })` from `src/whatsapp.js` (Task 4).
- Produces: `sendMenu(phone, bodyText, items, { footer, template } = {})`. `notifyAdmins(text, template)` in `booking.js` (module-private).

- [ ] **Step 1: Write the failing test**

In `src/waitlist.test.js`, change the menu mock (line 103) to keep the options:

```js
  namedExports: { sendMenu: async (to, text, items, opts = {}) => { menus.push({ to, text, items, opts }); } },
```

Append this test:

```js
test('предложение из листа ожидания несёт шаблон для Cloud API', async () => {
  seed();
  await offerNow();

  assert.deepEqual(menus[0].opts.template, {
    name: 'waitlist_offer',
    params: [formatDateFull(DATE), '15:00 – 16:00', 'Маникюр', 'Айгуль'],
  });
});
```

and add the import at the top, after the `assert` import:

```js
import { formatDateFull } from './utils.js';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --experimental-test-module-mocks src/waitlist.test.js`
Expected: FAIL in `предложение из листа ожидания несёт шаблон для Cloud API` with `Cannot read properties of undefined (reading 'template')` or a deepEqual mismatch.

- [ ] **Step 3: `sendMenu` passes the template through (`src/menu.js`)**

```js
// items: [{ id, label }]. template: what WhatsApp Cloud API sends instead
// when the client is outside the 24h window (see waCloud.js) — the numbered
// menu is still recorded, so a reply of "1" resolves the same way.
export function sendMenu(phone, bodyText, items, { footer, template } = {}) {
  const lines = items.map((it, i) => `${i + 1}. ${it.label}`);
  const text = [bodyText, '', ...lines, footer ? `\n${footer}` : null].filter(Boolean).join('\n');
  setLastMenu(phone, items.map(it => it.id));
  return sendText(phone, text, { template });
}
```

- [ ] **Step 4: Waitlist (`src/waitlist.js`)**

In `sendOffer`, give the `sendMenu` call a fourth argument:

```js
  await sendMenu(
    entry.user_id,
    `🎉 Освободилось окно на ${formatDateFull(date)}, ${slot.start} – ${slot.end}!\n\n` +
      `💅 ${full.service_name}\n👩 ${full.master_name}\n\n` +
      `Вы первый в очереди, поэтому это время держим за вами. ` +
      `Нажмите «Записаться», чтобы подтвердить.`,
    [
      { id: `waitlist:confirm:${offer.id}`, label: '✅ Записаться' },
      { id: `waitlist:decline:${offer.id}`, label: '❌ Не смогу' },
    ],
    { template: { name: 'waitlist_offer', params: [formatDateFull(date), `${slot.start} – ${slot.end}`, full.service_name, full.master_name] } }
  );
```

In the admin loop (around line 225), give `sendText` a third argument:

```js
  for (const adminPhone of ADMIN_PHONES()) {
    sendText(
      adminPhone,
      `📩 Запись из листа ожидания #${appt.id}\n👤 ${phone}\n💅 ${offer.service_name}\n` +
        `👩 ${offer.master_name}\n📅 ${formatDateFull(dateOf(offer.desired_date))}`,
      { template: { name: 'admin_waitlist_booking', params: [appt.id, phone, offer.service_name, offer.master_name, formatDateFull(dateOf(offer.desired_date))] } }
    ).catch(() => {});
  }
```

- [ ] **Step 5: Run the waitlist tests**

Run: `node --test --experimental-test-module-mocks src/waitlist.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 6: Scheduler (`src/scheduler.js`)**

Replace `sendReminder`:

```js
async function sendReminder(appt, label) {
  const date = formatDateFull(String(appt.appointment_date).slice(0, 10));
  const time = `${String(appt.start_time).slice(0, 5)} – ${String(appt.end_time).slice(0, 5)}`;
  await sendText(
    appt.user_id,
    `⏰ Напоминание: у вас запись ${label}\n\n` +
      `💅 ${appt.service_name}\n👩 ${appt.master_name}\n` +
      `📅 ${date}\n🕐 ${time}`,
    { template: { name: 'appt_reminder', params: [label, appt.service_name, appt.master_name, date, time] } }
  );
}
```

In `runConfirmRequests`, give the `sendMenu` call a fourth argument after the items array:

```js
        [
          { id: `appt_confirm:${appt.id}`, label: '✅ Да, приду' },
          { id: `cancel_appt:${appt.id}`, label: '❌ Отменить запись' },
        ],
        { template: { name: 'appt_confirm', params: [
          appt.service_name, appt.master_name, formatDateFull(date),
          `${String(appt.start_time).slice(0, 5)} – ${String(appt.end_time).slice(0, 5)}`,
        ] } }
      );
```

In `runAdminAlerts`, give the `sendText(adminPhone, …)` call a third argument after the text:

```js
          { template: { name: 'admin_unconfirmed', params: [
            appt.id, appt.user_name, isWalkIn(appt.user_id) ? '' : appt.user_id,
            appt.service_name, appt.master_name, formatDateFull(date),
            `${String(appt.start_time).slice(0, 5)} – ${String(appt.end_time).slice(0, 5)}`,
          ] } }
```

(An empty phone becomes `—` in `waCloud.js`, which Meta accepts.)

- [ ] **Step 7: Admin panel routes (`src/admin.js`)**

Cancel (around line 287), third argument to `sendText`:

```js
      `Для новой записи напишите "меню".`,
    { template: { name: 'appt_cancelled_by_salon', params: [
      appt.service_name, appt.master_name, formatDateFull(String(appt.appointment_date).slice(0, 10)),
      `${String(appt.start_time).slice(0, 5)} – ${String(appt.end_time).slice(0, 5)}`,
    ] } }
  ).catch(() => {});
```

Reschedule (around line 311):

```js
      `📅 ${formatDateFull(date)}\n🕐 ${startTime} – ${endTime}`,
    { template: { name: 'appt_moved_by_salon', params: [appt.service_name, appt.master_name, formatDateFull(date), `${startTime} – ${endTime}`] } }
  ).catch(() => {});
```

Create (around line 786):

```js
      `📅 ${formatDateFull(date)}\n🕐 ${startTime} – ${endTime}`,
    { template: { name: 'appt_created_by_salon', params: [appt.service_name, appt.master_name, formatDateFull(date), `${startTime} – ${endTime}`] } }
  ).then(() => sendAddress(userId)).catch(() => {});
```

- [ ] **Step 8: Booking core (`src/booking.js`)**

In `handleAdminCancel`, the client message (around line 368) gets a third argument:

```js
      `Для новой записи напишите "меню".`,
    { template: { name: 'appt_cancelled_by_salon', params: [
      appt.service_name, appt.master_name, formatDateFull(String(appt.appointment_date).slice(0, 10)),
      `${String(appt.start_time).slice(0, 5)} – ${String(appt.end_time).slice(0, 5)}`,
    ] } }
  );
```

`notifyAdmins` takes the template:

```js
function notifyAdmins(text, template) {
  for (const adminPhone of ADMIN_PHONES()) {
    sendText(adminPhone, text, { template }).catch(() => {});
  }
}
```

New booking (`createAppointmentFor`, around line 409). Second argument to `notifyAdmins`:

```js
      `Чтобы отменить, напишите: cancel ${appt.id}`,
    { name: 'admin_new_booking', params: [
      appt.id, full.user_name, phone, full.service_name, full.master_name,
      formatDateFull(date), `${startTime} – ${endTime}`, appt.id,
    ] }
  );
```

Client cancelled (`cancelAppointmentFor`, around line 428):

```js
      `🕐 ${String(appt.start_time).slice(0, 5)} – ${String(appt.end_time).slice(0, 5)}`,
    { name: 'admin_client_cancelled', params: [
      apptId, appt.user_name, phone, appt.service_name, appt.master_name, formatDateFull(date),
      `${String(appt.start_time).slice(0, 5)} – ${String(appt.end_time).slice(0, 5)}`,
    ] }
  );
```

Moved (`rescheduleAppointmentFor`, around line 452):

```js
      `Стало: ${formatDateFull(date)} ${startTime} – ${endTime}`,
    { name: 'admin_booking_moved', params: [
      apptId, appt.user_name, phone, appt.service_name, appt.master_name,
      `${formatDateFull(oldDate)} ${String(appt.start_time).slice(0, 5)}`,
      `${formatDateFull(date)} ${startTime} – ${endTime}`,
    ] }
  );
```

- [ ] **Step 9: Check that every name matches the spec and nothing else changed**

Run: `grep -oh "name: '[a-z_]*'" src/scheduler.js src/admin.js src/booking.js src/waitlist.js src/menu.js | sort -u`
Expected: exactly the 11 names from Global Constraints (these files had no `name: '…'` literals before this task; `aiAgent.js`'s tool names are deliberately outside the grep).

Run: `node --test --experimental-test-module-mocks src/waCloud.test.js src/waitlist.test.js src/aiAgent.test.js src/igAi.test.js && node --test src/utils.test.js src/waInbound.test.js && node --check src/booking.js src/admin.js src/scheduler.js`
Expected: PASS, 0 failures, no syntax errors.

- [ ] **Step 10: Commit**

```bash
git add src/menu.js src/scheduler.js src/admin.js src/booking.js src/waitlist.js src/waitlist.test.js
git commit -m "feat: шаблоны Cloud API для сообщений, которые бот пишет первым

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `WHATSAPP_CLOUD.md`, the onboarding guide

**Files:**
- Create: `WHATSAPP_CLOUD.md`

**Interfaces:**
- Consumes: the template names and parameter order from Task 5, and the env vars from Task 4.

- [ ] **Step 1: Write the guide**

Create `WHATSAPP_CLOUD.md` (in Russian, like `INSTAGRAM.md`):

````markdown
# WhatsApp Cloud API — подключение салона

Салон по умолчанию работает через Baileys (привязка по QR). Для салона,
которому нельзя рисковать баном номера, есть официальный WhatsApp Cloud API
от Meta. Включается переменной `WA_TRANSPORT=cloud` в `env/<slug>.env`.
Код: `src/waCloud.js`, дизайн: `docs/superpowers/specs/2026-10-08-whatsapp-cloud-transport-design.md`.

## Что отличается от Baileys

- QR не нужен, в панели вместо него «Подключено через WhatsApp Cloud API».
- Обычный текст Meta пропускает только в течение 24 часов после последнего
  сообщения клиента. Позже — только одобренные шаблоны (ниже). Сообщение,
  для которого шаблона нет (например, адрес после записи из панели), вне
  окна не уходит — в логе `WARN: outside 24h window, no template`.
- Сотрудники продолжают переписываться из приложения WhatsApp Business на
  телефоне (coexistence) — бот видит их ответы и замолкает в этом чате,
  как и сейчас.
- Платно: шаблоны категории Utility ≈ $0.008 за сообщение (рынок «Other»).

## Подключение — по шагам

1. **Верификация бизнеса** в Meta Business Manager (business.facebook.com →
   Настройки → Центр безопасности). Без неё лимит — 250 диалогов в сутки.
2. **Номер через coexistence.** Номер остаётся в приложении WhatsApp
   Business. В WhatsApp Manager → «Добавить номер» → «Подключить
   существующий номер WhatsApp Business» и подтвердить в приложении.
3. **Приложение Meta.** Одно на все салоны (developers.facebook.com →
   приложение типа Business, продукт WhatsApp). Из него: App Secret →
   `WA_APP_SECRET`.
4. **Постоянный токен.** Business Manager → Пользователи → Системные
   пользователи → создать, выдать доступ к приложению и к WhatsApp-аккаунту
   салона с правами `whatsapp_business_messaging` и
   `whatsapp_business_management`, сгенерировать токен без срока →
   `WA_ACCESS_TOKEN`.
5. **Phone number ID** — WhatsApp Manager → номер → «ID номера телефона» →
   `WA_PHONE_NUMBER_ID`.
6. **Вебхук салона.** Придумать `WA_VERIFY_TOKEN` (любая длинная строка) и
   привязать адрес к WhatsApp-аккаунту салона:

   ```bash
   curl -X POST "https://graph.facebook.com/v26.0/<WABA_ID>/subscribed_apps" \
     -H "Authorization: Bearer <WA_ACCESS_TOKEN>" \
     -d "override_callback_uri=https://<домен>/s/<slug>/webhook/whatsapp" \
     -d "verify_token=<WA_VERIFY_TOKEN>"
   ```

   В настройках вебхука приложения подписаться на поля `messages` и
   `smb_message_echoes`.
7. **Шаблоны** — создать все одиннадцать (ниже) в WhatsApp Manager →
   Шаблоны сообщений. Категория Utility, язык русский. Дождаться статуса
   «Одобрено» — и проверить, что категория осталась Utility.
8. **env-файл салона:**

   ```
   WA_TRANSPORT=cloud
   WA_PHONE_NUMBER_ID=...
   WA_ACCESS_TOKEN=...
   WA_APP_SECRET=...
   WA_VERIFY_TOKEN=...
   WA_TEMPLATE_LANG=ru
   ```

   `docker compose up -d salon-<slug>` и в логах — `WhatsApp Cloud: connected`
   и `WhatsApp Cloud API webhook enabled`.
9. **Проверка вживую:** написать салону с личного номера → бот отвечает;
   ответить клиенту из приложения Business → бот замолкает в этом чате;
   отправить запись из панели на номер, который не писал больше суток →
   приходит шаблон.

## Шаблоны

Порядок переменных важен — код подставляет их именно так. В поле «пример»
при создании — значения из колонки «Пример».

| Имя | Текст | Пример |
|---|---|---|
| `appt_reminder` | Напоминание: у вас запись {{1}}.<br>💅 {{2}}<br>👩 {{3}}<br>📅 {{4}}, {{5}}<br>Ждём вас! | завтра · Маникюр · Айгуль · 10 октября (пятница) · 14:00 – 15:30 |
| `appt_confirm` | Здравствуйте! Подтверждаете свою запись?<br>💅 {{1}}<br>👩 {{2}}<br>📅 {{3}}, {{4}}<br>Ответьте 1 — приду, 2 — отменить запись. | Маникюр · Айгуль · 10 октября (пятница) · 14:00 – 15:30 |
| `appt_cancelled_by_salon` | Ваша запись отменена салоном.<br>💅 {{1}}<br>👩 {{2}}<br>📅 {{3}}, {{4}}<br>Для новой записи напишите «меню». | Маникюр · Айгуль · 10 октября (пятница) · 14:00 – 15:30 |
| `appt_moved_by_salon` | Ваша запись перенесена.<br>💅 {{1}}<br>👩 {{2}}<br>📅 {{3}}, {{4}}<br>Если время не подходит, напишите нам. | Маникюр · Айгуль · 11 октября (суббота) · 12:00 – 13:30 |
| `appt_created_by_salon` | Вас записали.<br>💅 {{1}}<br>👩 {{2}}<br>📅 {{3}}, {{4}}<br>Ждём вас! | Маникюр · Айгуль · 10 октября (пятница) · 14:00 – 15:30 |
| `waitlist_offer` | Освободилось окно на {{1}}, {{2}}.<br>💅 {{3}}<br>👩 {{4}}<br>Вы первый в очереди, это время держим за вами. Ответьте 1 — записаться, 2 — не смогу. | 10 октября (пятница) · 14:00 – 15:30 · Маникюр · Айгуль |
| `admin_new_booking` | Новая запись #{{1}}<br>👤 {{2}} ({{3}})<br>💅 {{4}}<br>👩 {{5}}<br>📅 {{6}}, {{7}}<br>Чтобы отменить, ответьте: cancel {{8}} | 42 · Айнура · 996700111222 · Маникюр · Айгуль · 10 октября (пятница) · 14:00 – 15:30 · 42 |
| `admin_client_cancelled` | Клиент отменил запись #{{1}}<br>👤 {{2}} ({{3}})<br>💅 {{4}}<br>👩 {{5}}<br>📅 {{6}}, {{7}}<br>Место предложено листу ожидания. | 42 · Айнура · 996700111222 · Маникюр · Айгуль · 10 октября (пятница) · 14:00 – 15:30 |
| `admin_booking_moved` | Перенос записи #{{1}}<br>👤 {{2}} ({{3}})<br>💅 {{4}}<br>👩 {{5}}<br>Было: {{6}}<br>Стало: {{7}}<br>Детали в панели. | 42 · Айнура · 996700111222 · Маникюр · Айгуль · 10 октября (пятница) 14:00 · 11 октября (суббота) 12:00 – 13:30 |
| `admin_waitlist_booking` | Запись из листа ожидания #{{1}}<br>👤 {{2}}<br>💅 {{3}}<br>👩 {{4}}<br>📅 {{5}}<br>Детали в панели. | 43 · 996700111222 · Маникюр · Айгуль · 10 октября (пятница) |
| `admin_unconfirmed` | Клиент не подтвердил запись #{{1}}<br>👤 {{2}} ({{3}})<br>💅 {{4}}<br>👩 {{5}}<br>📅 {{6}}, {{7}}<br>Стоит позвонить. Не придёт — отмените запись в панели. | 42 · Айнура · 996700111222 · Маникюр · Айгуль · 10 октября (пятница) · 14:00 – 15:30 |

`<br>` в таблице — перенос строки в тексте шаблона.

## Если что-то не так

| В логе | Что значит |
|---|---|
| `credentials check failed: 190` / панель «ошибка доступа» | Токен отозван или истёк — выпустить новый (шаг 4), перезапустить контейнер |
| `(template …): 132001` | Шаблон с таким именем не создан или ещё не одобрен |
| `(template …): 132000` | Число переменных в шаблоне не совпадает с кодом — сверить с таблицей |
| `Meta says … outside the 24h window` | Наши часы и Meta разошлись; разовое — не страшно |
| `bad signature, dropping delivery` | `WA_APP_SECRET` не от того приложения |
````

- [ ] **Step 2: Check the guide against the code**

Run: `diff <(grep -oh "name: '[a-z_]*'" src/scheduler.js src/admin.js src/booking.js src/waitlist.js | sed "s/.*'\(.*\)'/\1/" | sort -u) <(grep -o '`[a-z_]*`' WHATSAPP_CLOUD.md | tr -d '`' | grep -E '^(appt|waitlist|admin)_' | sort -u)`
Expected: no output (the same 11 names in code and guide).

- [ ] **Step 3: Commit**

```bash
git add WHATSAPP_CLOUD.md
git commit -m "docs: подключение салона к WhatsApp Cloud API и тексты шаблонов

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Final check

- [ ] **Step 1: Full test suite**

Run: `npm test` (with `DATABASE_URL` set to a local Postgres, because `schedule.test.js`, `admin.test.js` and `botState.test.js` need one).
Expected: every test passes. Without a database, run the database-free files from Task 4 Step 8 and say so in the hand-off.

- [ ] **Step 2: A Baileys salon is untouched**

Run: `git diff main -B -M -- src/whatsapp.js src/waBaileys.js` (`-B` breaks the rewritten `whatsapp.js` into delete + add, so `-M` can pair the old file with `waBaileys.js`; the new switch shows as added).
Expected: the only change against the old `src/whatsapp.js` is the `rememberId` import (Task 1) and `transport: 'baileys'` in `getWaStatus` (Task 4).

- [ ] **Step 3: Live check (by the human partner, with Meta's free test number)**

In the Meta app → WhatsApp → API Setup there's a test number and a temporary token. Run locally with `WA_TRANSPORT=cloud` and those values. Expose the port with any tunnel and point the app's webhook at `<tunnel>/webhook/whatsapp`. Then:
1. Write to the test number → the bot answers with the main menu.
2. Book an appointment → the confirmation and the address arrive.
3. Create one approved template (e.g. `appt_reminder`) and call `sendText` for a number that hasn't written in over 24h (or temporarily make `db.lastInboundAt` return an old date) → the template arrives.

This step can't be automated here. Report it as pending if it hasn't been done.
