#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 1 ] || [ ! -s "$1" ]; then
  printf '%s\n' 'Usage: COMPOSE_PROJECT_NAME=new-name sh scripts/restore.sh path/to/backup.dump' >&2
  exit 2
fi

compose_file=${COMPOSE_FILE:-compose.production.yaml}
docker compose -f "$compose_file" exec -T db pg_restore --list < "$1" >/dev/null
docker compose -f "$compose_file" exec -T db sh -ec '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  empty=$(psql -X -Aqt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"     -c "SELECT NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = '\''public'\'')")
  if [ "$empty" != t ]; then
    printf "%s\n" "Restore requires a fresh database with an empty public schema." >&2
    exit 1
  fi
  pg_restore --single-transaction --exit-on-error --no-owner --no-privileges     -U "$POSTGRES_USER" -d "$POSTGRES_DB"
  psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"     -c "TRUNCATE TABLE \"Session\", \"Credential\""
' < "$1"
printf '%s\n' 'Restore complete. Reissue unused activation codes and verify cases before switching traffic.'
