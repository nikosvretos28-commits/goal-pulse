# Cloud Alert — isolated implementation plan

Status: independent Cloud-only shadow scanner and HT/FT settlement reconciler are wired on this branch. They run on the Cloud-only 60-second schedule, read the read-only live-metrics and scoreboard endpoints, and write only to Cloud Alert-owned PostgreSQL tables. The scanner never calls push delivery; runtime push activation is explicitly locked. The PR remains draft.

## Isolation guarantees

- Cloud Alert has its own scheduler lifecycle, evaluator, persisted SOT snapshots, candidate history and delivery-state tables.
- The scheduler is independent of the existing scheduled AI/VIP/HI push-scan pass.
- The scanner consumes live metrics through a read-only HTTP request. It does not invoke, mutate, or share the existing AI/VIP/HI trigger evaluation or delivery state.
- Existing AI Alerts, VIP Alerts, Hi Activity, Pressure Hunter, Power Ranking, settlement logic and their stored history must remain unchanged.
- No changes to ESPN/Pitch API or any provider variables.
- Cloud Alert shadow candidates are persisted with status `shadow_qualified`; the scanner has no code path to send a push.
- `CLOUD_ALERT_SCANNER_ENABLED=false` disables the independent shadow scheduler. The default is enabled on this feature branch.
- No merge, deploy or production activation is authorized by this implementation step.

## Confirmed product decisions

- Evaluate through both regular halves, including regular-time stoppage time. There is no minute-based exclusion cutoff.
- Extra time and penalty shootouts are outside the regular-match evaluation scope.
- Use shots on target (SOT) only. Never substitute total shots, shots off target or other shot metrics.
- Maximum allowance after a future, separately approved activation: four pushes per match (one initial and one re-alert in each half).
- A re-alert requires a genuinely new qualifying signal after a new goal; repeated polling must not duplicate a notification.

## Cloud Alert v0.2 trigger rules

The four trigger families and numeric conditions below are the recovered v0.2 rules to implement. They are SOT-only: total shots, shots off target and any generic shots field must never be substituted.

| Trigger | Conditions |
|---|---|
| EARLY 1H | Total SOT ≥5; each team ≥2; SOT90 ≥30; balance ≥0.30; R6 ≥1 |
| SUSTAINED 1H | Total SOT ≥10; SOT90 ≥22; balance ≥0.30; R10 ≥2 |
| SUSTAINED-B 2H | Total SOT ≥10; each team ≥4; SOT90 ≥12.5; balance ≥0.35; R10 ≥2 |
| DUAL-A 2H | Each team ≥10; total SOT ≥20; R10 ≥1; SOT90 threshold linearly interpolated from 32.7 at 55′ to 22.5 at 80′ |

Definitions:
- T = home SOT + away SOT.
- SOT90 = 90 × T / elapsed match minute.
- Balance = lower of the two team SOT counts / T (zero when T is zero).
- R6 and R10 = newly accumulated SOT in the rolling six- and ten-minute windows respectively.
- There is no general minute cutoff: evaluate throughout both regular halves, including regular-time stoppage time. Exclude extra time and penalty shootouts.
- DUAL-A is defined by its two anchors and linear interpolation between 55′ and 80′. v0.2 does not define extrapolation or endpoint clamping outside that interval; implementation therefore fails closed outside 55′–80′ rather than inventing a threshold.
- Missing or unreliable rolling-window data may suppress only the trigger that depends on that window; it must not suppress an independently qualifying trigger with its required window available.

## Independent scanner behavior

