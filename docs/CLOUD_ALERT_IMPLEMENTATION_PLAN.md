# Cloud Alert — isolated implementation plan

Status: preparation only. This document does not activate alerts or change production.

## Confirmed product decisions

- Cloud Alert is a separate feature. Existing AI Alerts, VIP Alerts, Hi Activity, Pressure Hunter, Power Ranking, settlement logic, provider configuration, and their stored history must remain unchanged.
- Evaluate throughout the full regular match: first half, second half, and their stoppage time. There is no minute-based exclusion cutoff.
- Extra time and penalty shootouts are outside the regular-match evaluation scope.
- Use shots on target (SOT) only for shot-count triggers. Do not substitute total shots, shots off target, or other shot metrics.
- Maximum delivery allowance: four push notifications per match:
  1. One initial notification in the first half.
  2. One re-alert in the first half.
  3. One initial notification in the second half.
  4. One re-alert in the second half.
- The re-alert allowance is one per half, and only when that half's verified re-alert conditions are met. A notification must not be duplicated on repeated polling of the same qualifying state.
- The four-push allowance applies only to Cloud Alert.

## Reconstructed v0.2 trigger values — not source-verified

The following values were recovered from prior conversation context, but the original approved v0.2 specification was not found in the repository or retrieved conversation material. Treat these as provisional until checked against the authoritative source:

| Trigger | Reconstructed conditions |
|---|---|
| EARLY 1H | T ≥ 5; each team ≥ 2; SOT90 ≥ 30; balance ≥ 0.30; R6 ≥ 1 |
| SUSTAINED 1H | T ≥ 10; SOT90 ≥ 22; balance ≥ 0.30; R10 ≥ 2 |
| SUSTAINED-B 2H | T ≥ 10; each team ≥ 4; SOT90 ≥ 12.5; balance ≥ 0.35; R10 ≥ 2 |
| DUAL-A 2H | each team ≥ 10; T ≥ 20; SOT90 threshold anchored at 32.7 at 55' and 22.5 at 80'; R10 ≥ 1 |

Recalled metric definitions: T = total SOT; SOT90 = 90 × T / elapsed minute; balance = minimum team SOT / T; R6/R10 = recent SOT in the respective rolling window. The precise elapsed-minute convention, rolling-window event construction, and whether goal-related SOT are included still require authoritative confirmation.

**DUAL-A boundary behavior is unresolved.** Linear interpolation between the 55' and 80' anchors was implemented as a provisional working assumption. The endpoint clamp (32.7 before 55' and 22.5 after 80') is also provisional and must not be treated as an approved rule. There is no overall minute cutoff: evaluation is intended throughout both regular halves and stoppage time, but the DUAL-A threshold outside its two anchors must be sourced rather than guessed.

## Data-integrity requirements

- Preserve provider identity, source timestamp, match ID, period, and team-level SOT values for every evaluation snapshot.
- Do not infer or fabricate intermediate SOT events when snapshots are missing.
- If a provider revision decreases SOT unexpectedly, or the feed is stale/ambiguous, hold evaluation until the data is trustworthy; do not turn uncertain data into a push.
- Distinguish a quiet match (unchanged statistics) from a failed or stale provider feed.
- Do not assume that a goal is included in or excluded from provider SOT totals without evidence about that provider's definition.
- Keep SOT rolling windows valid only when their underlying snapshots support the window calculation.

## Current isolated evaluator hardening

- Rolling-window inputs are checked independently per trigger, so missing R6 does not suppress an otherwise valid R10 trigger and missing R10 does not suppress EARLY 1H.
- Blank numeric strings are rejected rather than coerced to zero.
- Malformed per-half push state is rejected rather than trusted.
- These changes remain isolated to the standalone evaluator and tests. They do not add a live data source, persistence, delivery, or production integration.

## Still required before integration

- Retrieve and verify the authoritative v0.2 source, including exact thresholds, balance, SOT90 time basis, rolling-window semantics, phase boundaries, DUAL-A boundary behavior, goal/SOT handling, and re-alert event ordering.
- Build verified rolling windows from timestamped snapshots, including gap detection and downward provider corrections.
- Replace the provisional boolean goal-since-last-push input with auditable goal identity/time ordering and a genuinely new qualifying signal.
- Add durable, transactional per-match/per-half idempotency. The current pure state helper is not a database concurrency guarantee.
- Add signal history, settlement, audit events, and endpoints only in a separately reviewed integration stage.
- Define HT/FT settlement, void, disputed, and unverifiable rules from the approved source before implementing them.

Until those items are complete:
- Keep trigger evaluation disabled.
- Do not send push notifications.
- Do not integrate with the production scanner or shared push pipeline.

## Isolated implementation sequence

1. Verify the authoritative v0.2 trigger specification and translate every metric into explicit, testable definitions.
2. Keep the pure, standalone evaluator free of production imports and side effects.
3. Complete and test the per-match/per-half notification state machine.
4. Add audit events for qualifying, sent, duplicate-suppressed, and data-quality-held candidates.
5. Add unit tests for half transitions, stoppage time, no minute cutoff, SOT-only inputs, missing snapshots, downward corrections, repeated polling, re-alert eligibility, and the four-notification maximum.
6. Run the isolated test suite and review the diff for accidental changes to existing protocols.
7. Only after review, propose a separate integration PR. Production activation and deployment require explicit approval.

## Non-goals

- No edits to existing alert protocols or thresholds.
- No changes to ESPN/Pitch API or any provider variables.
- No changes to shared database schemas, server routes, workers, or push infrastructure during the isolated evaluator stage.
- No merge, deploy, or production activation as part of this preparation.
