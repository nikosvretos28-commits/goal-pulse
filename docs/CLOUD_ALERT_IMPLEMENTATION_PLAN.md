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
2. Requests `/api/live-metrics?scope=cloud-alert` using the current Europe/Athens date. Provider data retrieval is reused, but Cloud Alert rolling-window history is isolated from AI/VIP and HI.
3. Rejects stale/unstamped metric responses, incomplete team SOT, missing stats source, HT, extra time and penalties.
4. Requires two monotonic SOT observations at least 10 seconds and no more than 90 seconds apart before treating a sample as confirmed.
5. Uses a measured 9–11.5 minute SOT window for R10 and the Cloud-specific persisted six-minute baseline for R6. Missing windows are not fabricated.
6. Evaluates the isolated pure evaluator and writes qualifying records only through `recordShadowCandidate`.
7. Never calls `processCandidate` or `sendPushToSubscribers`. Push delivery remains unavailable by construction in this scanner.

## Remaining blockers before activation

- Verify the exact provider event construction and rolling-window sampling semantics against real fixtures, including goal-related SOT treatment and provider corrections. DUAL-A outside 55′–80′ remains deliberately non-qualifying because v0.2 supplies no extrapolation rule.
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