1. Runs independently every 60 seconds after server startup; it does not depend on the AI/VIP/HI push-scan timer or its enable flag.
2. Requests `/api/live-metrics?scope=cloud-alert` and `/api/scoreboard` using the current Europe/Athens date. Provider data retrieval is reused read-only, but Cloud Alert rolling-window history and settlement ledger are isolated from AI/VIP and HI.
3. Rejects stale/unstamped metric responses, incomplete team SOT, missing stats source, HT, extra time and penalties.
4. Requires two monotonic SOT observations at least 10 seconds and no more than 90 seconds apart before treating a sample as confirmed.
5. Uses a measured 9–11.5 minute SOT window for R10 and the Cloud-specific persisted six-minute baseline for R6. Missing windows are not fabricated.
6. Evaluates the isolated pure evaluator and writes qualifying records only through `recordShadowCandidate`.
7. Reconciles only exact fixture-ID matches from the scoreboard into independent HT/FT settlement records. It captures HT only when an explicit halftime state is observed; if the fixture advances to 2H/FT without an HT capture, it records `unverifiable` rather than inferring a score. FT is settled only from a finished fixture with an explicit final score.
8. Never calls `processCandidate` or `sendPushToSubscribers`; the runtime itself defaults to push-disabled and the server explicitly passes `pushEnabled: false`.

## Settlement ledger contract

- Every 1H signal has separate HT and FT settlement tracks; every 2H signal has an FT track only. Missing results remain `pending` until an explicit event is appended.
- Each immutable signal stores the provider fixture ID, league, rule version (`cloud-alert-v0.2`), minute, score, each team's cumulative SOT, R6/R10 values, SOT90, balance, trigger IDs and statistics source. A verified settlement requires non-negative integer score, provider, provider fixture ID, source and settlement timestamp. A missing HT capture must be recorded as `unverifiable` with an explicit reason; never infer or reconstruct a missed HT score.
- The market line is fixed at signal-time total goals + 0.5. Grade against the relevant HT or FT score; later odds or later signal data must not alter the line.
- Allowed transitions: pending → settled_verified / unverifiable / disputed; settled_verified or unverifiable → disputed; disputed → settled_verified / unverifiable. Corrections append new events and retain their predecessor reference.
- Database trigger rejects UPDATE and DELETE on the settlement event ledger. CSV export includes the audit events; integrity endpoint checks required metadata and predecessor links.
- Write endpoint requires `Authorization: Bearer CLOUD_ALERT_SETTLEMENT_TOKEN`; do not expose or hardcode this secret. No settlement write or push activation is automatic.

## Remaining blockers before activation

- Verify the exact provider event construction and rolling-window sampling semantics against real fixtures, including goal-related SOT treatment and provider corrections. DUAL-A outside 55′–80′ remains deliberately non-qualifying because v0.2 supplies no extrapolation rule.
- Validate the independent scanner against real provider fixtures and feed-gap/downward-correction cases.
- Verify that persisted R6 sampling has adequate continuity and that provider revisions cannot create false deltas.
- A PostgreSQL 16 service-backed CI integration test now exercises schema creation/migrations, immutable signal metadata persistence, verified settlement grading, duplicate writes, dispute/correction chains, audit integrity, and database rejection of UPDATE/TRUNCATE. Production database connectivity, persistence and backup behavior still require verification on the eventual host.
- Settlement history is append-only in application code and protected by a database trigger against UPDATE/DELETE. Corrections require a disputed event followed by a new verified/unverifiable event; prior events remain in the audit chain.
- The settlement write endpoint is locked behind the dedicated `CLOUD_ALERT_SETTLEMENT_TOKEN` bearer secret. Read-only history/current-state, integrity and CSV endpoints are separate from AI/VIP/HI.
- Review and harden transactional push idempotency, especially delivery retries and the new-goal identity/order requirement. Push activation remains disabled; do not call `processCandidate` from the shadow scanner.
- Configure and verify persistent PostgreSQL, VAPID and an active subscription only when activation is explicitly approved.
- Run fresh CI and review the full PR diff for isolation.

## Non-goals

- No edits to existing AI/VIP/HI protocols or thresholds.
- No provider-variable changes and no reintroduction of API Sports.
- No merge, deployment, live Cloud Alert evaluation or push activation in this step.
