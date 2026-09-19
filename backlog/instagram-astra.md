# Instagram для салона astra — работает

Отложено 2026-09-18, закрыто 2026-09-19: автоответ в директ подтверждён
живой проверкой (`[ig] dm to <id> sent`). Настройка Meta и грабли переехали
в `INSTAGRAM.md`, здесь остался только хвост.

## Что уже сделано

- Приложение `astra-autotvethik` (App ID `3208603412665448`, Instagram app ID
  `1003140469454120`), published, разрешения `instagram_business_basic`,
  `instagram_business_manage_comments`, `instagram_business_manage_messages`.
- `IG_VERIFY_TOKEN` и `IG_APP_SECRET` записаны в `env/astra.env` на VPS.
  В логах: `Instagram auto-replies enabled`.
- Callback URL `https://admin.zapisbot.online/s/astra/webhook/instagram`
  и verify token сохранены, шаг 3 «Configure webhooks» зелёный, в логе nginx
  `GET ...hub.mode=subscribe...` → `200`.
- **Приглашение тестировщика принято** (2026-09-19). Нашлось не в мобильном
  приложении, а на `instagram.com/accounts/manage_access/` → вкладка
  «Приглашения для тестировщиков». В App roles у `astra_stylist` статус
  Pending снят.
- **Аккаунт привязан**: шаг 2 «Generate access tokens» → `astra_stylist`,
  ID `17841418662152327`. Сначала по ошибке привязался `timqshy` — окно
  Instagram Login берёт аккаунт, под которым залогинен браузер, а не тот,
  кого пригласили тестировщиком.
- **Токен получен**, лежит в `env/astra.env` как `IG_TOKEN`, контейнер
  `salon-astra` пересоздан.
- **Тексты ответов правятся в панели** — вкладка Instagram (см. WORKLOG за
  2026-09-19), `PUT /api/ig-replies` руками больше не нужен.

## Что осталось

Одно: проверить ветку **комментария**. Директ прошёл, но приватный ответ по
`comment_id` — другой вызов Graph API и другие ограничения (один ответ на
комментарий, не позже 7 дней). Написать `+` под постом `astra_stylist` с
аккаунта без роли в приложении и увидеть в логе
`[ig] private reply sent for comment <id>`.

## Чем закончилось с токеном

Первый токен выдали для `timqshy` — окно Instagram Login берёт аккаунт, под
которым залогинен браузер. После перепривязки на `astra_stylist` он умер, а
нового в `env/astra.env` не появилось: `sed` удалил старую строку, `echo` с
новой не выполнился. Пустой `IG_TOKEN` давал
`Invalid OAuth 2.0 Access Token (code 190)` — ошибка выглядела как проблема
с Meta, хотя токена просто не было. Проверять стоит сразу двумя командами:
`grep -c '^IG_TOKEN=' env/astra.env` и `select key, length(value) from
ig_config` — база в приоритете над env.

## Когда понадобится App Review

Пока салон один, не нужен: Standard Access работает для аккаунтов с ролью
Instagram Tester, и ограничение это не по времени, а по списку аккаунтов.
Обычные клиенты, которые пишут `+`, роли не требуют — приложение должно быть
только Published. App Review (и Business verification, и скринкаст под
каждое разрешение) понадобится, чтобы подключать чужие салоны; тогда же
всплывёт второй барьер из `INSTAGRAM.md` — один Callback URL на приложение
и нужда в диспетчере по `entry[].id`.
