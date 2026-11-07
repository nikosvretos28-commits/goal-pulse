# GoalMatrix persistent alert storage — implementation plan

Status: design-only proposal. No application code, alert rules, thresholds, scanners, UI, or deployment changed.

## 1. What the current repository already has

The Node service already depends on `pg` and contains PostgreSQL persistence paths:

- `alert_history`: AI/VIP alert payloads, with a unique alert ID and event/time indexes.
- `high_activity_history`: HI Activity observations and their outcomes.
- `protocol_analyst_reports`: saved analyst reports.
- `live_stat_snapshots`: timestamped cumulative live-stat snapshots used to derive rolling trends.
- `push_subscriptions`: web-push subscriptions.

The service also has in-memory fallbacks (`volatileAlertHistory`, `volatileHighActivityHistory`). The code explicitly documents that these are lost on process restart. Some API responses expose `persistent: false` / `volatile: true`, so a successful HTTP response does not necessarily mean an alert was durably stored.

The connection is configured through `DATABASE_URL` (or compatible PG environment variables). If no valid database URL is available, `analyticsPool` and `highActivityHistoryPool` are null and persistent writes cannot happen.

The repository's current `render.yaml` provisions a Render Free Postgres database. Render's official Free-plan documentation says that Free Postgres is limited to 1 GB, expires 30 days after creation, and has no backups. Free web services also have 750 included instance hours per workspace per month and can be suspended when limits are reached. Therefore this is not a suitable long-term archive.

## 2. Candidate providers (checked 2026-11-07)

### Neon Postgres — first candidate for a low-change migration

Official Free-plan information currently lists:
- $0/month.
- 100 CU-hours per project/month.
- 1 GB storage per project (the current official FAQ/search result also describes 1 GB; verify the live dashboard before provisioning).
- 5 GB public network transfer per project/month.
- Compute scales to zero after 5 minutes idle; stored data remains and compute resumes on connection.
- Existing PostgreSQL client compatibility means the current `pg` code and JSONB schema can likely be retained.

Trade-offs:
- The service will have cold-start latency after idle.
- Compute and network limits can suspend access for the remainder of the monthly window when exhausted; this is not data deletion.
- Do not assume a robust long-term backup/restore guarantee on Free. Export periodic logical backups to a separate location if/when an independent backup path is approved.
- Confirm signup/payment-card requirements in the actual account flow before creating anything.

Official source: https://neon.com/docs/introduction/plans
Official free-plan quotas: https://neon.com/docs/introduction/plans#free-plan

### Cloudflare D1 — attractive free storage, but not a drop-in PostgreSQL replacement

Official Workers Free D1 allowances currently list 5 GB total storage, 5 million rows read/day, and 100,000 rows written/day. Cloudflare says D1 will remain available on Workers Free for prototyping/experimentation.

Trade-offs:
- D1 is SQLite-compatible, not PostgreSQL. The existing `pg` pool, JSONB SQL, PostgreSQL-specific upserts/queries, and two-pool setup cannot simply be pointed at D1.
- It would require a separate Worker/API adapter and a carefully tested data-access layer. This is a larger change and should not be mixed with a live alert-protocol change.
- Daily quota exhaustion causes queries to fail until reset; it does not imply data deletion.

Official sources:
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/reference/faq/

### Supabase Postgres — compatible, but less suitable for unattended continuous operation

Official Free plan currently lists 500 MB database storage and 5 GB egress. Free projects can pause after a week of low database activity; the data remains and the project can be restored.

Trade-offs:
- Same PostgreSQL compatibility advantage as Neon.
- 500 MB is smaller than the other candidates.
- Automatic inactivity pause makes unattended availability less predictable.

Official sources:
- https://supabase.com/pricing
- https://supabase.com/docs/guides/platform/free-project-pausing

### Existing Render Free Postgres — do not use as the long-term archive

Official documentation states 1 GB storage, expiry after 30 days, and no backups on Free. It may be acceptable for temporary testing only.

Official source: https://render.com/docs/free

## 3. Recommendation

Prefer Neon Postgres as the first technical candidate because it is the least disruptive fit for the repository's existing PostgreSQL implementation. Keep Cloudflare D1 as a fallback if Neon signup/payment requirements or its free limits do not meet the owner's constraints.

This is a recommendation, not a claim that Neon has already been created or connected. No provider should be provisioned until the owner confirms that the signup flow requires no payment card and accepts the current free quotas.

## 4. Safe implementation sequence

1. Create a separate database project only after owner approval; do not touch Render resources.
2. Add its connection string only as a secret environment variable in a separately approved test environment. Never commit credentials.
3. Run a schema-only initialization and test insert/read/update/delete on synthetic test rows.
4. Verify idempotent upserts and preservation of terminal outcomes (`won`, `lost`, `void`, `push`) when later updates contain pending/null values.
5. Add a storage health check that clearly distinguishes persistent storage from volatile fallback. Never report a volatile save as a durable save. The repository checker first tests connectivity and discovers the expected tables. On a brand-new empty database it reports `connected_schema_pending` without creating tables; the application's existing `ensure*Db()` startup paths remain responsible for schema initialization. Once the core alert and HI tables exist, it runs synthetic insert/read checks inside a transaction and rolls them back. It never retains test rows.
6. Test restart recovery, duplicate alert IDs, pagination, retention, and database-unavailable behavior.
7. Validate alert-history and HI Activity history independently. Do not alter alert generation or settlement logic in this storage-only phase.
8. Only after separate approval, open a code PR for the persistence adapter and test suite. Keep the current protocols and live service unchanged until the owner explicitly approves merge/deploy.

## 5. Evaluation dataset and reporting

Persist the exact alert-time snapshot separately from later settlement fields:
- stable alert ID, event ID, alert type/level, timestamp, match clock and score;
- provider/source and freshness timestamp;
- the exact stats snapshot already supplied to the alert record (preserve SOT-only meaning; do not derive or substitute total shots);
- market and odds only when present;
- outcome status, settlement timestamp, final score and the predeclared settlement rule.

Evaluation must be read-only with respect to live protocol logic. Report sample size, pending count, wins/losses/voids, precision/success rate with denominators, and segments by period/league/market only when sample sizes are sufficient. Never convert small samples into confident recommendations. Any protocol recommendation remains advisory and requires explicit owner approval.

## 6. Explicit non-goals and safety boundary

This proposal does not change:
- AI Alerts, VIP Alerts, HI Activity, Power Games, thresholds, SOT rules, xG rules, minute windows, odds/market filters, scanners, or alert delivery;
- frontend, branding, logos, photos, or user-facing copy;
- Render, Railway, or any live environment variables;
- deployment, billing, paid services, or provider provisioning.

The current draft PR is documentation plus a safe diagnostic script only. It does not connect Neon, initialize the database, or change the live service. The checker recognizes the six tables already created by the application's existing initialization functions (`alert_history`, `high_activity_history`, `protocol_analyst_reports`, `live_stat_snapshots`, `push_subscriptions`, and `pre_match_season_profiles`).
