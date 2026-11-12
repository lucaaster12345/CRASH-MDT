# Architecture

The application uses React and Vite, Express and TypeScript, PostgreSQL with Prisma migrations, Tiptap and Yjs, and a single Hocuspocus authority. HTTP and WebSockets share one listener and the same public origin. Caddy terminates TLS in production. The application uses open-source packages and has no hosted service dependency. [Tiptap](https://github.com/ueberdosis/tiptap) · [Hocuspocus](https://github.com/ueberdosis/hocuspocus) · [Yjs](https://docs.yjs.dev/) · [Prisma PostgreSQL adapter](https://www.prisma.io/docs/orm/overview/databases/postgresql)

## Data and permissions

`Case` holds the human-readable number, lifecycle, lead and restricted flag. Members, tags, case persons, evidence, tasks, documents, related cases and external links reference it. `CasePerson` stores the recorded spelling and case-specific role, with an optional account or profile. Profiles remain unit-visible. Their case appearances use the same case permission check as case search. Disabled accounts remain foreign-key targets for authorship and assignment.

| Role | Authority |
| --- | --- |
| ADMIN | All cases and unit administration. Only mercia manages ADMIN privileges and credentials. |
| INVESTIGATOR | Read unit-visible and explicitly assigned cases, edit working cases, and manage profiles. |
| VIEWER | Read visible records, search, print, and maintain personal pins and saved searches. |

`auth.ts` manages database sessions and CSRF verification. Passwords use Node's scrypt with random salts. Session and one-time credential values are stored as SHA-256 digests of random secrets. Mutation origins and WebSocket origins must match `APP_ORIGIN`. `access.ts` supplies the case filter and transaction boundary. Search repeats that predicate in SQL so visibility is applied before ranking and paging. A role change, disable, reset or revocation ends affected live connections.

Structured case forms send a baseline version. The server validates against the locked case row. Profiles, documents, evidence and tasks have their own version checks. Server-sent events invalidate data for users with access, with a periodic access refresh for open records.

## Documents and storage

Each room name combines a document UUID and an epoch. The server verifies the session and room on connect, then checks each message against current permissions. Hocuspocus read-only connections receive updates but cannot apply edits. Awareness names and colors come from the authenticated account. An in-process case gate orders incoming document messages against lifecycle changes and revision restores.

PostgreSQL holds the canonical Yjs binary update. Empty starter documents are created once with a shared ProseMirror schema. The collaboration server validates document changes and derives searchable text when it commits the update. The editor shows **Saved** when the SHA-256 proof of its Yjs operation clocks and deletion set matches the committed proof returned by the API. The proof remains stable across differences in garbage collection. Remote synchronization can precede that commit. The server retries failed persistence and attempts to flush on shutdown. In-memory edits can reconnect within the same page. No browser-local content recovery is used.

A checkpoint or submission references durable state. A submission stores its own revision and remains available after amendments. Restore preserves the previous durable working version, increments the room epoch and disconnects prior room connections. A database row lock and epoch check prevent an old room from persisting over the restored state.

## Search, URLs and exports

PostgreSQL GIN full-text indexes cover case text and persisted document text. Trigram indexes assist selected name and title searches. Index content changes in the persistence transaction. Case and profile identifier matches appear before broader results. Dates are stored as UTC instants and displayed using `DISPLAY_TIMEZONE`. Date-range filters and timestamp entry use explicitly labeled UTC.

The browser loads approved remote image hosts directly under a restrictive CSP. Source URLs retain query strings and evidence history. No backend requests are made to source hosts. Exports use persisted plain text and evidence references. They omit inaccessible related cases and never include session tokens or canonical binary state.

## Common changes

For a new case field, update the Prisma model and add a migration, then update validation and the read/write projection in `apps/server/cases.ts`, the form in `apps/web/src/case-page.tsx`, and search or export projections as needed. Preserve the version check.

For a document type, add the value to the Prisma enum and shared type list, add its label and seed a template in a migration. Supporting documents use the existing editor and history endpoints. Update the common rich-text schema on both server and client for new editor nodes.

The collaboration server depends on single-instance case gates and live invalidation. Horizontal scaling requires additional coordination.
