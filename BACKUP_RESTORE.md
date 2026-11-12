# Backup and restore

## Create a backup

From the repository directory on the VPS, run:

```sh
sh scripts/backup.sh
```

For local Compose use `COMPOSE_FILE=compose.yaml sh scripts/backup.sh`. On Windows, use a shell that supports POSIX scripts with access to the Docker CLI. The script creates a private PostgreSQL custom-format dump, checks that PostgreSQL can read its table of contents, and records the successful dump in system health. It captures a consistent database snapshot, including the binary Yjs state, named checkpoints, submitted revisions and audit events. Changes acknowledged after the snapshot belong to a later backup. A case packet omits other records and application state.

Set `BACKUP_DIR` to a restricted path and copy validated dumps to encrypted off-host storage. Example user crontab for a dedicated backup directory, with 14-day local retention:

```cron
25 3 * * * cd /srv/crash-mdt && BACKUP_DIR=/srv/crash-backups sh scripts/backup.sh >> /srv/crash-backup.log 2>&1
40 3 * * * find /srv/crash-backups -maxdepth 1 -type f -name 'crash-*.dump' -mtime +14 -delete
```

Set the retention window to your recovery needs and confirm independent off-host copies before pruning. Dumps contain sensitive records and password hashes. Restrict access to the dumps and logs.

## Restore into a fresh project

Use the same PostgreSQL major version and source compatible with the backup. Restore into a separate Compose project so the existing volume remains available.

```sh
export COMPOSE_PROJECT_NAME=crash-recovery
docker compose -f compose.production.yaml up -d db
sh scripts/restore.sh /secure/path/to/crash-backup.dump
docker compose -f compose.production.yaml up -d --build app
```

Wait for PostgreSQL to become healthy before running restore. The restore refuses a populated public schema, restores in one transaction, then clears sessions and one-time credentials so credentials in a historical dump cannot be reused. The dump contains migration history. On a compatible app, the migration step applies only pending changes.

For a loopback recovery drill, use `compose.yaml` throughout, set `COMPOSE_FILE=compose.yaml` for the script, and choose an unused `LOCAL_PORT`. Confirm sign-in, search for a known case, and open the report and at least one revision. If needed, run the master recovery command against the restored environment. Reissue any unused activation codes. After verifying the isolated recovery, route traffic to that environment deliberately and retain the prior database until the rollback window ends.

For automated verification, set `TEST_PG_BIN` and run `npm test` as described in [LOCAL_SETUP.md](LOCAL_SETUP.md). It dumps the test database, restores into a newly created database, and compares case metadata and decoded Yjs bytes.
