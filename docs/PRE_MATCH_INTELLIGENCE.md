# GoalMatrix Pre-Match Intelligence

Status: specification only; historical collection and live integration are not implemented by this document.

## Purpose
Collect historical team context ahead of scheduled fixtures and make it available to both AI Alerts and High Activity when a match becomes live.

## Daily preparation
- Read the day's fixture schedule.
- Resolve stable competition, fixture, and team identifiers.
- Collect completed-match history for each team where available.
- Store normalized profiles separately from live alert history.
- Preserve source, source timestamp, retrieval timestamp, sample size, and confidence.
- Deduplicate fixtures and cache results with explicit freshness rules.

## Team profile
Where sufficient data exists, calculate goals for/against, clean sheets, scoring/conceding time bands, and Over/Under frequencies for 2.5, 3.5, 4.5 and other supported lines. Keep home/away splits only where sample size supports them. Missing values are unknown, never zero.

## Live integration contract
Both AI Alerts and High Activity may consume read-only pre-match context through separate adapters. Historical evidence may strengthen a live market assessment or reduce confidence / veto a specific market when a sufficiently large and reliable sample strongly contradicts it. It must not suppress an entire fixture. Existing live triggers, SOT windows, xG conditions, settlement, and history behavior must remain unchanged.

## Missing history
Record `NO HISTORICAL DATA`. Do not fabricate metrics and do not reject the fixture. Continue with the existing live evaluator only. If only one team has usable history, use that profile and mark the other unavailable.

## Safety and rollout
Fail open to today's live-only behavior on missing, stale, invalid, or unavailable context. Do not activate market vetoes until sample-size and confidence thresholds are calibrated with backtests and shadow observations. No paid provider may be enabled without explicit budget approval. Validate provider coverage and licensing before production collection.