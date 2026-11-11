# GoalMatrix Pressure Hunter — Autonomous Protocol

## Isolation contract
Pressure Hunter is a separate evaluator. It imports no AI/VIP/Hi Activity/Power Games modules, does not mutate their state, does not send their notifications, and does not write to their history stores. This change adds the isolated decision engine and tests only; it does not yet connect the evaluator to the live polling/notification pipeline or add a UI card.

## Mandatory trigger rules
- Live match only; finished, halftime, abandoned, postponed, and cancelled matches are excluded.
- Both teams must have valid cumulative SOT.
- Both rolling windows must be present and fresh: 4.5–8 minutes for the 5-minute sample and 8–13 minutes for the 10-minute sample.
- Basic DUAL_PRESSURE: each team has at least 2 SOT in the last 10 minutes AND at least 1 SOT in the last 5 minutes; match total cumulative SOT is at least 4.
- EXTREME: each team has at least 3 SOT in the last 10 minutes AND at least 2 SOT in the last 5 minutes; match total cumulative SOT is at least 8.

## Supporting metrics
Shots in the Box and Big Chances from the 10-minute window contribute to a 0–15 supporting score only. They can never trigger a signal by themselves. Total shots and shots off target are not read or used.

## Output
`evaluatePressureHunter(input)` returns eligibility, trigger state, level, score, reason, and an evidence snapshot. Missing or stale required data fails closed.

## Not yet activated
Live integration, notification delivery, persistence, deduplication, settlement, and the dashboard card/history are intentionally not wired in this isolated first implementation. They require a separate integration change after confirming the provider's exact rolling-window fields. No existing alert protocol is changed by this PR.
