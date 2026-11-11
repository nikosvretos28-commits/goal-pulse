# GoalMatrix Elite Team — Read-only Data Coverage Audit

## Purpose

Provide the planned Elite AI analysis team with a measured view of the data already retained by GoalMatrix before any analyst is activated. This is a diagnostic endpoint only.

## Endpoint

- Method: `POST`
- Path: `/api/elite-team/data-audit`
- Access: existing private-admin request authorization and allowed-origin checks
- Request body: `{ "pin": "<existing private admin PIN>", "windowDays": 180 }`
- `windowDays` is clamped to 1–180; the audit reads at most the latest 10,000 server-generated AI alert records in that period.

## What it measures

1. Whether `statsAtSignal` was retained on each alert.
2. Explicit SOT coverage from `onTarget`, `onTarget10m`, and `totalOnTarget` only.
3. xG coverage from `xG` and `xGDelta` in the saved signal snapshot.
4. Whether matching `live_stat_snapshots` exist for the same event ID from 15 minutes before to 2 minutes after alert creation.
5. How many matching snapshots actually contain `shots_on_target`, including snapshots observed before the alert.
6. A compact per-trigger coverage summary and up to 50 records with missing SOT/snapshot evidence.

Generic shots, total shots, and off-target fields are intentionally ignored. Zero is treated as a valid recorded statistic; null, empty, and non-numeric values are treated as missing.

## Read-only and safety guarantees

- Uses SELECT queries for the report; it does not update or delete alert history or live snapshots.
- Does not settle or re-settle alerts.
- Does not fetch external provider history.
- Does not modify AI, HI Activity, VIP, Power Ranking, or any other live protocol.
- Does not start, schedule, or activate any Elite analyst.
- The endpoint is protected by the existing private-admin authorization. No credentials are returned in the response.

## Interpretation limits

- Snapshot matching is based on event ID and time proximity, not a provider fixture ID or a team-name reconciliation. It is evidence of retained event-level snapshots, not proof that every team row is correctly mapped.
- xG is not a column in the current `live_stat_snapshots` schema; xG coverage therefore comes only from `statsAtSignal`.
- A snapshot observed after alert creation is counted separately from one observed before it; it must not be treated as pre-alert evidence.
- The sample is capped at 10,000 alerts and the missing-data detail list at 50 records. Aggregate counts cover the returned alert sample.
- This report measures data availability, not alert quality, outcome accuracy, or causal relationships.

## Verification

The pure summarizer is covered by `elite-data-audit.test.js`, including zero-valued SOT, null/missing values, trigger coverage, and a guard that generic shot fields do not count as SOT.
