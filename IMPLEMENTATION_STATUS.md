# Implementation status

- [x] Accounts, protected master bootstrap and recovery, issued activation/reset credentials, sessions, CSRF and role enforcement.
- [x] Case numbers, lifecycle, assigned officers, restricted membership, persons, civilian profiles and linked cases.
- [x] Yjs collaboration, authenticated awareness, durable save confirmation, submitted incident-report revisions, checkpoints and restore.
- [x] Supporting documents, external document links, evidence references and custody notes, tasks and case history.
- [x] PostgreSQL search and filters, dashboard lists, pinned cases, saved searches, workspace tabs and direct routes.
- [x] Account, tag, status, template and evidence-host administration, audit search, print layout and JSON case packets.
- [x] Pinned local and production Compose configuration, Caddy, migrations and backup/restore scripts.
- [x] Source build, lint, type checks, database integration and browser verification.
- [ ] Docker Engine runtime and public Ubuntu VPS verification.

## Checks run

| Check | Result |
| --- | --- |
| `npm run lint`, `npm run typecheck`, `npm run build` | Passed on Node 24.22.1. Vite emitted dependency annotation warnings and a size advisory for the lazy-loaded editor. |
| `npm run migrate` | All four migrations applied on fresh PostgreSQL 17.9 databases. An upgrade with legacy fixtures verified that attribution survives account deletion. The Compose files pin PostgreSQL 17.11. |
| `npm test` | Eight integration tests passed with real PostgreSQL and WebSockets, including the backup drill. They exercised secure bootstrap, activation/reset expiry and reuse, CSRF, restricted case projections, read-only WebSocket access, simultaneous writes, reconnect, abrupt restart, restore, revocation, lifecycle, evidence, tasks, search, suspect charge snapshots, account security, and administrator deletion. |
| `npm run test:e2e` | Two scenarios passed in Microsoft Edge, including simultaneous editing with independent authenticated browser contexts. Covered report edits and presence, local undo/redo, durable save, tab and scroll preservation, reload, dialog keyboard focus, a broken image fallback, a long case title and report at 390 px, JSON export, browser-local timestamps, full-width editing, template insertion, charge totals, a subpoena draft, and typed deletion. |
| Native PostgreSQL backup and recovery | A new database restored metadata and identical canonical Yjs bytes. The backup and restore scripts also ran against PostgreSQL with a local Compose command shim. The restore cleared sessions and refused a populated target. |
| Compose and Caddy | Both Compose files passed `config --quiet`. Caddy passed `adapt --validate`. Both shell scripts passed syntax checks. |
| Design and dependencies | The design contract passed the static UI audit. The npm production dependency audit reported zero vulnerabilities when run. |

## Remaining checks and operating limits

- Docker Engine was unavailable on the Windows verification host. Run `docker compose up -d --build` and the local smoke steps in [LOCAL_SETUP.md](LOCAL_SETUP.md) on a Docker host. Follow [DEPLOYMENT.md](DEPLOYMENT.md) to verify container startup, Ubuntu networking, DNS and public HTTPS on the VPS.
- Collaboration was tested with two active editors. There is no VPS load benchmark. The deployment assumes one application instance and starts from a 2-vCPU, 4-GiB sizing estimate.
- The browser verifies per-user undo on a local edit after both sessions synchronize. Undo of overlapping edits to the same initially empty paragraph has limited coverage.
- An editor can reconnect with pending changes while its page stays open. Tab or page closure can discard changes before the database confirms them. The canonical Yjs state limit is 2 MiB per document.
- Browser layout and keyboard checks used Edge at desktop and 390 px. Screen-reader, Safari and Firefox verification remain open.
