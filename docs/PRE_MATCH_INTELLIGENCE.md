# GoalMatrix Pre-Match Intelligence

## Season scope
- Build profiles from all completed fixtures returned for the current season of each team's own league competition.
- European split-year competitions use the current season window (1 August through 31 July); calendar-year competitions use 1 January through 31 December.
- The source request is league-scoped. Cup, continental and friendly fixtures are not deliberately mixed into the league scoreboard request.
- Deduplicate fixtures by stable ESPN event ID.
- Record the season key, league, source, fixture count, team sample size and retrieval time.
- Missing or unavailable provider data remains unknown; it is never converted to zero. The UI must not claim full coverage when the provider returns no usable season fixtures.

## Profile metrics
For each team, calculate matches, goals for/against and averages, clean sheets, failed-to-score, home/away match counts, and Over rates for 1.5, 2.5, 3.5 and 4.5 goals. Profiles are keyed by league, season and normalized team name. They are stored in the separate `pre_match_season_profiles` table when the existing PostgreSQL connection is available, with an in-memory fallback when it is not.

## Data source and collection
Use ESPN's public, unauthenticated soccer scoreboard endpoint; no paid provider, API key or new subscription is introduced. Collection is automatically scheduled from the existing daily live-scan path for leagues represented in that day's fixtures. Each league-season is refreshed at most once per 12 hours. Collection runs asynchronously and does not delay or gate live scanning. Provider errors leave the existing live-only evaluation unchanged.

The endpoint is an undocumented public feed, not a guaranteed commercial API. Coverage therefore remains provider-dependent and must be reported honestly.

## AI Alerts reinforcement contract
Pre-Match season history is supplementary evidence for AI Alerts only. It is consulted only after a live-pressure candidate already exists and only adds a non-negative support score when the relevant season Over profile is strong. It cannot create an alert independently, change the mandatory live trigger, veto a market, block or suppress a fixture, or reject an alert. Missing profiles contribute zero support and do not change existing live-only evaluation.

High Activity, VIP Alerts, settlement, alert-history records, live windows, SOT/xG thresholds and dispatch guards are not modified by the Pre-Match adapter. The existing AI live qualification expressions remain the qualification basis; historical context only reinforces scoring after live evidence is present.

## Rollout and safety
No paid data source is used. No existing alert history is cleared or rewritten. Pre-Match profiles are stored separately from AI/VIP/HI histories. If persistence or the free provider is unavailable, the application falls back to neutral historical support and continues live evaluation.
