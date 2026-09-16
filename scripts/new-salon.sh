#!/usr/bin/env bash
# Provision one salon end to end.  Usage:
#   scripts/new-salon.sh <slug> "<Название салона>" [номер_админа]
#
# Does all six steps from VPS_MIGRATION_PLAN.md: database + role, env file,
# compose service, nginx location, config.json entry, and brings the stack
# up. Safe to re-read before running — it refuses to touch a slug that is
# already wired up anywhere, rather than half-applying.
set -euo pipefail

SLUG="${1:?usage: new-salon.sh <slug> \"<Название>\" [admin_phone]}"
NAME="${2:?usage: new-salon.sh <slug> \"<Название>\" [admin_phone]}"
ADMIN_PHONE="${3:-}"

cd "$(dirname "$0")/.."

if ! [[ "$SLUG" =~ ^[a-z0-9-]+$ ]]; then
  echo "slug: только строчные латинские буквы, цифры и дефис" >&2
  exit 1
fi

DB_SUFFIX="${SLUG//-/_}"          # slug лежит в URL, имя БД — с подчёркиваниями
DB="salon_$DB_SUFFIX"
ENV_FILE="env/$SLUG.env"

# ── Проверки до любых изменений ──────────────────────────────────────────
for check in \
  "$ENV_FILE:файл окружения уже существует" \
  ; do
  path="${check%%:*}"; msg="${check#*:}"
  [ -e "$path" ] && { echo "salon '$SLUG': $msg ($path)" >&2; exit 1; }
done

grep -q "^  salon-$SLUG:" docker-compose.yml && { echo "salon '$SLUG': сервис уже есть в docker-compose.yml" >&2; exit 1; }
grep -q "location /s/$SLUG/" nginx/admin.conf && { echo "salon '$SLUG': локация уже есть в nginx/admin.conf" >&2; exit 1; }
python3 -c "
import json,sys
try: cfg=json.load(open('public/config.json'))
except FileNotFoundError: sys.exit(0)
sys.exit(1 if any(s['slug']=='$SLUG' for s in cfg.get('salons',[])) else 0)
" || { echo "salon '$SLUG': уже есть в public/config.json" >&2; exit 1; }

[ -f public/config.json ] || { echo "нет public/config.json — создайте из public/config.example.json" >&2; exit 1; }

echo "== салон '$SLUG' ($NAME) =="

# ── 1. База и роль ───────────────────────────────────────────────────────
DB_PASSWORD="$(openssl rand -hex 24)"
scripts/new-salon-db.sh "$DB_SUFFIX" "$DB_PASSWORD" >/dev/null
echo "  [1/6] база $DB создана"

# ── 2. Файл окружения ────────────────────────────────────────────────────
# Секрет Clerk общий для всех салонов — берём из уже существующего env.
CLERK_SECRET="$(grep -h '^CLERK_SECRET_KEY=' env/*.env 2>/dev/null | head -1 | cut -d= -f2- || true)"
[ -n "$CLERK_SECRET" ] || { echo "не нашёл CLERK_SECRET_KEY ни в одном env/*.env" >&2; exit 1; }

umask 077
cat > "$ENV_FILE" <<EOF
# $NAME — создан $(date +%F) скриптом scripts/new-salon.sh
DATABASE_URL=postgresql://$DB:$DB_PASSWORD@postgres:5432/$DB
SALON_SLUG=$SLUG
CLERK_SECRET_KEY=$CLERK_SECRET
ADMIN_PHONES=$ADMIN_PHONE
TIMEZONE=Asia/Bishkek
WAITLIST_OFFER_TIMEOUT_MIN=30
PORT=3000
EOF
umask 022
echo "  [2/6] $ENV_FILE записан (chmod 600)"

# ── 3. Сервис в compose ──────────────────────────────────────────────────
python3 - "$SLUG" <<'PY'
import sys
slug = sys.argv[1]
marker = '  # >>> salons >>>'
block = f"  salon-{slug}:\n    <<: *salon\n    env_file: ./env/{slug}.env\n\n"
src = open('docker-compose.yml').read()
assert marker in src, 'в docker-compose.yml нет якоря "# >>> salons >>>"'
open('docker-compose.yml','w').write(src.replace(marker, block + marker, 1))
PY
echo "  [3/6] сервис salon-$SLUG добавлен в docker-compose.yml"

# ── 4. Локация в nginx ───────────────────────────────────────────────────
python3 - "$SLUG" <<'PY'
import sys
slug = sys.argv[1]
marker = '    # >>> salons >>>'
block = (f"    location /s/{slug}/ {{\n"
         f"        proxy_pass http://salon-{slug}:3000/;\n"
         f"        proxy_set_header Host $host;\n"
         f"        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
         f"        proxy_set_header X-Forwarded-Proto $scheme;\n"
         f"    }}\n\n")
src = open('nginx/admin.conf').read()
assert marker in src, 'в nginx/admin.conf нет якоря "# >>> salons >>>"'
open('nginx/admin.conf','w').write(src.replace(marker, block + marker, 1))
PY
echo "  [4/6] локация /s/$SLUG/ добавлена в nginx"

# ── 5. Запись в config.json ──────────────────────────────────────────────
python3 - "$SLUG" "$NAME" <<'PY'
import json, sys
slug, name = sys.argv[1], sys.argv[2]
cfg = json.load(open('public/config.json'))
cfg.setdefault('salons', []).append({'slug': slug, 'name': name})
json.dump(cfg, open('public/config.json','w'), ensure_ascii=False, indent=2)
PY
echo "  [5/6] добавлен в public/config.json"

# ── 6. Поднять ───────────────────────────────────────────────────────────
docker compose up -d "salon-$SLUG" >/dev/null
docker compose exec nginx nginx -s reload >/dev/null 2>&1 || docker compose restart nginx >/dev/null
echo "  [6/6] контейнер поднят, nginx перечитан"

cat <<EOF

Готово. Дальше:
  1. Панель -> выбрать "$NAME" -> раздел WhatsApp -> отсканировать QR
  2. Панель -> Доступы -> пригласить владельца на салон "$SLUG"
  3. Завести услуги, мастеров и часы работы
EOF
