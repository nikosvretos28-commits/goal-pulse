# Goal Pulse

Premium dark-themed live football scoreboard prototype.

## Current functionality

- Pulls scoreboard events from ESPN's public soccer scoreboard endpoints for 18 selected competitions: Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Primeira Liga, Eredivisie, Scottish Premiership, Greek Super League, Süper Lig, Brasileirão, Liga Profesional Argentina, MLS, Liga MX, A-League, Champions League, Europa League and Conference League.
- Refreshes the scoreboard automatically every 60 seconds and provides date navigation.
- Shows live, upcoming and completed events when the feed provides them.
- Includes league shortcuts, status filters, team/league search, and clear loading/error/empty states.
- Match analysis modal can show provider-supplied xG, xGOT, shot totals, available team statistics, event timeline and pressure/momentum curve for completed matches when the provider has data.
- Does not invent scores or show fabricated AI predictions.

## Important limitations

The scoreboard depends on ESPN's public endpoints, which are not a guaranteed commercial data API and may be unavailable or incomplete. The list of selected competitions is not the same as guaranteed worldwide coverage; some leagues or matches may be missing. The current scoreboard feed does not provide the complete live match statistics, five-/ten-minute activity filters, or live pressure data needed to match MyGoal247's full live-scanner experience. The PitchAPI integration used for xG/xGOT, event timeline, team stats and momentum is for covered matches and is currently used for post-match analysis; availability varies by match. AI/VIP alerts, hit-rate history, personal scanners, and validated prediction models are not yet implemented and must not be represented as active. A real production launch at worldwide scale requires a reliable licensed live-data feed and a validated alert model.

## Deploy on Render

This is a static site. In the existing Render Static Site service, connect this GitHub repository and branch `main`, set the publish directory to `.`, and leave the build command empty. A push to the connected branch should trigger a deploy if automatic deploys are enabled.

The repository's `render.yaml` declares a service named `goal-pulse`. If an existing Render service uses a different name, verify the service/repository connection before applying the Blueprint so you do not accidentally create a second service.

## Repository

The site entry point is `index.html`. The interface is self-contained; it does not require a package installation or build step.
