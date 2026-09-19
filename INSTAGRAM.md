# Автоответчик в Instagram

Клиент пишет `+` в комментарии под постом — бот отправляет ему информацию в
директ. Если директ закрыт, отвечает публично под комментарием. Сообщения в
директ обрабатываются так же.

Реализация: `src/instagram.js`, роут `/webhook/instagram` в `src/webhook.js`,
таблицы `ig_replies` / `ig_events` / `ig_config`, обновление токена раз в
месяц из `src/scheduler.js`.

## Почему не Google Apps Script

Пробовали — Meta отклоняет Callback URL вида
`https://script.google.com/macros/s/.../exec`: сам обработчик отвечает на
`hub.challenge` правильно, но Apps Script отдаёт 302 на
`script.googleusercontent.com`, и валидация не проходит. Ошибка Meta:
«The callback URL or verify token couldn't be validated».

## Приложение Meta

Приложение `astra-autotvethik`, App ID `3208603412665448`, Instagram app ID
`1003140469454120`. Уже сделано: use case «Manage messaging & content on
Instagram», разрешения `instagram_business_basic`,
`instagram_business_manage_comments`, `instagram_business_manage_messages`,
privacy policy URL, приложение опубликовано (Published).

Публикация — не App Review. Webhook'и не доставляются, пока приложение
не опубликовано, поэтому это обязательный шаг. App Review нужен отдельно и
только чтобы подключать аккаунты, не являющиеся тестировщиками приложения.

## Что осталось настроить

1. **Домен.** В `nginx/admin.conf` ещё стоит плейсхолдер `ADMIN_DOMAIN`.
   Пока нет настоящего HTTPS-домена, Callback URL вписать некуда.

2. **Instagram Tester.** App roles → Roles → Instagram Testers → Add People,
   затем принять приглашение с самого аккаунта: Instagram → Настройки →
   Для профессионалов → Разрешения для сайтов → Приглашения тестировщиков.

3. **Токен.** Use cases → Manage messaging & content on Instagram →
   Customize → API setup with Instagram login → шаг 2 «Generate access
   tokens» → Add account. Полученный токен в `env/<salon>.env` как
   `IG_TOKEN`. Дальше он обновляется сам и живёт в `ig_config`.

4. **`IG_APP_SECRET`** — Instagram app secret с той же страницы (кнопка
   Show рядом с Instagram app ID). Без него проверка подписи пропускается,
   и webhook принимает любой запрос.

5. **`IG_VERIFY_TOKEN`** — любая случайная строка, та же самая вписывается
   в Meta.

6. **Webhook.** Шаг 3 «Configure webhooks»:
   Callback URL `https://<домен>/s/<slug>/webhook/instagram`,
   Verify token — значение `IG_VERIFY_TOKEN`. Подписаться на поля
   `comments` и `messages`.

7. ~~**В самом Instagram** включить: Настройки → Сообщения и ответы на
   истории → Разрешить доступ к сообщениям.~~ Такого переключателя в
   приложении больше нет — он остался от связки через Facebook Login. При
   `API setup with Instagram login` согласие на переписку выдаётся в окне
   OAuth вместе с `instagram_business_manage_messages`.

## Тексты ответов

Таблица `ig_replies`: `keyword` — подстрока, которую ищем в тексте (регистр
не важен), `reply` — что отправить. Порядок по `position`: побеждает первая
подошедшая строка, поэтому catch-all `*` держать последним. Если ни одна
строка не подошла — бот молчит.

Правятся в панели: вкладка **Instagram**, список «слово → что отправить»,
кнопка сохраняет его целиком. Вкладка показывается только там, где
`IG_VERIFY_TOKEN` задан — панель спрашивает `GET /api/ig-status`.

API под ней: `GET /api/ig-replies`, `PUT /api/ig-replies` с телом
`{"replies": [{"keyword": "+", "reply": "..."}]}` — список сохраняется
целиком, порядок в массиве и есть приоритет. Строки, где заполнено только
одно поле из двух, отбрасываются.

## Ограничения, о которых нужно помнить

- Приватный ответ на комментарий — **один** на комментарий, и не позже 7
  дней с момента комментария.
- Писать первым можно только в ответ на комментарий. Дальше действует
  24-часовое окно: вне его сообщение не уйдёт. Поэтому напоминания о записи
  остаются в WhatsApp, а Instagram — только точка входа.
- Instagram считает спамом одинаковые ответы пачками. Если поток вырастет —
  завести несколько вариантов текста в `ig_replies`.
- Аварийный выключатель в панели (вкладка **Бот**, только системный админ)
  глушит и Instagram: обработчики выходят до `claimIgEvent`, поэтому
  события не помечаются обработанными и ничего не теряется молча.
- Instagram подключён только одному салону. Роут `/webhook/instagram`
  поднимается лишь там, где задан `IG_VERIFY_TOKEN`; у остальных салонов
  тот же образ работает без него, и роута у них просто нет.
- Один Callback URL на всё приложение. Сейчас он ведёт в контейнер одного
  салона. Когда Instagram понадобится второму, потребуется диспетчер,
  который разводит события по `entry[].id` (Instagram-аккаунт).

## Проверка

- `GET https://<домен>/s/<slug>/webhook/instagram?hub.mode=subscribe&hub.verify_token=<IG_VERIFY_TOKEN>&hub.challenge=12345`
  должен вернуть голое `12345`.
- Кнопка Test рядом с полем webhook в дашборде Meta шлёт тестовый payload —
  в логах контейнера появится запись. Id в нём фальшивые, поэтому ответ
  никуда не уйдёт.
- Боевая проверка: со **второго**, личного аккаунта написать `+` под постом
  бизнес-аккаунта. Свои же комментарии бот игнорирует.
