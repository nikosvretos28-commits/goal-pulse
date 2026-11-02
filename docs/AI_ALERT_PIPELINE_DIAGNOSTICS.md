# AI Alerts pipeline diagnostics — read-only plan

## Purpose
Find the exact stage where AI Alerts stop without changing alert eligibility, thresholds, data providers, or delivery behaviour.

## Protected protocol
- Minutes 1–40 only.
- SOT: 3+ in rolling 5 minutes OR 6+ in rolling 10 minutes.
- Independent xG alternative: one team >= 2.50 and the other >= 2.00.
- Missing xG is neutral for an SOT-qualified match.
- No odds floor. Missing verified odds must not block a qualified alert.
- No changes to Hi Activity or VIP.

## Required counters per scanner run
1. Live matches received.
2. Matches with usable stats and two teams.
3. Matches skipped for missing stats/team data.
4. Matches with missing/invalid score.
5. Matches outside minute 1–40.
6. Eligible-minute matches with neither SOT nor xG signal.
7. Protocol-qualified signals.
8. Signals rejected for scoreboard/stat-score disagreement.
9. Signals rejected by per-half cap or cooldown.
10. Qualified alerts persisted successfully / persistence failures.
11. Push attempts / push failures / successful deliveries.
12. Push subscription count and push configuration status.

## Per-match diagnostic sample
For a small capped sample only: event ID, teams, provider, updatedAt/age, minute, score, team SOT, rolling SOT 5m/10m, team xG, signal result, and final rejection stage. Do not log secrets, tokens, or subscriber data.

## Acceptance tests
- SOT 3+/5 qualifies in minutes 1–40 even when xG is missing.
- SOT 6+/10 qualifies in minutes 1–40 even when xG is missing.
- xG 2.50 + 2.00 qualifies independently of missing SOT baselines.
- Minute 41 does not qualify.
- Missing odds do not block a qualified alert.
- A score mismatch is explicitly counted as a rejection.
- A qualified alert is visible in in-app history even if browser push delivery fails.
- Duplicate scanner runs do not create duplicate alerts.

## Rollout
This document is a specification only. Instrumentation must be implemented and tested on a separate branch. No merge, deploy, production configuration change, protocol change, or Hi Activity/VIP change is authorised by this work.
