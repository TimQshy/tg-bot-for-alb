# Instagram для салона astra — не доведено до конца

Отложено 2026-09-18, продолжено 2026-09-19. Код автоответчика готов давно
(`src/instagram.js`, `INSTAGRAM.md`) — осталась настройка на стороне Meta.

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

1. В шаге 2 дашборда Meta перевести **Webhook Subscription** у
   `astra_stylist` в `On` — до генерации токена тумблер был заблокирован
   («Generate a new access token first»). В шаге 3 проверить поля `comments`
   и `messages`.
2. Заполнить тексты во вкладке Instagram: что уходит в директ на `+`.
   Без строк бот молчит.
3. Боевая проверка: с аккаунта, **у которого нет роли в приложении**,
   написать `+` под постом `astra_stylist`. Свои комментарии бот игнорирует,
   поэтому с самого `astra_stylist` проверять бесполезно.
4. Профиль `astra_stylist` должен быть публичным — диалог привязки
   предупреждает, что токены выдаются только публичным аккаунтам.

## Открытый вопрос

Пункта «Разрешить доступ к сообщениям» в приложении Instagram нет — ни в
«Сообщения и ответы на истории», ни в веб-настройках. Похоже, при связке
через Instagram Login согласие даётся в окне OAuth. Если директ не уйдёт, а
публичный ответ под комментарием сработает — причина всё-таки здесь.

## Когда понадобится App Review

Пока салон один, не нужен: Standard Access работает для аккаунтов с ролью
Instagram Tester, и ограничение это не по времени, а по списку аккаунтов.
Обычные клиенты, которые пишут `+`, роли не требуют — приложение должно быть
только Published. App Review (и Business verification, и скринкаст под
каждое разрешение) понадобится, чтобы подключать чужие салоны; тогда же
всплывёт второй барьер из `INSTAGRAM.md` — один Callback URL на приложение
и нужда в диспетчере по `entry[].id`.
