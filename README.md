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

## Deploy on Render

This is a static site. In the existing Render Static Site service, connect this GitHub repository and branch `main`, set the publish directory to `.`, and leave the build command empty. A push to the connected branch should trigger a deploy if automatic deploys are enabled.

The repository's `render.yaml` declares a service named `goal-pulse`. If an existing Render service uses a different name, verify the service/repository connection before applying the Blueprint so you do not accidentally create a second service.

## Repository

The site entry point is `index.html`. The interface is self-contained; it does not require a package installation or build step.
