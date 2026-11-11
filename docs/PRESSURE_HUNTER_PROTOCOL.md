# GoalMatrix Pressure Hunter — Autonomous Protocol

## Isolation contract
Pressure Hunter is a separate evaluator with its own live scan decision, push title/tag, PostgreSQL history table, and history endpoint. It does not write to AI/VIP alert history, Hi Activity history, Power Games state, or AI analyst data. Existing alert engines and their rules are not modified.

## Mandatory trigger rules
- Live match only; finished, halftime, abandoned, postponed, and cancelled matches are excluded.
- Both teams must have valid cumulative SOT.
- Both rolling windows must be present and fresh: 4.5–8 minutes for the 5-minute sample and 8–13 minutes for the 10-minute sample.
- Basic DUAL_PRESSURE: each team has at least 2 SOT in the last 10 minutes AND at least 1 SOT in the last 5 minutes; match total cumulative SOT is at least 4.
- EXTREME: each team has at least 3 SOT in the last 10 minutes AND at least 2 SOT in the last 5 minutes; match total cumulative SOT is at least 8.

## Supporting metrics
Provider-mapped Shots in the Box and Big Chances from the rolling 10-minute window contribute to the 0–15 supporting score only. They can never trigger a signal by themselves. The parser does not substitute Shots on Target Inside Box for Shots in the Box. Total shots and shots off target are not read by the Hunter evaluator.

## Live behavior
- The background live scanner evaluates Pressure Hunter independently of AI/VIP qualification.
- A separate `pressure_hunter_history` table stores Hunter-only records.
- `GET /api/hunter/history` returns the dedicated history.
- Push notifications use a Hunter-specific title and tag.
- A per-match/per-level guard and the database primary key prevent repeated alerts for the same signal.
- Missing/stale required SOT windows fail closed. If the persistent Hunter history database is unavailable, no push is sent, avoiding an unrecorded alert.

## Output
`evaluatePressureHunter(input)` returns eligibility, trigger state, level, score, reason, and an evidence snapshot. Unit tests cover thresholds, missing/stale data, one-sided pressure, SOT-only activation, and live status handling.

## UI status
The backend live evaluator, dedicated push path, and history API are implemented. A separate dashboard card/history view is not yet included; the existing alert UI is untouched.
