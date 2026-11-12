# GoalMatrix Pressure Hunter — Autonomous Protocol

## Isolation contract
Pressure Hunter has its own evaluator, dedicated live-scan state, push title/tag, PostgreSQL history table, history endpoint, and outcome settlement. It does not write to AI/VIP alert history, Hi Activity history, Power Games state, or AI analyst data. No other protocol's trigger or time limits are changed by this protocol.

## Continuous Shot Flow trigger
- Uses two consecutive rolling 8-minute windows, evaluated within the same half only. First-half samples are never combined with second-half samples.
- In the first 8-minute window, the match must record at least 4 total shots, including at least 2 shots on target (SOT). The remaining shots may be on target or off target; no minimum off-target count is required.
- In the immediately following 8-minute window, the alert is sent on the first observed shot. The second window does not need to accumulate 4 shots or 2 SOT before the alert.
- Existing Hunter minute eligibility boundaries remain unchanged.
- Total shots are read only by the Hunter. Other alert protocols continue using their existing SOT-only logic.

## Data and safety
- Total shots use the provider's total-shots counter when available, otherwise the sum of SOT and off-target counters when both are available.
- Missing or stale rolling-window data fails closed; unknown counts are not treated as zero.
- A dedicated Hunter-only rolling snapshot map keeps the two 8-minute windows separate from other trigger state.
- A per-match/per-level guard and the database primary key prevent duplicate alerts for the same signal.

## Live behavior and history
- A separate `pressure_hunter_history` table stores Hunter-only records.
- `GET /api/hunter/history` returns the dedicated history.
- Push notifications use a Hunter-specific title and tag.
- Each record stores the signal minute, half, score, and scoreline at activation.
- Outcome settlement writes only to `pressure_hunter_history`.

## Output
`evaluatePressureHunter(input)` returns eligibility, trigger state, level, score, reason, and a complete two-window evidence snapshot. Unit tests cover the 8-minute thresholds, first-shot activation, missing/stale data, half-time handling, and isolation assumptions.
