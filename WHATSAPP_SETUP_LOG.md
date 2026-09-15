# WhatsApp Cloud API — лог настройки и починки (2026-09-14)

Сессия: разобрались, почему бот не отвечал на реальные сообщения из WhatsApp, и подключили DeepSeek.

## Итоговое состояние

- WhatsApp-приложение в Meta for Developers: **Chat-bot for beauty salon** (App ID `1376084688011696`), статус — **Published**.
- Используется тестовый номер Meta: **+1 (555) 670-5315**, `phone_number_id` = `1273608355841798`, WABA id = `1040685092128037`.
- Токен для отправки сообщений (`WHATSAPP_TOKEN` в Railway) — **постоянный**, выпущен через System User `whatsapp-bot` (Business Settings → System Users), scope `whatsapp_business_management` + `whatsapp_business_messaging`, срок действия — Never expire.
- `DEEPSEEK_API_KEY` подключён в Railway, работает как fallback-провайдер ИИ-консультанта (основной — Gemini, если задан `GEMINI_API_KEY`).
- В `src/webhook.js` добавлен роут `GET /privacy` — отдаёт простую страницу политики конфиденциальности, используется как Privacy Policy URL в настройках Meta-приложения.

## Проблема 1: WhatsApp-токен постоянно "протухал"

**Симптом:** токен в API Setup менялся каждые ~сутки, каждый раз надо было вручную обновлять `WHATSAPP_TOKEN` в Railway.

**Причина:** использовался временный access token (живёт 24 часа) со страницы Meta App Dashboard → WhatsApp → API Setup — он и не предназначен для продакшена.

**Решение:** создали System User в Business Settings (`whatsapp-bot`), привязали к нему:
- само приложение (App) с доступом Develop app,
- WhatsApp-аккаунты (WABA) с правами Messages + Manage phone numbers and message templates,

затем сгенерировали токен для системного пользователя с scope `whatsapp_business_management`, `whatsapp_business_messaging` и сроком **Never expire**. Такой токен не истекает и не требует ручного обновления.

## Проблема 2: реальные сообщения из WhatsApp не долетали до бота

Долго казалось, что дело в том, что приложение было в статусе **Unpublished** — Meta действительно показывает предупреждение "No production data... will be delivered unless the app has been published". Опубликовали приложение (потребовалось: Privacy Policy URL, категория приложения — добавили роут `/privacy` и заполнили Basic Settings).

Публикация была нужна и правильна сама по себе, но реальная причина отсутствия ответов была **не в этом** — оказалось, что бот суть проблемы вскрыл только пошаговый тест:

### Диагностика: синтетический webhook-запрос напрямую на сервер

Чтобы отделить "баг сервера/токена" от "баг доставки Meta", сформировали вручную подписанный (HMAC-SHA256 по `WHATSAPP_APP_SECRET`) POST-запрос к `https://<railway-url>/webhook` — как будто это реальное сообщение "меню" от Meta. Это позволило проверять логику бота независимо от того, доходят ли реальные сообщения.

Первый прогон вскрыл:

### Проблема 2a: токен System User не имел прав на сам WABA

**Симптом:** синтетический запрос доходил до сервера (HTTP 200), но в логах Railway — `WhatsApp API error: 400 {"error":{"message":"Authorization Error","code":100,"type":"OAuthException"}}`.

**Причина:** при создании System User ему назначили доступ только к **App** (само приложение в Meta for Developers), но не к **WhatsApp account (WABA)** — а именно WABA-права нужны, чтобы слать сообщения через `/{phone_number_id}/messages`.

**Решение:** Business Settings → System Users → whatsapp-bot → Assign assets → WhatsApp accounts → выбрали WABA → включили права **Messages** и **Manage phone numbers and message templates**.

### Проблема 2b: наше приложение не было подписано на webhook-события этого WABA

**Симптом:** после фикса 2a токен уже мог отправлять сообщения, но реальные входящие сообщения из WhatsApp всё равно не доходили до `/webhook` (в HTTP-логах Railway — ноль запросов от Meta), хотя кнопка "Test" в Meta Dashboard (Configuration → Webhooks → поле `messages` → Test) успешно долетала.

**Причина найдена через Graph API:**
```
GET /{waba-id}/subscribed_apps
```
показал, что WABA (`1040685092128037`) подписан на webhook стороннего служебного приложения Meta — **"WA DevX Webhook Events 1P App"** (`app_id=2202427980234937`), а не на наше собственное приложение. Кнопка "Test" в интерфейсе Meta не проверяет реальную подписку — она просто шлёт пример payload'а напрямую на настроенный Callback URL, поэтому создавала иллюзию, что всё работает.

**Решение:**
```
POST /{waba-id}/subscribed_apps
```
с токеном нашего приложения — подписали наше приложение на события этого WABA. После этого `subscribed_apps` стал возвращать оба приложения, и реальные сообщения из WhatsApp начали доходить до `/webhook`.

## Побочные находки / долги на будущее

- `src/webhook.js` не логирует успешную обработку входящих сообщений (только `console.error` при ошибке) — из-за этого было трудно на глаз понять, дошло ли сообщение до сервера. Диагностировали через `railway logs --http` (реальные HTTP-запросы) вместо обычных deploy-логов.
- Изменение `/privacy` роута задеплоено на Railway через `railway up`, но **не закоммичено в git** — стоит закоммитить, чтобы репозиторий не разъезжался с прод-деплоем.
- `ADMIN_PASSWORD` в Railway всё ещё дефолтный/слабый — сменить, раз приложение публичное.
- `Terms of Service URL` в Meta App Basic Settings — так и остался плейсхолдером `facebook.com` (поправили только Privacy Policy и User data deletion).
- Шаг **"Add payment to send business-initiated messages"** (Step 2. Production setup) не пройден — без него нельзя слать проактивные/шаблонные сообщения (напоминания, waitlist-офферы) вне 24-часового окна ответа клиенту.
- **Business Verification** (Step 3) не пройдена — нужна для снятия лимитов и перехода с тестового номера на постоянный.
- Всё ещё используется тестовый номер Meta (+1 555-670-5315), не настоящий купленный номер салона.
- В Business Settings у System User теперь есть доступ ещё к 2 WABA («Beaty-salon», «beauty-salon») кроме тестового — не проверяли, что это за аккаунты и не мусорные ли они.
- `GEMINI_API_KEY` не задан — ИИ-консультант работает только через DeepSeek fallback.
