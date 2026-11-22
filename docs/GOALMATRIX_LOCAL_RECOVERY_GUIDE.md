# GoalMatrix temporary local-host recovery and database migration

This is an operator guide for a temporary, user-owned machine. It does not change application code, alert rules, providers, database schemas, or production hosting.

## Safety order

1. Identify the authoritative PostgreSQL instance (Aiven or Render) and confirm its status.
2. Confirm that the instance contains the expected GoalMatrix tables and that a usable backup exists, or that a fresh dump can be taken.
3. Create and verify a dump **before** restoring anywhere.
4. Restore into a separate local PostgreSQL database.
5. Run the read-only row-count comparison in `scripts/maintenance/compare-postgres-row-counts.mjs`.
6. Only after validation, consider running the app locally.

Do not run `scripts/maintenance/clear-history-preserve-autonomous-power-rankings.sql`. It deletes history; it is not a backup or migration tool.

## Requirements

- A machine that can remain powered on and awake for the temporary hosting period.
- Node.js 24.18.x (the repository requires Node >=24.18.0 and <25).
- PostgreSQL client tools and a compatible local PostgreSQL server.
- A verified database dump.
- The existing production environment values, entered locally and kept private. Do not commit them or paste them into chat.
- Preserve the existing VAPID public/private keys if push subscriptions are expected to continue working for the same origin. A new public URL/origin normally requires visitors to subscribe to push notifications again.

## Database backup

Do not guess which provider is authoritative. Use the provider's own dashboard to identify the live database first. For Aiven, use its documented CA certificate when TLS verification is required. For Render, confirm that the database is actually accessible before attempting an export.

Keep the connection URI in a local environment variable or a private password manager; never put it in a command history, repository file, screenshot, or chat message. Use a custom-format dump and verify that it can be listed with `pg_restore --list` before proceeding.

Example command pattern (run locally only after confirming the correct source and TLS settings):

```sh
pg_dump --format=custom --no-owner --file=goalmatrix-backup.dump "$SOURCE_DATABASE_URL"
pg_restore --list goalmatrix-backup.dump
```

The dump is not verified until `pg_restore --list` succeeds and its size is plausible. Store a second private copy before any restore or provider changes.

## Local restore

Create a new, empty local database; do not overwrite an existing database. Then restore:

```sh
createdb goalmatrix_recovery
pg_restore --no-owner --dbname=goalmatrix_recovery goalmatrix-backup.dump
```

Use a local `DATABASE_URL` for the app only after the restore completes. Keep the original source database untouched.

## Read-only row-count comparison

The helper `scripts/maintenance/compare-postgres-row-counts.mjs` reads base-table names and executes `COUNT(*)` for each table on both databases. It does not insert, update, delete, create, or alter anything.

Set these variables in the local shell (do not save real values in this document):

- `SOURCE_DATABASE_URL`: the recovered source database.
- `TARGET_DATABASE_URL`: the restored destination database.
- Optional `SOURCE_CA_FILE` and `TARGET_CA_FILE`: paths to PEM CA certificates if the corresponding server requires a custom CA.

Run:

```sh
node scripts/maintenance/compare-postgres-row-counts.mjs
```

A `MATCH` for every table is a useful check, not a complete proof of data integrity. Investigate every `DIFF` before switching the application to the destination.

## Temporary public access

A local server is not an always-on production host. The computer must remain powered on, connected, and awake; a reboot, internet outage, sleep, or process crash stops the live scanner. A tunnel service can expose a local port, but its current eligibility, limits, stable hostname, and account requirements must be checked against the provider's current documentation before relying on it.

Do not publish the local server until authentication, allowed origins/CORS, and the intended public URL have been reviewed. Do not add wildcard CORS as a shortcut. Do not assume a tunnel URL is stable.

## Later migration to paid hosting

1. Create the destination service and managed PostgreSQL only after the budget and plan are approved.
2. Take a fresh dump from the validated local database.
3. Restore into the new, empty managed database.
4. Compare row counts again with the helper script and run application-level read-only checks.
5. Configure the destination environment with the correct secrets, preserving VAPID keys where appropriate.
6. Switch traffic once, then stop the local scanner. Never run two production scanners simultaneously; duplicate notifications and settlements may result.
7. Keep the previous verified dump and source database until the new deployment and history are confirmed.

## Explicit non-goals

- No changes to AI Alerts, VIP Alerts, HI Activity, Power Games, SOT rules, or any other protocol.
- No provider-variable changes.
- No automatic deployment, database mutation, or service reconfiguration.
- No deletion or cleanup of old data.
