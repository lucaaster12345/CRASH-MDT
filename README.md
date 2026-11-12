# C.R.A.S.H. MDT

C.R.A.S.H. (Community Resources Against Street Hooligans) is a self-hosted workspace for investigators. It supports issued accounts, restricted cases, concurrent incident reports and supporting documents, case evidence references, tasks, civilian profiles, search, and print or JSON case packets.

## Run locally

Install Docker with Compose v2. Copy `.env.example` to `.env` and set `DB_PASSWORD` to a random hex string of at least 48 characters.

```sh
docker compose up -d --build
docker compose ps
```

Create the protected `mercia` administrator once. In Bash, enter a password of at least 12 characters when the prompt waits for input.

```sh
read -rs -p 'Choose the mercia password: ' secret; printf '\n'
printf '%s\n' "$secret" | docker compose exec -T app npm run account -- bootstrap
unset secret
```

Open [http://localhost:8080](http://localhost:8080). The database starts with the built-in case statuses and report templates. The bootstrap command creates the only initial account.

## Project structure

| Path | Contents |
| --- | --- |
| `apps/web` | React workspace, structured forms, and collaborative editor |
| `apps/server` | Express API, permissions, audit trail, and Hocuspocus on the same HTTP server |
| `packages/shared` | Validation, labels, and the rich-text schema |
| `prisma` | PostgreSQL schema, baseline migration, settings, and search indexes |
| `scripts` | Compose backup and empty-database restore |
| `tests` | Real database and WebSocket integration tests and browser workflows |

See [local setup](LOCAL_SETUP.md), [Ubuntu deployment](DEPLOYMENT.md), [administration](ADMIN_GUIDE.md), [backup and restore](BACKUP_RESTORE.md), [architecture](ARCHITECTURE.md), and [verification status](IMPLEMENTATION_STATUS.md).
