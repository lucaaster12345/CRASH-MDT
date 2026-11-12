# Administration

## Protected administrator

Run the bootstrap command in [README.md](README.md) or [DEPLOYMENT.md](DEPLOYMENT.md) once. The command is idempotent and leaves an existing password in place. `mercia` is an administrator with a protected username, status, and role.

For recovery, substitute `recover` for `bootstrap` and supply the new password through stdin. Recovery sets a fresh password, restores the master role and revokes existing sessions. The command also accepts `MASTER_PASSWORD_FILE` when a temporary secret is securely mounted and readable by the container's `node` user. Remove the mount after use.

## Issue and manage accounts

Provision an account with a username, display name, optional callsign, and role. Copy the one-time code before leaving the account panel. The user selects **Activate account or reset password**, enters the code and chooses a password. Activation codes expire after 24 hours. Reset codes expire after one hour. Issuing a new code replaces prior unused codes. Using a reset ends prior sessions.

Administrators can disable and reactivate accounts, reissue codes, and revoke sessions. Disabling retains assignments, authorship and historical activity. Only `mercia` can grant or revoke the administrator role or manage credentials for administrator accounts.

## Cases, tags and templates

- New cases start in Draft. Submit the main incident report with meaningful narrative text before moving the case into a working status. Closing a case requires the current report to be submitted.
- Closed cases are read-only until reopened. Archived cases are read-only and appear when an archive filter is selected. Restoring returns a case to its previous status.
- Tags show case and profile use. Merging moves associations to the destination tag. Deleting removes the tag and its associations.
- Built-in case status keys stay available. A custom status in use needs a replacement before removal. Template changes affect new documents that opt into the starter headings.
- Evidence hosts accept exact public DNS hostnames. Reload browser pages after saving changes so they receive the new content security policy. Review source links before opening them.

## Review

The audit log is searchable by case, action and actor. It records significant changes, including evidence URL replacements and revision actions. Evidence history is an application record of changes and custody notes. Database administrators control the underlying data.

System health shows database reachability and the most recent backup recorded by the backup script. Verify recoverability through a restore drill.
