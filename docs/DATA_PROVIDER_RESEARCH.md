# Goal Pulse — Football Data Provider Research

Research date: 17 October 2026

## Executive decision

Use a **two-layer data strategy**:

1. Keep the existing scoreboard feed as a temporary no-cost fallback for match discovery and score display. It is not sufficient evidence for a professional-grade analytics product by itself.
2. Before relying on live xG or historical attack/defence profiles, select a documented commercial provider based on a coverage test for the exact leagues Goal Pulse needs. Do not silently mix provider metrics or imply that missing metrics are zero.

No paid provider should be activated without explicit budget approval. A trial should be used to verify coverage and response shape before committing.

## Candidate comparison

| Candidate | Strong use | Important limitation | Indicative published cost / access |
|---|---|---|---|
| Sportmonks Football API + xG add-on | Best match to the desired product when live xG, xGOT, expected points and a pressure index are priorities. Its fixture responses can bundle scores, events, statistics and xG. | xG is a separate add-on; live xG requires the Advanced tier. Coverage varies by league/package and updates can take a few minutes. Validate Greek Super League and each target competition before purchase. | Sportmonks currently lists football plans from €29/month for 5 leagues on its main product page; xG Basic is listed at €15/month paid yearly and xG Advanced at €159/month paid yearly. Prices exclude VAT and can change. |
| API-Football (API-Sports) | A comparatively affordable documented API for livescores, events, lineups, team statistics, fixtures and historical match context. Useful candidate for a broader baseline/statistics layer. | Public product information lists a free tier at 100 requests/day and Pro at $19/month for 7,500 requests/day. The presence of statistics does not by itself guarantee live xG or consistent coverage for every league. Confirm required xG fields, coverage and terms before selection. | Free tier for limited evaluation; published Pro plan $19/month. |
| APIfootball.com | Another alternative for live events and match statistics; published tiers include a limited free plan and paid league coverage. | Separate vendor/product from API-Football (API-Sports); do not confuse their plans or API schemas. Verify required league coverage, xG availability and rate limits. | Its public page lists Free and paid plans; European plan is shown at $21/month. |
| StatsBomb Open Data | Strong for research, event-level analysis and prototyping xT/VAEP or validating feature ideas on the competitions/seasons it publishes. | It is selected historical/open data, not a comprehensive live scoreboard feed. Its terms require attribution for published analysis; review the user agreement and permitted use before redistribution. | Public research dataset, subject to its terms. |
| Current ESPN scoreboard integration | A no-cost fallback for match discovery and scores, with some live aggregate stats available through summary feeds. | Current implementation uses ESPN site feeds, not a documented commercial data contract. Statistics can be absent or inconsistent; it does not provide a dependable historical xG/team-profile foundation. Treat as fallback, not as the source of truth for premium predictions. | No provider subscription currently wired into this path. |

## Source links

- Sportmonks Football API and published plans: https://www.sportmonks.com/football-api/
- Sportmonks xG product and pricing: https://www.sportmonks.com/football-api/xg-data/
- Sportmonks xG endpoint and package-dependent availability: https://docs.sportmonks.com/v3/endpoints-and-entities/endpoints/expected-xg
- Sportmonks xG coverage by league: https://docs.sportmonks.com/v3/tutorials-and-guides/tutorials/expected/coverage
- API-Football official pricing: https://www.api-football.com/
- API-Football fixture/statistics implementation guidance: https://www.api-football.com/news/post/how-to-get-started-with-api-football-the-complete-beginners-guide
- APIfootball.com pricing: https://www.apifootball.com/
- APIfootball.com statistics documentation: https://apifootball.com/documentation/
- StatsBomb Open Data repository and terms: https://github.com/hudl/open-data

## Required provider acceptance test

Before selecting a provider, run a small test matrix across the Greek Super League, Premier League, La Liga, Serie A, Bundesliga, Ligue 1, UEFA competitions and a lower-coverage league:

1. Match identity and score correctness; event and score update delay.
2. Live availability and update interval for shots, shots on target, corners, possession, cards and substitutions.
3. xG / npxG / xGOT definitions, update timing and whether values are live or post-match only.
4. Big chances, key passes, xA, shots inside the box and xG conceded availability.
5. At least two seasons of completed fixtures and team statistics for home/away profiles.
6. Request quotas under realistic polling; provider rate limits, cache policy and outage behavior.
7. License terms for public display, caching, derived analytics and commercial use.
8. Stable IDs and explicit missing values; no assumptions that an absent field means zero.

A provider passes only if the required fields exist for the target leagues and the contract permits Goal Pulse's intended public/commercial display. Save a small set of raw anonymized fixtures for regression tests.

## Engineering consequences

- Keep raw provider values, source name, source timestamp, retrieval timestamp and match ID alongside normalized metrics.
- Never blend xG values from different models into one series without labeling model provenance.
- Keep live xG distinct from post-match xG. Sportmonks explicitly distinguishes post-match xG access from real-time access by package.
- Calculate attacking conversion (goals per shot / shot on target) and defensive susceptibility (shots faced, goals conceded per shot on target, xG conceded) from completed match history, not from the current match alone.
- Use sample size and uncertainty; avoid presenting one or two matches as stable team ability.
- Keep separate goal and corner alert models, backtest them chronologically, and publish calibration/false-positive results before calling them reliable predictions.
- Keep the current ESPN feed as fallback only. If a commercial provider is unavailable, reduce analytics confidence or suppress the alert rather than fabricating data.

## Recommendation

For the exact ambition of Goal Pulse—live match context plus chance quality and team attack/defence profiles—**run a short Sportmonks xG Advanced trial first**, but only after checking target-league coverage and actual live responses. It is the clearest documented match for live xG/xGOT and pressure data, but the published price is materially higher. If that cost is not acceptable, evaluate API-Football Pro against the same test matrix and launch with only the fields it demonstrably supplies. Use StatsBomb Open Data for offline research and backtesting, not as the live feed.

This is a research recommendation, not a claim that any paid provider is already connected.