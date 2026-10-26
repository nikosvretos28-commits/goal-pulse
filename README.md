# Goal Pulse

Premium dark-themed live football scoreboard prototype.

## Current functionality

- Pulls scoreboard events from ESPN's public soccer scoreboard endpoints for 18 selected competitions: Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Primeira Liga, Eredivisie, Scottish Premiership, Greek Super League, Süper Lig, Brasileirão, Liga Profesional Argentina, MLS, Liga MX, A-League, Champions League, Europa League and Conference League.
- Refreshes the scoreboard automatically every 60 seconds and provides date navigation.
- Shows live, upcoming and completed events when the feed provides them.
- Includes league shortcuts, status filters, team/league search, and clear loading/error/empty states.
- Match analysis modal can show provider-supplied xG, xGOT, shot totals, available team statistics, event timeline and pressure/momentum curve for completed matches when the provider has data.
- Includes an experimental Alert Lab for transparent, rule-based match monitoring; its context score is not a probability and is not a validated AI prediction.

## Important limitations

The scoreboard depends on ESPN's public endpoints, which are not a guaranteed commercial data API and may be unavailable or incomplete. The list of selected competitions is not the same as guaranteed worldwide coverage; some leagues or matches may be missing. The current scoreboard feed does not provide the complete live match statistics, five-/ten-minute activity filters, or live pressure data needed to match MyGoal247's full live-scanner experience. The PitchAPI integration used for xG/xGOT, event timeline, team stats and momentum is for covered matches and is currently used for post-match analysis; availability varies by match. The Alert Lab is only an experimental rule-based scaffold: it is not a trained AI model, does not establish a hit rate, and must not be marketed as a proven alert system. Full live AI/VIP alerts, hit-rate history, personal scanners, and validated prediction models are not yet implemented. A real production launch at worldwide scale requires a reliable licensed live-data feed and a validated alert model.

## AI alert quality and validation plan

1. **Live inputs first:** obtain reliable minute-by-minute shots, shots on target, xG/xGOT, dangerous attacks, corners, cards, match clock and event updates. The current ESPN scoreboard alone does not provide these signals.
2. **Build a time-stamped historical dataset:** save only information available at the time each alert would have fired, along with the match outcome. Prevent data leakage from final scores or post-match statistics.
3. **Define each alert outcome in advance:** for example, specify whether a goal within the next 10 minutes counts as a hit, how suspended/abandoned matches are handled, and how duplicate alerts are counted.
4. **Backtest chronologically:** train on earlier matches and evaluate on later, unseen matches across leagues and seasons. Compare against simple baselines and report sample size, precision, recall, calibration, and false-alert rate.
5. **Publish honest daily reporting:** show alerts issued, settled outcomes, wins/losses under the declared definition, and a rolling sample size. Never claim 90% (or higher) without reproducible results on a meaningful out-of-sample sample.
6. **Launch in shadow mode first:** generate signals without presenting them as betting recommendations; only consider public alerts after reliability and drift checks pass.

A stated competitor hit rate such as 90% cannot be fairly compared until both systems use the same alert definition, time window, market, settlement rules and sample period. No hit rate is guaranteed.


## Goal Pulse live Over alert protocol (verify deployed revision before claiming operational status)

### Four independent Over-alert triggers
- Eligible minute windows: 1–40 inclusive and 46–88 inclusive; High Activity uses the same windows.
- Any ONE trigger is sufficient:
  1. At least 3 new shots on target (SOT) in the rolling last 5 minutes.
  2. At least 6 new SOT in the rolling last 10 minutes.
  3. At least 10 cumulative SOT by either one team.
  4. Live xG of at least 2.50 for BOTH teams individually.
- These are OR conditions; they are not all required together.
- Do not add the two teams' xG together to reach 2.50. Missing xG is neutral.
- No minimum odds cutoff. Automatic alerts must not use Asian Over markets; Asian Over remains a manual VIP-only option.

### Scanner pipeline
1. **Live Stats / freshness scanner:** validate match identity, clock, score, event timestamps and freshness of each data source. Do not issue alerts from stale or contradictory statistics.
2. **SOT scanner:** calculate rolling 5- and 10-minute SOT windows from timestamped events/statistics and apply the required thresholds.
3. **Dangerous Match scanner:** detect repeated dangerous actions at short intervals, including sequences occurring roughly every minute. Use timestamped shots, SOT, big chances and dangerous attacks only when the provider supplies them. Treat this as an urgency/priority signal that triggers an immediate re-evaluation, not as a replacement for the mandatory SOT gate.
4. **Open Game scanner:** look for rapid transitions, counterattacks and attacks by both teams, rather than possession or pressure by one team alone. Use available event/stat data; do not infer unprovided events.
5. **Rapid Chance scanner:** detect clusters of shots/SOT or high-quality chances within a short 2–3 minute span. This should prompt an immediate re-check of the rolling SOT windows.
6. **Momentum scanner:** distinguish sustained pressure from a short burst and check whether activity is increasing or fading.
7. **Historical team scanner:** use available season/sample data for scoring/conceding, clean sheets/dirty sheets, SOT conversion and goal-time patterns. Historical features are supporting evidence, not automatic vetoes of strong live signals.
8. **Match context / Over selection:** account for current score, match minute, red cards and time remaining; select only a non-Asian Over market that matches the intended goal threshold. No minimum odds cutoff.
9. **Alert validation / duplicate guard:** verify the required SOT gate, eligible minute, fresh data, valid market and absence of an accidental duplicate before publishing.
10. **Re-alert scanner:** allow a new alert on the same match only when fresh data justifies it and a configured cooldown/deduplication rule is satisfied.
11. **Performance and learning scanner:** record time-stamped inputs, alerts and settled outcomes; evaluate performance by window, market and match context using chronological out-of-sample tests. It may recommend protocol changes, but must not change the active rules without explicit user approval.

### Important implementation constraints
- Dangerous/open-game signals can trigger an immediate re-evaluation even between routine refreshes, but alert timing is limited by the live provider's actual update frequency.
- Do not assume a provider exposes per-minute dangerous attacks, shot timestamps, or complete live statistics unless verified.
- Missing xG is not the same as xG = 0.
- Clearly label this as a protocol specification until the scanners, data feed, persistence and alert delivery have been implemented and tested. Do not present it as a live feature or claim a validated hit rate before evidence exists.

## Deployment

Deploy through the hosting provider currently configured by the owner. Verify the connected repository, branch, deployed revision, runtime health, and live-data availability before considering a release complete.

## Repository

The site entry point is `index.html`. The interface is self-contained; it does not require a package installation or build step.
