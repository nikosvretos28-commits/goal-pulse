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

## Data-integrity requirements

- Preserve provider identity, source timestamp, match ID, period, and team-level SOT values for every evaluation snapshot.
- Do not infer or fabricate intermediate SOT events when snapshots are missing.
- If a provider revision decreases SOT unexpectedly, or the feed is stale/ambiguous, hold evaluation until the data is trustworthy; do not turn uncertain data into a push.
- Distinguish a quiet match (unchanged statistics) from a failed or stale provider feed.
- Do not assume that a goal is included in or excluded from provider SOT totals without evidence about that provider's definition.
- Keep SOT rolling windows valid only when their underlying snapshots support the window calculation.

## Trigger configuration — verification required

The exact numeric v0.2 trigger thresholds and formal definitions (including balance, SOT-per-90, rolling windows, phase boundaries, and re-alert strength/deduplication rules) must be checked against the original approved v0.2 source before implementation. Values recalled from conversation are not sufficient authority. Do not guess, tune, or silently substitute thresholds.

Until that verification is complete:
- Keep trigger evaluation disabled.
- Do not send push notifications.
- Do not integrate with the production scanner or shared push pipeline.

## Isolated implementation sequence

1. Verify the authoritative v0.2 trigger specification and translate every metric into explicit, testable definitions.
2. Implement a pure, standalone evaluator with no production imports or side effects.
3. Implement a per-match/per-half notification state machine enforcing the four-push allowance and idempotency.
4. Add audit events for qualifying, sent, duplicate-suppressed, and data-quality-held candidates.
5. Add unit tests for half transitions, stoppage time, no minute cutoff, SOT-only inputs, missing snapshots, downward corrections, repeated polling, re-alert eligibility, and the four-notification maximum.
6. Run the isolated test suite and review the diff for accidental changes to existing protocols.
7. Only after review, propose a separate integration PR. Production activation and deployment require explicit approval.

## Non-goals

- No edits to existing alert protocols or thresholds.
- No changes to ESPN/Pitch API or any provider variables.
- No changes to shared database schemas, server routes, workers, or push infrastructure during the isolated evaluator stage.
- No merge, deploy, or production activation as part of this preparation.
