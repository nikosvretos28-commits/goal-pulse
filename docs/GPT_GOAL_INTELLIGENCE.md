# GPT Goal Intelligence (independent alert)

This module is a separate SOT-only evaluator. It does not alter AI Alerts, VIP Alerts,
HI Activity, Pressure Hunter, Cloud Alert, or any existing settlement logic.

## Live eligibility
- Minute 1 through 130, including first/second-half stoppage and extra time.
- No fixed minute cutoff.
- Finished, abandoned, postponed, and penalty-shootout states are excluded.
- Requires complete cumulative SOT for both teams. Missing values fail closed.

## Triggers
- EXPLOSIVE_5M: 3+ combined SOT in a validated ~5-minute window.
- SUSTAINED_PRESSURE_10M: 4+ combined SOT in a validated ~10-minute window.
- TEAM_DOMINANCE_10M: one team has 6+ cumulative SOT and at least 2 recent SOT.
- TWO_SIDED_THREAT: both teams have 4+ cumulative SOT and recent SOT activity.
- CONTINUOUS_THREAT: 2+ SOT in the short window and 4+ in the medium window.

Points: explosive 4, sustained 3, dominance 3, two-sided 3, continuous 2;
+1 at 8+ cumulative SOT and +1 at 12+. Score is capped at 10.
ACTIVE=4-5, STRONG=6-7, ELITE=8-10.

Rolling windows must be validated and fresh (5m: 4-7m; 10m: 8-12m).
This evaluator is deterministic, not a machine-learning prediction. Its score is
signal strength, not a calibrated probability of a goal.

## Integration safety
This first isolated module is intentionally not wired to push delivery yet. It must
be integrated with its own snapshot buffer, confirmation/deduplication, database
history and settlement before enabling live notifications. Existing alert pipelines
remain untouched.
