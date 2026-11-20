# Cloud Alert — isolated implementation plan

Status: independent Cloud-only shadow scanner is wired on this branch. It runs on its own 60-second schedule, reads the read-only live-metrics endpoint, and records qualified candidates to Cloud Alert's own PostgreSQL history. It never calls the push-delivery method. Live evaluation and push activation remain locked; the PR remains draft.

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

## Reconstructed v0.2 trigger values — not source-verified

The values below are retained as provisional evaluator fixtures from prior conversation context. They are not approved for live activation until checked against the original v0.2 source.

| Trigger | Provisional conditions |
|---|---|
| EARLY 1H | Total SOT ≥5; each team ≥2; SOT90 ≥30; balance ≥0.30; R6 ≥1 |
| SUSTAINED 1H | Total SOT ≥10; SOT90 ≥22; balance ≥0.30; R10 ≥2 |
| SUSTAINED-B 2H | Total SOT ≥10; each team ≥4; SOT90 ≥12.5; balance ≥0.35; R10 ≥2 |
| DUAL-A 2H | Each team ≥10; total SOT ≥20; R10 ≥1; SOT90 anchors 32.7 at 55′ and 22.5 at 80′ |

Recalled definitions: T = combined team SOT; SOT90 = 90 × T / elapsed minute; balance = lower team SOT / total SOT; R6/R10 = SOT accumulated in the respective rolling windows. The exact elapsed-minute convention, event construction, treatment of goal-related SOT and DUAL-A behavior outside 55′–80′ remain unverified. The current interpolation and endpoint clamp are provisional and cannot authorize a live DUAL-A signal.

## Independent scanner behavior

1. Runs independently every 60 seconds after server startup; it does not depend on the AI/VIP/HI push-scan timer or its enable flag.
2. Requests `/api/live-metrics` using the current Europe/Athens date. This is a read-only data request; it does not invoke the existing alert evaluator.
3. Rejects stale/unstamped metric responses, incomplete team SOT, missing stats source, HT, extra time and penalties.
4. Requires two monotonic SOT observations at least 10 seconds and no more than 90 seconds apart before treating a sample as confirmed.
5. Uses a measured 9–11.5 minute SOT window for R10 and the Cloud-specific persisted six-minute baseline for R6. Missing windows are not fabricated.
6. Evaluates the isolated pure evaluator and writes qualifying records only through `recordShadowCandidate`.
7. Never calls `processCandidate` or `sendPushToSubscribers`. Push delivery remains unavailable by construction in this scanner.

## Remaining blockers before activation

- Verify the original approved v0.2 source, including all thresholds, metric definitions, exact rolling-window semantics, phase boundaries, DUAL-A behavior outside its anchors, goal/SOT handling and re-alert ordering.
- Validate the independent scanner against real provider fixtures and feed-gap/downward-correction cases.
- Verify that persisted R6 sampling has adequate continuity and that provider revisions cannot create false deltas.
- Implement HT/FT settlement, void/disputed/unverifiable handling and a full append-only audit ledger.
- Review and harden transactional push idempotency, especially delivery retries and the new-goal identity/order requirement.
- Configure and verify persistent PostgreSQL, VAPID and an active subscription only when activation is explicitly approved.
- Run the fresh CI suite and review the full PR diff for isolation.

## Non-goals

- No edits to existing AI/VIP/HI protocols or thresholds.
- No provider-variable changes and no reintroduction of API Sports.
- No merge, deployment, live Cloud Alert evaluation or push activation in this step.
