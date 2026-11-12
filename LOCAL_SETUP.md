# Local setup

## Docker Compose

Copy `.env.example` to `.env`. Keep `LOCAL_PORT=8080` or choose another unused port. Use a unique hex password for PostgreSQL. Run `docker compose up -d --build`, then follow the bootstrap command in [README.md](README.md).

For PowerShell 7, use a masked prompt and pass the password on standard input.

```powershell
$mdtSecret = Read-Host 'Choose the mercia password' -MaskInput
$mdtSecret | docker compose exec -T app npm run account -- bootstrap
Remove-Variable mdtSecret
```

Open `http://localhost:8080` or the configured port. Use the exact hostname `localhost` because the application verifies the origin. Local Compose publishes the application on loopback. Use `docker compose down` to stop services while retaining the database. Check `docker compose logs migrate app db` if startup stalls.

## Direct Node development

Use Node 24 LTS (24.11 or newer) and PostgreSQL 17. Create a dedicated database. Set `DATABASE_URL`, `APP_ORIGIN=http://localhost:5173`, and `DISPLAY_TIMEZONE` in `.env` or the shell. Use a database account that can apply migrations.

```sh
npm ci
npm run typecheck
npm run migrate
npm run build
```

Bootstrap with the same stdin pattern as the README, replacing the Compose command with `npm run account -- bootstrap`. Run `npm run dev` and `npm run dev:web` in separate terminals and open `http://localhost:5173`. The Vite server proxies API and WebSocket traffic to the local API on port 3000. To exercise the production bundle directly, set `APP_ORIGIN=http://localhost:3000`, stop both dev processes, run `npm run build && npm start`, and browse that origin.

## Two independent sessions

1. Sign in as `mercia`. In Administration, provision two investigator accounts and deliver each code to a separate private browser window or browser profile.
2. Activate each account and create a unit-visible draft case. Open the same main report URL in both sessions.
3. Type into both sessions and check that each sees the other account and both changes. Wait for **Saved** in each session, reload, and check the text.
4. Disconnect one session briefly while leaving its tab open. Type another paragraph, reconnect, and confirm that it appears once in both sessions.
5. Switch a case to Restricted with one investigator assigned. The other investigator should lose access. To test the Viewer role, provision a viewer and open a unit-visible document.

## Automated checks

Create an empty, disposable PostgreSQL database named `crash_mdt_test`. Set both `TEST_DATABASE_URL` and `DATABASE_URL` to its URL and run migrations. Integration tests truncate application tables in that database. Use test accounts only.

```sh
npm run migrate
npm run lint
npm run typecheck
npm run build
npm test
npx playwright install chromium
npm run test:e2e
```

For the native backup drill, set `TEST_PG_BIN` to the directory containing PostgreSQL's `pg_dump` and `pg_restore`. The disposable test account needs permission to create and drop a database. The browser test starts the built backend on port 38509. Integration uses 38507. Set `PLAYWRIGHT_CHANNEL=msedge` if testing with an installed Edge instead of Playwright Chromium. Run suites sequentially when they use the same database. The tests generate fictional records at run time.
