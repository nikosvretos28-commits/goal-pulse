# Phase 3 — Offline Elite Analyst Engine

## Scope
This phase adds a deterministic report engine for the eight specialists and Chief Analyst. It consumes only records explicitly supplied by a caller. It is not wired to a route, scheduler, database, scanner, push service, settlement worker, or live protocol.

## Input contract
Records may include `alertId`, `eventId`, `createdAt`, `teams`, `league`, `minute`, `period`, `outcome`, `verifiedScore`, `triggerIds`, `statsAtSignal`, `finalScore`, `scoreScope`, and `settlementProvider`. Only `verifiedScore === true` with outcome `won` or `lost` enters win/loss comparisons.

## Analyst outputs
- SOT & Data Integrity: presence of explicit `onTarget`, `onTarget10m`, `totalOnTarget` fields only.
- Trigger Performance: descriptive counts for explicit trigger IDs; no retrospective attribution.
- Timing & Momentum: minute-band counts only; no invented momentum timeline.
- League Intelligence: descriptive counts, no league ranking from small samples.
- Team Intelligence: explicitly unavailable until historical team-form inputs exist.
- Match Forensics: one compact evidence record per eligible verified win/loss.
- Calibration & Strategy: explicitly unavailable without prediction probabilities.
- Provider & Latency: explicitly unavailable without comparable provider and retrieval timestamps.
- Chief Analyst: concise summary and offline-review recommendations only when a trigger has at least 10 examples.

## Safety
Pure synchronous JavaScript only. No network, filesystem, database, writes, scheduler, notifications, settlement, or live-protocol imports. Generic shots and off-target fields are never read. Recommendations are not applied automatically.

## Tests
Run with the repository's supported Node 24.18.x runtime using `npm test`. This PR must remain draft until tests run in the supported runtime and the input contract is reviewed against actual verified alert records.
