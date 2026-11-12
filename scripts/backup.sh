#!/bin/sh
set -eu
umask 077

compose_file=${COMPOSE_FILE:-compose.production.yaml}
out=${BACKUP_DIR:-backups}
mkdir -p -- "$out"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
name="crash-$stamp-$$.dump"
tmp=$(mktemp "$out/.partial.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT HUP INT TERM

docker compose -f "$compose_file" exec -T db sh -ec '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges
' > "$tmp"
test -s "$tmp"
docker compose -f "$compose_file" exec -T db pg_restore --list < "$tmp" >/dev/null
mv -- "$tmp" "$out/$name"
docker compose -f "$compose_file" exec -T db sh -ec '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  psql -X -v ON_ERROR_STOP=1 -v backup_file="$1" -U "$POSTGRES_USER" -d "$POSTGRES_DB"
' sh "$name" <<'SQL'
INSERT INTO "Setting" ("key", "value")
VALUES ('lastBackup', jsonb_build_object('at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'file', :'backup_file'))
ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value";
SQL
printf '%s\n' "$out/$name"
