# WhatsApp Cloud API as a second transport — design

Date: 2026-10-08. Status: approved in discussion, awaiting spec review.

## Goal

Each salon chooses its WhatsApp transport in its env file: **Baileys** (linked
device, QR — today's behaviour) or **Meta's official Cloud API**. A salon that
can't risk a ban on its number runs on Cloud API; the rest stay on Baileys.
Both run from the same Docker image.

Out of scope: moving existing salons, native WhatsApp buttons/lists (menus stay
numbered text), a chat inbox in the admin panel, scripting template creation
through Meta's API.

## Decisions

| Question | Decision |
|---|---|
| Purpose | Per-salon choice, `WA_TRANSPORT=baileys\|cloud`, default `baileys` |
| Where the code lives | Inside the existing app — no separate gateway service |
| Human takeover on Cloud API | Coexistence: the number stays in the WhatsApp Business app, Meta sends `smb_message_echoes`, which feed the existing `handleHumanReply` |
| Messages outside the 24h window | Sent as an approved template; no template → not sent, logged as a warning. No retry queue |
| Template granularity | One specific template per message type (11 total), never one generic `{{1}}` template |
| Menus | Stay numbered text; template bodies end with "Ответьте 1 — …, 2 — …" |
| Meta apps | One Meta app for all salons, a per-WABA `override_callback_uri` pointing at `/s/<slug>/webhook/whatsapp` |

## Architecture

```
src/whatsapp.js     ~10 lines: re-exports from waBaileys.js or waCloud.js
                    depending on WA_TRANSPORT
src/waBaileys.js    today's whatsapp.js, moved with git mv, contents unchanged
src/waCloud.js      Cloud API transport: sendText, connectWhatsApp,
                    getWaStatus, plus an Express router for Meta's webhook
```

Both transports export the same three functions, so the seven importers of
`whatsapp.js` don't change except for the template hints below:

- `sendText(to, text, { template } = {})` — `template` is
  `{ name, params: [string, …] }`. Baileys ignores it.
- `connectWhatsApp(onIncoming, onHumanReply)` — on Cloud API it stores the two
  callbacks for the webhook router and checks the credentials (see Status).
- `getWaStatus()` — `{ status, qrDataUrl, transport }`.

`webhook.js` mounts `waCloud`'s router at `/webhook/whatsapp` only when
`WA_TRANSPORT=cloud`, the same way it mounts Instagram's. nginx already proxies
everything under `/s/<slug>/`, so the public URL is
`https://<domain>/s/<slug>/webhook/whatsapp` with no nginx change.

## Outbound

`waCloud.sendText(to, text, { template })`:

1. Walk-ins (`isWalkIn(to)`) are dropped, and every send is logged to
   `messages` — both exactly as in Baileys today.
2. `db.lastInboundAt(to)` — new query: latest `created_at` in `messages` with
   `direction='in'` for that phone (served by the existing
   `idx_messages_phone`).
3. Within 24h → `POST https://graph.facebook.com/<version>/<WA_PHONE_NUMBER_ID>/messages`
   with `{ type: 'text', text: { body } }`.
4. Outside 24h with a template → the same endpoint with
   `{ type: 'template', template: { name, language: { code: WA_TEMPLATE_LANG }, components: [{ type: 'body', parameters } ] } }`.
5. Outside 24h without a template → no request;
   `WARN: outside 24h window, no template — dropped message to <phone>`.

Plain `fetch` with `Authorization: Bearer <WA_ACCESS_TOKEN>`, no SDK. The Graph
API version is a constant in `waCloud.js`.

Template parameters must not contain newlines, tabs or more than four spaces in
a row, and must not be empty (Meta rejects all three). `waCloud` collapses
whitespace in each parameter and replaces an empty one with `—` (a walk-in has
no phone number, for example).

`sendMenu(phone, body, items, { footer, template })` passes `template` through
to `sendText`; it still records the menu with `setLastMenu`, so a reply of "1"
to a template resolves through `resolveMenuReply` exactly as it does today.

## Templates

Category **Utility**, language from `WA_TEMPLATE_LANG` (`ru`). Each Cloud API
salon creates all eleven once in WhatsApp Manager during onboarding; the exact
texts with example values go in `WHATSAPP_CLOUD.md`. Template names are
constants in code — the same for every salon.

| Name | Call site(s) | Body |
|---|---|---|
| `appt_reminder` | `scheduler.js:24` | `Напоминание: у вас запись {{1}}.`<br>`💅 {{2}}`<br>`👩 {{3}}`<br>`📅 {{4}}, {{5}}`<br>`Ждём вас!` — `{{1}}` is `завтра` / `через 2 часа` |
| `appt_confirm` | `scheduler.js:43` | `Здравствуйте! Подтверждаете свою запись?`<br>`💅 {{1}}`<br>`👩 {{2}}`<br>`📅 {{3}}, {{4}}`<br>`Ответьте 1 — приду, 2 — отменить запись.` |
| `appt_cancelled_by_salon` | `admin.js:287`, `booking.js:368` | `Ваша запись отменена салоном.`<br>`💅 {{1}}`<br>`👩 {{2}}`<br>`📅 {{3}}, {{4}}`<br>`Для новой записи напишите «меню».` |
| `appt_moved_by_salon` | `admin.js:311` | `Ваша запись перенесена.`<br>`💅 {{1}}`<br>`👩 {{2}}`<br>`📅 {{3}}, {{4}}`<br>`Если время не подходит, напишите нам.` |
| `appt_created_by_salon` | `admin.js:786` | `Вас записали.`<br>`💅 {{1}}`<br>`👩 {{2}}`<br>`📅 {{3}}, {{4}}`<br>`Ждём вас!` |
| `waitlist_offer` | `waitlist.js:167` | `Освободилось окно на {{1}}, {{2}}.`<br>`💅 {{3}}`<br>`👩 {{4}}`<br>`Вы первый в очереди, это время держим за вами. Ответьте 1 — записаться, 2 — не смогу.` |
| `admin_new_booking` | `booking.js:409` | `Новая запись #{{1}}`<br>`👤 {{2}} ({{3}})`<br>`💅 {{4}}`<br>`👩 {{5}}`<br>`📅 {{6}}, {{7}}`<br>`Чтобы отменить, ответьте: cancel {{8}} — или отмените в панели.` |
| `admin_client_cancelled` | `booking.js:428` | `Клиент отменил запись #{{1}}`<br>`👤 {{2}} ({{3}})`<br>`💅 {{4}}`<br>`👩 {{5}}`<br>`📅 {{6}}, {{7}}`<br>`Место предложено листу ожидания.` |
| `admin_booking_moved` | `booking.js:452` | `Перенос записи #{{1}}`<br>`👤 {{2}} ({{3}})`<br>`💅 {{4}}`<br>`👩 {{5}}`<br>`Было: {{6}}`<br>`Стало: {{7}}`<br>`Детали в панели.` |
| `admin_waitlist_booking` | `waitlist.js:226` | `Запись из листа ожидания #{{1}}`<br>`👤 {{2}}`<br>`💅 {{3}}`<br>`👩 {{4}}`<br>`📅 {{5}}`<br>`Детали в панели.` |
| `admin_unconfirmed` | `scheduler.js:70` | `Клиент не подтвердил запись #{{1}}`<br>`👤 {{2}} ({{3}})`<br>`💅 {{4}}`<br>`👩 {{5}}`<br>`📅 {{6}}, {{7}}`<br>`Стоит позвонить. Не придёт — отмените запись в панели.` |

Every body starts and ends with fixed text and never puts two variables side by
side, per Meta's template rules. Dates are passed as `formatDateFull(...)`,
times as `HH:MM – HH:MM`.

Every other send is a reply to a client's own message and stays plain text.
One known gap: the salon address sent after a panel-created booking
(`sendAddress`) has no template, so on Cloud API it is dropped with the warning
above when the client is outside the window.

## Inbound

`GET /webhook/whatsapp` — Meta's setup check: if `hub.mode === 'subscribe'` and
`hub.verify_token === WA_VERIFY_TOKEN`, respond with `hub.challenge`; otherwise
`403`.

`POST /webhook/whatsapp`:

1. Check `X-Hub-Signature-256` against `WA_APP_SECRET`. A bad signature gets
   `403` and is not processed. The check moves from `instagram.js`
   (`signatureValid`) into `utils.js` as `metaSignatureValid(req, secret)`;
   Instagram calls it with `IG_APP_SECRET` and behaves the same as now.
2. Respond `200` straight away, then process — Meta retries slow or failed
   deliveries.
3. For each `entry[].changes[]`, drop it if `value.metadata.phone_number_id`
   isn't `WA_PHONE_NUMBER_ID`.

| `field` / content | Action |
|---|---|
| `messages`, type `text` | `onIncoming(from, { text: text.body, profileName: contacts[0].profile.name })` |
| `messages`, other types except reactions (image, audio, sticker, …) | `onIncoming(from, { text: '', profileName })`, matching Baileys |
| `messages`, type `reaction` | ignored |
| `smb_message_echoes` | `onHumanReply(to, { text })` for text echoes — staff replied from the Business app |
| `statuses` with `status: 'failed'` | logged with Meta's error code and title |
| everything else (`statuses` other than failed, `history`, `smb_app_state_sync`, …) | ignored |

Message ids already handled are skipped, so Meta's retries don't get a second
answer. The bounded-set helper `rememberId` moves from `waInbound.js` to
`utils.js`, so `waCloud.js` doesn't load Baileys. `waInbound.js` imports it from
there.

`from` and `to` are digits without `+`, the same phone format the rest of the
app uses.

## Status and admin panel

On startup `connectWhatsApp` calls `GET /<WA_PHONE_NUMBER_ID>`: success → status
`open`, failure → `closed` with the error logged. Any later send failing with
error `190` sets `closed`.

`/api/wa-status` adds `transport`. When it is `cloud`, `admin-dashboard.html`
shows "Подключено через WhatsApp Cloud API" (or "Cloud API: ошибка доступа —
проверьте токен" when `closed`) instead of the QR block.

## Configuration

Cloud API salons only, in `env/<slug>.env`, documented in `.env.example`:

```
WA_TRANSPORT=cloud
WA_PHONE_NUMBER_ID=...
WA_ACCESS_TOKEN=...       # permanent system-user token from Meta Business Manager
WA_APP_SECRET=...
WA_VERIFY_TOKEN=...
WA_TEMPLATE_LANG=ru
```

With `WA_TRANSPORT=cloud`, `bot.js` exits at startup listing any of these that
are missing, the same as `REQUIRED_ENV`.

## Error handling

| Case | Behaviour |
|---|---|
| Network error or 5xx on send | logged, message dropped — same as Baileys while disconnected |
| `190` invalid/expired token | logged, status → `closed` |
| `131047` outside the window | logged as a warning: our window check disagreed with Meta's |
| `132000` / `132001` template parameter mismatch / template missing | logged with the template name |
| Any other 4xx | logged with code and message |
| Exception in `onIncoming` / `onHumanReply` | caught and logged per message, as in Baileys |

## Testing

New `src/waCloud.test.js` (`node --test`, global `fetch` and `db` mocked, no
network or database):

- text webhook → `onIncoming` with the right phone, text and profile name
- `smb_message_echoes` → `onHumanReply`
- the same message id delivered twice → handled once
- a different `phone_number_id` → dropped
- bad signature → `403`, nothing handled
- `GET` with the right / wrong verify token → challenge / `403`
- `sendText` inside the window → text payload
- `sendText` outside the window with a template → template payload with the
  parameters, newlines collapsed, empty parameter → `—`
- `sendText` outside the window without a template → no `fetch` call

All existing tests keep passing unchanged.

Before onboarding a real salon: a live run against the Meta app's free test
number — receive a message, reply, send one approved template.

## Unchanged for Baileys salons

`WA_TRANSPORT` defaults to `baileys`, so the existing env files don't change.
`waBaileys.js` is today's `whatsapp.js` moved as is, and it ignores the
`template` argument, so messages look exactly as they do now. Docker, nginx,
compose and the database schema don't change.

## Files

| | |
|---|---|
| New | `src/waCloud.js`, `src/waCloud.test.js`, `WHATSAPP_CLOUD.md` (onboarding checklist: business verification, coexistence setup, system-user token, `override_callback_uri`, the eleven templates with example values) |
| Moved | `src/whatsapp.js` → `src/waBaileys.js`; new `src/whatsapp.js` is the switch |
| Changed | `src/menu.js`, `src/scheduler.js`, `src/waitlist.js`, `src/booking.js`, `src/admin.js` (template hints at the call sites above), `src/database.js` (`lastInboundAt`), `src/instagram.js` and `src/waInbound.js` (use the helpers moved to `utils.js`), `src/utils.js`, `src/webhook.js` (mount the router), `src/bot.js` (env check), `public/admin-dashboard.html`, `.env.example` |
