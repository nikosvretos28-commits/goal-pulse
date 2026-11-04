# GoalMatrix Pre-Match Intelligence

## Mandatory season scope
A team profile must use every completed match available in the current season of that team's own league competition only. Do not use the latest 10 matches, do not mix domestic cups, continental competitions, friendlies, or other leagues, and do not assume one global season boundary. Resolve calendar-year and split-year seasons from the competition's own season metadata where available. Deduplicate by stable fixture ID.

If the source returns only part of the season, report the actual sample and mark coverage PARTIAL or UNKNOWN; never claim full-season coverage without evidence. Missing statistics remain unknown, not zero. If only one team has usable history, use that profile and mark the other unavailable.

## Full-season metrics
For all completed league fixtures in the current season calculate matches included, goals for/against, averages, goal difference, Over/Under rates for 1.5/2.5/3.5/4.5, clean sheets, failed-to-score, and home/away splits where sample sizes support them. Add scoring/conceding time bands only when reliable event-minute data exists. Include competition/season/team identifiers, source, retrieval time, sample size, and coverage.

## Trigger contract
Pre-Match is an additional independent historical-context trigger for AI Alerts and High Activity, not just a display panel. A strong season trend can qualify only when relevant live statistics confirm the live context; it may also strengthen confidence. A robust historical contradiction may veto only its specific market, never the entire fixture. Market vetoes remain shadow-only until validated.

Use separate read-only adapters for AI Alerts and High Activity. Do not change existing live trigger expressions, thresholds, time windows, dispatch guards, settlement, or history behavior. Missing, stale, invalid, or insufficient history means NO HISTORICAL DATA and the existing live-only evaluation continues unchanged.

## Data and rollout safety
Use already configured free data sources; no paid provider or new cost without explicit approval. Cache by competition and season, deduplicate requests, and persist profiles separately from live alert history only where a supported database is configured. Report unavailable persistence honestly. Test league-only filtering, full-season coverage, calendar/split-year boundaries, partial source data, one-sided history, missing data, and duplicate fixtures. Keep market vetoes in shadow/backtest mode until calibrated.

The existing live protocols are protected. Pre-Match is added alongside them and must not replace or rewrite them.
