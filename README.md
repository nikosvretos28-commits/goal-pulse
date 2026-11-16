# GoalMatrix

24/7 live football intelligence dashboard with a Node.js backend and browser-based interface.

## Repository structure

- `index.html` — GoalMatrix web interface and client-side dashboard.
- `server.js` — Node.js API/backend, live match processing, alert workflows and persistence integrations.
- `ai-minute-window.js`, `ai-trigger-isolation.js`, `sot-integrity.js` — isolated AI minute eligibility, independent trigger selection and SOT integrity helpers.
- `goalmatrix-mcp-server.js` — optional MCP server entry point.
- `docs/` — protocol reference and analytics design documentation.

## Runtime

- Node.js version: `>=24.18.0 <25`.
- Install dependencies with `npm install`.
- Start the service with `npm start` (runs `node server.js`).
- Run the Node test suite with `npm test`.
- The repository also defines `npm run start:mcp` and `npm run test:mcp` for the optional MCP server.

The application uses PostgreSQL and Web Push dependencies. Runtime configuration, provider credentials, database connectivity and push configuration are supplied through the deployment environment; do not commit secrets or local `.env` files.

## Live data and operational limitations

Live match coverage, statistics availability and update frequency depend on the configured providers and their coverage. A match appearing on the scoreboard does not guarantee that every live statistic (including SOT, rolling windows or xG) is available, fresh or supported for that competition. Missing values must not be treated as verified zeroes. Provider corrections and stale/incomplete feeds can affect whether a signal is eligible.

The presence of code for an alert, analytics panel or integration does not by itself prove that the deployed service is running the same commit or that every provider supplies the required data. Verify the deployed revision, runtime health, environment configuration and live feed before describing a feature as operational.

## Alert quality and validation

1. Save the exact timestamped inputs available when each alert is generated; never use later match events or final statistics as pre-alert evidence.
2. Define settlement rules and prediction horizons before evaluating alerts. Handle abandoned, suspended and unverified matches consistently.
3. Evaluate chronologically on unseen matches. Avoid leakage between training and evaluation data.
4. Report sample size, settled/unsettled counts, precision, false-alert rate, calibration and coverage. Split results by market, time window and competition where sample size permits.
5. Keep measured statistics separate from heuristic scores and model probabilities. Do not describe a heuristic as a calibrated probability.
6. Do not claim a hit rate or guaranteed betting outcome without reproducible, appropriately sized evaluation.

## GoalMatrix live protocols — code-aligned reference

The rules below document the implementation in the repository. AI Alerts and Hi Activity are separate protocols with separate criteria. The deployed service must be checked independently before claiming that a particular commit is live.

### Global SOT data rule

- Shot-based protocol inputs use **shots on target (SOT) only**.
- Total shots, shots off target and blocked shots must not be substituted for SOT.
- Rolling 5-/10-minute values must represent changes in SOT, not total-shot attempts.
- Missing data must remain unknown; it must not be fabricated as zero.

### AI Alerts

**Eligible live minute windows**
- First half: 1′–34′.
- Second half: 46′–84′.
- Half-time and completed matches are ineligible.

**Independent triggers (OR logic; any one may qualify):**
1. Recent SOT pressure: 3+ SOT in the rolling last 5 minutes **or** 6+ SOT in the rolling last 10 minutes.
2. Cumulative SOT: 20+ combined match SOT from match minute 1 through 65 (first-half minutes 1–45 and second-half minutes 46–65 only).
3. First-half cumulative SOT: 8+ combined match SOT by minute 34.
4. Two-team xG: one team has xG ≥3.50 and the other has xG ≥2.50. Both values must be present.
5. Man Advantage: a recent red card and pressure from the team with the numerical advantage. The implementation requires that team's cumulative SOT ≥4, SOT ≥1 in the last 5 minutes, SOT ≥2 in the last 10 minutes, dangerous attacks ≥3 in the last 5 minutes and ≥10 in the last 10 minutes.
6. Power Ranking AI alert: an independent Power Ranking score ≥59/100, subject to the same eligible minute windows and match-score availability. It does not depend on the SOT/xG trigger confirmations.
7. Autonomous Power Ranking alert: a separate independent trigger when the Power Ranking score is strictly greater than 65/100 in an eligible window. It has its own per-match/period persistence and re-arming behavior; it is not the same as the 59+ AI alert.

**Integrity and confirmation**
- Each SOT-derived trigger has its own confirmation state; a qualifying SOT trigger must be confirmed by a subsequent provider sample.
- A fixture-wide SOT integrity check also guards against provider regressions.
- The xG trigger is independent of SOT confirmation, but requires both teams' xG values.
- Power Ranking 59+ and Autonomous Power Ranking >65 are separate score-based AI alert paths; they are not SOT thresholds.
- The 8+ combined-SOT trigger is first-half-only. The 20+ combined-SOT trigger is limited to match minutes 1–65: first-half minutes 1–45 and second-half minutes 46–65.
- Do not infer total shots from SOT or use off-target/blocked shots in any trigger.

### Hi Activity — separate protocol

**Eligible live minute windows**
- First half: 1′–34′.
- Second half: 46′–84′.

**Independent qualifying conditions (OR logic; any one may qualify):**
1. First half: 3+ SOT in the rolling last 5 minutes.
2. First half or second half: 6+ SOT in the rolling last 10 minutes.
3. First half by minute 34: 8+ combined match SOT.
4. First half: both teams have xG ≥2.00.
5. Both teams have cumulative SOT ≥4 each, with each team also recording at least 1 SOT in the last 5 minutes and at least 2 SOT in the last 10 minutes.
6. Man Advantage: after a recent red card, the advantaged team has cumulative SOT ≥4, at least 1 SOT in the last 5 minutes, at least 2 SOT in the last 10 minutes, at least 3 dangerous attacks in the last 5 minutes and at least 10 dangerous attacks in the last 10 minutes.

**Additional behavior**
- Hi Activity maintains its own rolling SOT snapshots; it does not depend on the general AI scanner successfully processing the match.
- Inside-box SOT and Big Chances are supporting/ranking context, not standalone Hi Activity triggers.
- Attacks and dangerous attacks do not qualify a match by themselves, except as required components of the Man Advantage condition.
- Missing xG does not qualify the xG condition; it does not convert to zero.
- HI observations are tracked as distinct match/half/minute/score/stat snapshots.

### Pressure Hunter — independent SOT-only protocol

- Pressure Hunter keeps its own two consecutive rolling 8-minute windows within the same half; it does not reuse AI Alerts or Hi Activity rolling state.
- The first 8-minute window qualifies at **2+ combined SOT** from the two teams.
- The signal fires on the **first SOT** recorded in the immediately following 8-minute window.
- Both windows must be valid and fresh. Missing SOT remains unknown and fails closed.
- Total shots, off-target shots and blocked shots are not inputs to Hunter eligibility, thresholds or scoring.

### Other analytics and validation

The advanced analytics and dedicated corner-pressure design requirements are documented separately in `docs/AI_ANALYTICS_PROTOCOL.md`. Design aspirations in that document are not proof that the corresponding model, data feed or feature is fully implemented. Do not claim a calibrated prediction or hit rate without persisted outcomes and chronological validation.

## Deployment

Deploy through the hosting provider currently configured by the owner. Verify the connected repository, branch, deployed revision, runtime health, environment configuration and live-data availability before considering a release complete.
