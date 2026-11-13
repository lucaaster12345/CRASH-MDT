# Ubuntu 24.04 deployment

Use one instance of the application, PostgreSQL and Caddy. Start with 2 vCPUs, 4 GiB RAM and persistent SSD storage. This is a sizing assumption. See [verification status](IMPLEMENTATION_STATUS.md) for tested concurrency.

1. Install Docker Engine and the Compose v2 plugin from the official Ubuntu instructions. Confirm `docker compose version`. [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
2. Point the domain's A record to the server. Publish an AAAA record only if IPv6 reaches the same host. Allow inbound TCP 80 and 443 and keep SSH restricted to your administration sources. Docker publishes ports using its own firewall rules. Check the provider firewall and Docker rules in addition to UFW. [Docker packet filtering](https://docs.docker.com/engine/network/packet-filtering-firewalls/)
3. Copy the source and set `.env` permissions to owner-only. Fill `DOMAIN`, `ACME_EMAIL` and `DB_PASSWORD`. Generate the database password with `openssl rand -hex 32`. Keep secrets out of shell history and version control.
4. From the project directory, start the stack.

```sh
docker compose -f compose.production.yaml config --quiet
docker compose -f compose.production.yaml up -d --build
docker compose -f compose.production.yaml ps
docker compose -f compose.production.yaml logs migrate app caddy
```

The one-shot migration service completes before the app starts. Caddy publishes TCP 80 and 443. PostgreSQL and the app have no published production ports. Caddy obtains and renews HTTPS certificates and proxies WebSocket upgrades to the same service. [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https) and [reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Bootstrap `mercia` once, using a secure password prompt.

```sh
read -rs -p 'Choose the mercia password: ' secret; printf '\n'
printf '%s\n' "$secret" | docker compose -f compose.production.yaml exec -T app npm run account -- bootstrap
unset secret
```

Verify `https://YOUR_DOMAIN/api/health`, sign in over HTTPS and test a document in two sessions. Browser network tools should show the `/collaboration` WebSocket with HTTP 101. Review the origin, cookies, certificate, app and proxy logs if the editor stays Connecting. A 403 from an obsolete document room is expected after a restore or case access change. Refresh case metadata and open the current room.

## Updates and rollback

1. Keep a copy of the current source, image identifier and production configuration.
2. Stop Caddy to pause new traffic. Let investigators confirm **Saved** before maintenance, then stop the app. Run the backup script and retain its validated dump.
3. Install the new source and review the migrations. For an existing deployment, rebuild the image, run the one-shot migration explicitly, then bring the application and proxy back up:

   ```sh
   docker compose -f compose.production.yaml build app
   docker compose -f compose.production.yaml run --rm migrate
   docker compose -f compose.production.yaml up -d
   ```

   Check migration logs, health, login and a two-session document edit.
4. Roll back the application image only if the old version supports the current schema. If it does not, restore the pre-update dump into a fresh Compose project and start the matching earlier source. Verify it before routing traffic to it. Changes made after the backup are outside that rollback point.

## Operations

- Use `docker compose -f compose.production.yaml logs --tail 100 app caddy db` for recent logs. Compose caps each container's log rotation.
- Recover the master password with [the administration guide](ADMIN_GUIDE.md). To revoke other sessions, use Administration.
- Rotate the database password in a maintenance window. Change the existing PostgreSQL role password using `psql` and its interactive `\password crash` command. Then update `.env` and recreate the affected containers. Changing `POSTGRES_PASSWORD` alone does not change a role in an existing volume.
- Keep PostgreSQL, Node and Caddy patch versions current by updating and testing the pinned images before deploying.
- Back up the database and keep a separate, secured copy of the deployment configuration and secrets. Caddy volumes hold certificate and proxy state.
- Keep a single backend instance. Multiple instances would need shared document routing, locks, and invalidation coordination.
