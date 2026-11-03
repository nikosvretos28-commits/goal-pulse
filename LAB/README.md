# GoalMatrix LAB

Status: foundation branch created; isolated runtime is NOT deployed yet.
Last updated: 2026-11-02

## Purpose

A separate research and protocol-testing environment for GoalMatrix. The LAB exists to evaluate ideas using real historical/live-observation data without risking the production site.

## Non-negotiable isolation rules

- Do not deploy LAB changes to production.
- Do not modify production AI Alerts, Hi Activity, VIP, scanners, scheduled tasks, notifications, settings, branding, or data.
- Do not send push notifications from LAB.
- Use a separate database/storage namespace and separate credentials when runtime infrastructure is added.
- Production data may be read only where access is explicitly configured; never write to production storage.
- No protocol experiment is promoted without historical validation and the user's explicit approval.

## Research data model

Maintain separate levels:

1. Country / competition profile
   - Matches sampled and date range
   - Goals for, goals against, total goals per match
   - Over 1.5, Over 2.5, BTTS rates
   - Data-provider match coverage and statistics availability

2. Team profile within each competition
   - Goals scored/conceded per match
   - Over 1.5, Over 2.5 and BTTS rates
   - Home/away splits
   - Recent form, with sample size shown
   - Live-statistics coverage and freshness

3. Current-season dataset
   - Stored separately from previous seasons
   - Include season identifier, competition, team, match date, sample size and last-updated timestamp
   - Older seasons may be used as supplementary context when the current-season sample is insufficient; never silently mix them into current-season rates.

## Competition coverage audit

Audit every configured competition in three separate stages:
1. Configured in the application.
2. Scoreboard provider returns the expected fixtures/live matches.
3. Statistics provider maps the competition and returns the required match statistics.

A configured competition is not considered healthy merely because its code exists. Record missing mappings, unsupported competitions, stale/missing statistics, and provider errors separately.

## Protocol experiments

- Begin in read-only / shadow mode.
- Preserve current production protocol definitions as immutable baselines.
- Evaluate candidate rules against the same match samples and time-of-information constraints.
- Record both accepted and rejected candidates, exact reasons, missing/stale data, and settled outcomes.
- Avoid data leakage: only use information available at the time the simulated alert would have fired.
- Report sample size and uncertainty; do not rank a competition or team from a tiny sample.
- Compare precision, recall where measurable, false positives, missed opportunities, and coverage.

## AI Auditor — future requirement

A future read-only auditor should trace:
provider data -> freshness/validity -> rolling statistics and xG -> protocol checks -> decision -> persistence -> delivery status -> settlement.

It should explain every acceptance/rejection and report evidence-based findings. Desired report cadence: every 3 days. This is a future requirement only; do not replace, edit, or disable any of the three existing scheduled tasks.

## Current implementation status (2026-11-02)

- Added a standalone LAB page at `/LAB/index.html` with two separate cards/tabs: **LATE GOALS INTELLIGENCE** and **AI ALERTS — EXPERIMENTAL**.
- Added pure, isolated rule evaluators in `LAB/protocol-engine.js`; these can evaluate timestamped JSON snapshots without importing or mutating production scanner code.
- The AI evaluator includes the frozen SOT/xG reference checks, the full-match Over 3.5 historical gate (**strictly above 3.00**, not equal to 3.00), and the exact-line first-half historical filter (both below 65% rejects; otherwise continues, with 80%+ marked strong).
- Missing historical inputs remain pending/unavailable rather than being treated as zero or passed.
- The Late Goals evaluator is descriptive only and keeps referee context non-triggering.

**Important limitation:** this is the first functional LAB evaluator interface, not yet a live-running analysis service. The page currently accepts explicit JSON snapshots; no live/historical provider adapter, isolated LAB database, scheduled collector, or automatic shadow history is connected. Do not describe the protocols as live until those components are configured and verified in a separate LAB runtime. Production remains untouched.

## Initial research priorities (2026-11-02)

1. Audit the configured competition list and identify which competitions actually return fixtures.
2. Audit statistics-provider mapping and required-stat availability, especially SOT and rolling 5/10-minute data relevant to Hi Activity.
3. Only after coverage is understood, rank competitions by goal production and data reliability.
4. Build team-level profiles so a high-scoring team in a lower-average league is not unfairly downgraded.
5. Produce a first-day snapshot for 2026-11-02 if the necessary source data is accessible.

## Decision log

- 2026-11-02: User approved creating a separate GoalMatrix LAB foundation.
- 2026-11-02: Competition evaluation must be both competition-level and team-level.
- 2026-11-02: Current-season data must be stored separately from historical seasons.
- 2026-11-02: Production remains untouched; all protocol experiments begin in LAB.
- 2026-11-02: Existing three scheduled tasks must remain unchanged.
- 2026-11-02: A three-day AI Auditor report is a future requirement, not an active scheduled task.


## Live games connection — 2026-11-03

- Added `LAB/server.js`, a separate read-only Node service for the LAB.
- Live scoreboard source: public ESPN soccer scoreboard endpoints, polled on request and cached for 25 seconds.
- Competition coverage is an explicit allowlist in the LAB adapter. Unsupported competitions may not appear; per-competition failures are surfaced in the response.
- Match detail requests retrieve only statistics explicitly supplied by ESPN. Missing values remain unavailable; rolling 5/10-minute SOT, Big Chances, shots inside the box and xGOT are not fabricated or inferred.
- The LAB page now includes a live-games panel and per-match statistics view.
- The API serves the LAB page itself and exposes `/health`, `/api/live-games`, and `/api/match-stats`.
- Separate Render service: `goalmatrix-lab-api` (free plan, Frankfurt), branch `lab-live-games-espn-adapter`. This is independent of `goalmatrix-live`.
- No production credentials, production APIs, production database, or production scanners are used. No writes, pushes, or bets.
- The free instance may sleep when idle; the first request after inactivity can take longer. ESPN coverage and stat completeness are not guaranteed.

**Status:** the isolated live scoreboard adapter and dashboard are deployed to the LAB API service. This is an initial public-feed integration, not a validated high-accuracy commercial data feed. Before relying on xG or complete statistics, run the documented provider acceptance test and obtain explicit approval for any paid provider.
