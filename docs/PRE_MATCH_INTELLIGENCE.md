# GoalMatrix Pre-Match Intelligence

## Season scope
- Build profiles from all completed fixtures returned for the current season of each team's own league competition. Cup, continental, friendly and national-team competitions are excluded.
- European split-year competitions use the current season window (1 August through 31 July); calendar-year competitions use 1 January through 31 December.
- The source request is league-scoped. Cup, continental and friendly fixtures are not deliberately mixed into the league scoreboard request.
- Deduplicate fixtures by stable ESPN event ID.
- Record the season key, league, source, fixture count, team sample size and retrieval time.
- Missing or unavailable provider data remains unknown; it is never converted to zero. The UI must not claim full coverage when the provider returns no usable season fixtures.

## Profile metrics
For each team, calculate matches, goals for/against and averages, clean sheets, failed-to-score, home/away match counts, and separate Over rates for 0.5, 1.5, 2.5, 3.5, 4.5, 5.5 and 6.5 goals. Also calculate the corresponding league-wide Over rate from the same completed league fixtures. Profiles are keyed by league, season and normalized team name. They are stored in the separate `pre_match_season_profiles` table when the existing PostgreSQL connection is available, with an in-memory fallback when it is not.

## Data source and collection
Use ESPN's public, unauthenticated soccer scoreboard endpoint; no paid provider, API key or new subscription is introduced. Collection requests each calendar month in the exact season window using ESPN's supported `dates=YYYYMM` selector (maximum three requests concurrently), each with an explicit limit of 500 events, then filters by the fixture's ESPN season slug (or season year when the slug is unavailable). ESPN's former `YYYYMMDD-YYYYMMDD` range selector now returns HTTP 400, while month selectors remain supported. This avoids calendar-year responses hitting the 500-event cap because they include multiple seasons. A month that itself reaches the cap fails safely rather than silently accepting a truncated sample. Collection is automatically scheduled from the existing daily live-scan path for leagues represented in that day's fixtures. Each league-season is refreshed at most once per 12 hours. Collection runs asynchronously and does not delay or gate live scanning. Provider errors leave the existing live-only evaluation unchanged.

The endpoint is an undocumented public feed, not a guaranteed commercial API. Coverage therefore remains provider-dependent and must be reported honestly.

## AI Alerts live-trigger additions and reinforcement contract

The additional cumulative live triggers are: (1) at least 10 shots on target by one team, or (2) at least 15 combined shots on target across both teams. Both thresholds count shots on target only and apply through minute 75 inclusive within the existing eligible AI match windows.
Pre-Match season history is supplementary evidence for AI Alerts only. It is consulted only after a live-pressure candidate already exists and only adds a non-negative support score when the relevant season Over profile is strong. It cannot create an alert independently, change the mandatory live trigger, veto a market, block or suppress a fixture, or reject an alert. Missing profiles contribute zero support and do not change existing live-only evaluation.

High Activity, VIP Alerts, settlement, alert-history records, live windows, SOT/xG thresholds and dispatch guards are not modified by the Pre-Match adapter. The existing AI live qualification expressions remain the qualification basis; historical context only reinforces scoring after live evidence is present.

## Rollout and safety
No paid data source is used. No existing alert history is cleared or rewritten. Pre-Match profiles are stored separately from AI/VIP/HI histories. If persistence or the free provider is unavailable, the application falls back to neutral historical support and continues live evaluation.


## Late Over Intelligence — historical qualification gate

Late Over Intelligence is a separate feature and must not modify or veto AI Alerts, VIP Alerts, HI Activity, Power Games, or their settlement rules.

- Evaluate the exact Over line being considered; never reuse a generic Over percentage for another line.
- Supported lines are 0.5 through 6.5 in 1.0 increments.
- A team can qualify the historical gate only with at least 15 completed matches in the current season, a team-specific success rate of at least 65% for that exact line, and a rate no lower than the matching league-wide rate.
- At least one of the two teams must qualify. If neither qualifies, reject that Late Over candidate regardless of live pressure.
- Missing profile, missing exact-line rate, insufficient sample, or missing league baseline fails closed for this feature. It must not be treated as 0% or as a pass.
- Historical qualification is only a gate; it never creates a live alert without independent live SOT confirmation and a feasible remaining-time/goal requirement.
- These Late Over rules are not applied to existing AI/VIP/HI protocols.
