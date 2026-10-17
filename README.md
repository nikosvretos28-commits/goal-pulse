# Goal Pulse

Premium dark-themed live football scoreboard prototype.

## Current functionality

- Pulls scoreboard events from ESPN's public soccer scoreboard endpoints for the Premier League, La Liga, Serie A, Bundesliga, Ligue 1 and UEFA Champions League.
- Refreshes the scoreboard automatically every 60 seconds.
- Shows live, upcoming and completed events when the feed provides them.
- Includes league filters and team/league search.
- Does not invent scores or show fabricated AI predictions.

## Important limitations

The scoreboard depends on ESPN's public endpoints, which are not a guaranteed commercial data API and may be unavailable or incomplete. If a league endpoint returns no events, the site shows an honest empty state. This connection does not provide the detailed live match statistics, xG, event timeline or pressure-wave data needed for full match analysis. AI signals are intentionally disabled until verified statistics and a validated prediction model are connected.

## Deploy on Render

This is a static site. In the existing Render Static Site service, connect this GitHub repository and branch `main`, set the publish directory to `.`, and leave the build command empty. A push to the connected branch should trigger a deploy if automatic deploys are enabled.

The repository's `render.yaml` declares a service named `goal-pulse`. If an existing Render service uses a different name, verify the service/repository connection before applying the Blueprint so you do not accidentally create a second service.

## Repository

The site entry point is `index.html`. The interface is self-contained; it does not require a package installation or build step.
