# GoalMatrix Pressure Hunter — Autonomous Protocol

## Isolation contract
Pressure Hunter is a separate evaluator with its own live scan decision, push title/tag, PostgreSQL history table, history endpoint, and outcome settlement. It does not write to AI/VIP alert history, Hi Activity history, Power Games state, or AI analyst data. Existing alert engines and their rules are not modified.

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

## Automatic outcome settlement
- Each new signal stores the verified live score snapshot at activation.
- After a fixture is finished, settlement requires a uniquely matched completed fixture and a provider fixture ID.
- A higher final match-goal total than the signal-time total confirms the signal; an unchanged total does not confirm it.
- Missing signal-time score, missing provider identity, ambiguous fixture matching, or a score correction that lowers the total leaves the record pending.
- The result is written only to `pressure_hunter_history`; it does not touch any other protocol's history.

## Output
`evaluatePressureHunter(input)` returns eligibility, trigger state, level, score, reason, and an evidence snapshot. `settlePressureHunterRecord(record, fixture)` grades the goal-after-signal outcome. Unit tests cover thresholds, missing/stale data, one-sided pressure, SOT-only activation, live status handling, and settlement safeguards.

## Dashboard
The standalone PRESSURE HUNTER panel reads only `GET /api/hunter/history` and displays the independent history and outcome.
