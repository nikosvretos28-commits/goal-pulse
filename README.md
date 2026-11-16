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

1. **Live inputs first:** obtain reliable minute-by-minute shots, shots on target (SOT), xG/xGOT, dangerous attacks, corners, cards, match clock and event updates. The current ESPN scoreboard alone does not provide these signals.
2. **Build a time-stamped historical dataset:** save only information available at the time each alert would have fired, along with the match outcome. Prevent data leakage from final scores or post-match statistics.
3. **Define each alert outcome in advance:** for example, specify whether a goal within the next 10 minutes counts as a hit, how suspended/abandoned matches are handled, and how duplicate alerts are counted.
4. **Backtest chronologically:** train on earlier matches and evaluate on later, unseen matches across leagues and seasons. Compare against simple baselines and report sample size, precision, recall, calibration, and false-alert rate.
5. **Publish honest daily reporting:** show alerts issued, settled outcomes, wins/losses under the declared definition, and a rolling sample size. Never claim 90% (or higher) without reproducible results on a meaningful out-of-sample sample.
6. **Launch in shadow mode first:** generate signals without presenting them as betting recommendations; only consider public alerts after reliability and drift checks pass.

A stated competitor hit rate such as 90% cannot be fairly compared until both systems use the same alert definition, time window, market, settlement rules and sample period. No hit rate is guaranteed.

## GoalMatrix live protocols — code-aligned reference

The rules below document the implementation in the repository. They are separate protocols: AI Alerts and Hi Activity do not share thresholds. The deployed service must be checked independently before claiming that a particular commit is live.

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
2. Cumulative SOT: 20+ combined match SOT by the current eligible minute, in either eligible half.
3. First-half cumulative SOT: 8+ combined match SOT by minute 34.
4. Two-team xG: one team has xG ≥3.50 and the other has xG ≥2.50. Both values must be present.
5. Man Advantage: a recent red card and pressure from the team with the numerical advantage. The implementation requires that team's cumulative SOT ≥4, SOT ≥1 in the last 5 minutes, SOT ≥2 in the last 10 minutes, dangerous attacks ≥3 in the last 5 minutes and ≥10 in the last 10 minutes.

**Integrity and confirmation**
- Each SOT-derived trigger has its own confirmation state; a qualifying SOT trigger must be confirmed by a subsequent provider sample.
- A fixture-wide SOT integrity check also guards against provider regressions.
- The xG trigger is independent of SOT confirmation, but requires both teams' xG values.
- The 8+ combined-SOT trigger is first-half-only. The 20+ combined-SOT trigger uses the eligible first- and second-half windows.
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

### Other analytics and validation

The advanced analytics and dedicated corner-pressure design requirements are documented separately in `docs/AI_ANALYTICS_PROTOCOL.md`. Design aspirations in that document are not proof that the corresponding model, data feed or feature is fully implemented. Do not claim a calibrated prediction or hit rate without persisted outcomes and chronological validation.

## Deployment

Deploy through the hosting provider currently configured by the owner. Verify the connected repository, branch, deployed revision, runtime health, and live-data availability before considering a release complete.

## Repository

The site entry point is `index.html`. The interface is self-contained; it does not require a package installation or build step.
