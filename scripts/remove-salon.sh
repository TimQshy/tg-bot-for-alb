#!/usr/bin/env bash
# Отключить салон.  Usage:
#   scripts/remove-salon.sh <slug> [--drop-db]
#
# По умолчанию база НЕ удаляется: снимается контейнер и убираются записи из
# compose, nginx и config.json, а данные остаются на месте. Так отключение
# обратимо — салон поднимается обратно через scripts/new-salon.sh с тем же
# слагом (база уже есть, схема цела).
#
# --drop-db удаляет базу насовсем: записи клиентов, историю сообщений и
# сессию WhatsApp. Дамп снимается в любом случае, до всех действий.
set -euo pipefail

SLUG="${1:?usage: remove-salon.sh <slug> [--drop-db]}"
DROP_DB="${2:-}"

cd "$(dirname "$0")/.."

if ! [[ "$SLUG" =~ ^[a-z0-9-]+$ ]]; then
  echo "slug: только строчные латинские буквы, цифры и дефис" >&2
  exit 1
fi

DB="salon_${SLUG//-/_}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/salon-bot}"
DUMP="$BACKUP_DIR/removed-$SLUG-$(date +%Y%m%d-%H%M%S).sql.gz"

grep -q "^  salon-$SLUG:" docker-compose.yml || echo "предупреждение: сервиса salon-$SLUG нет в docker-compose.yml"

echo "Салон:        $SLUG"
echo "База:         $DB"
if [ "$DROP_DB" = "--drop-db" ]; then
  echo "База будет:   УДАЛЕНА НАВСЕГДА (записи, история, сессия WhatsApp)"
else
  echo "База будет:   сохранена (удалить потом: --drop-db)"
fi
echo "Дамп:         $DUMP"
echo
printf "Для подтверждения введите слаг салона (%s): " "$SLUG"
read -r CONFIRM
[ "$CONFIRM" = "$SLUG" ] || { echo "отменено"; exit 1; }

if [ "$DROP_DB" = "--drop-db" ]; then
  printf "База будет удалена безвозвратно. Введите DROP для подтверждения: "
  read -r CONFIRM2
  [ "$CONFIRM2" = "DROP" ] || { echo "отменено"; exit 1; }
fi

# ── Дамп до любых изменений ──────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"
docker compose exec -T postgres pg_dump -U postgres "$DB" | gzip > "$DUMP"
if ! gzip -dc "$DUMP" | tail -c 200 | grep -q 'PostgreSQL database dump complete'; then
  echo "ОСТАНОВЛЕНО: дамп $DUMP оборван, ничего не тронуто" >&2
  rm -f "$DUMP"
  exit 1
fi
echo "  дамп снят: $DUMP ($(du -h "$DUMP" | cut -f1))"

# ── Снять контейнер ──────────────────────────────────────────────────────
docker compose stop "salon-$SLUG" >/dev/null 2>&1 || true
docker compose rm -f "salon-$SLUG" >/dev/null 2>&1 || true
echo "  контейнер остановлен"

# ── Убрать из compose и nginx ────────────────────────────────────────────
python3 - "$SLUG" <<'PY'
import re, sys
slug = sys.argv[1]

src = open('docker-compose.yml').read()
out = re.sub(rf"  salon-{re.escape(slug)}:\n(?:    .*\n)*\n?", "", src, count=1)
open('docker-compose.yml','w').write(out)

src = open('nginx/admin.conf').read()
out = re.sub(rf"    location /s/{re.escape(slug)}/ \{{\n(?:.*\n)*?    \}}\n\n?", "", src, count=1)
open('nginx/admin.conf','w').write(out)
PY
echo "  записи убраны из docker-compose.yml и nginx/admin.conf"

# ── Убрать из config.json ────────────────────────────────────────────────
python3 - "$SLUG" <<'PY'
import json, sys
slug = sys.argv[1]
cfg = json.load(open('public/config.json'))
cfg['salons'] = [s for s in cfg.get('salons', []) if s['slug'] != slug]
json.dump(cfg, open('public/config.json','w'), ensure_ascii=False, indent=2)
PY
echo "  убран из public/config.json"

# ── env-файл в сторону, не в корзину ─────────────────────────────────────
[ -f "env/$SLUG.env" ] && mv "env/$SLUG.env" "env/$SLUG.env.removed" && echo "  env/$SLUG.env -> env/$SLUG.env.removed"

if [ "$DROP_DB" = "--drop-db" ]; then
  docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE \"$DB\"" >/dev/null
  docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -c "DROP ROLE \"$DB\"" >/dev/null
  echo "  база $DB и роль удалены"
fi

docker compose exec nginx nginx -s reload >/dev/null 2>&1 || docker compose restart nginx >/dev/null
echo "  nginx перечитан"

echo
echo "Салон '$SLUG' отключён. Дамп: $DUMP"
[ "$DROP_DB" = "--drop-db" ] || echo "База $DB осталась на месте."
echo "Доступы владельца в Clerk скрипт не трогает — снимите их в панели, раздел «Доступы»."
