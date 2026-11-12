# Workspace behavior

The build brief and [architecture](ARCHITECTURE.md) define role, access, lifecycle, and storage rules. [DESIGN.md](DESIGN.md) defines the visual system.

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Select/Listbox | Native select with shared Field and SelectOptions | This contract | Browser-owned single and multiple select | Keyboard and label inspection |
| Date | Native date and datetime-local inputs with shared Field | This contract | Browser-owned date, UTC instant | Date labels and payloads |
| Form | ActionForm and MultilineInput | This contract | Create, edit and confirm | Browser workflow and API validation |
| Scrollbar | Application stylesheet | DESIGN.md | Workspace and horizontal table regions | Desktop and 390 px browser checks |
| Toast | Workspace status region | This contract | Status and errors | Browser live updates |
| CRUD | Workspace routes and shared API client | ARCHITECTURE.md | Create opens a record, edits stay in context, archives can be restored | Browser and database tests |

The shared table uses semantic column headings and a local overflow region. Searches use server pagination, debounce input, and ignore stale responses. URL paths identify active records. The account's open-record list stores IDs only. Hidden record panels retain scroll and editor state. Tabs ask before discarding pending edits.

The native dialog focuses Cancel for consequential operations, closes on Escape, and restores focus. Forms preserve entered data on errors. Read-only, connecting, pending and permission states use text. Dates are formatted with the configured IANA timezone and a zone label. UTC timestamp inputs identify their timezone.
