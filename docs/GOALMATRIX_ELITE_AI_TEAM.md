# GoalMatrix Elite AI Analysis Team

Status: **blueprint / phase 1 only**. This document defines the team architecture and safety contract. It does not claim that the new analysts are active, trained, or already producing reports.

## Mission

Build a coordinated post-match intelligence team that learns from every eligible AI alert outcome, both wins and losses, using only evidence actually retained by GoalMatrix. The team must explain what happened, identify repeatable patterns, quantify uncertainty, and recommend changes for human approval.

## Team structure

The existing **AI Protocol Analyst remains independent and unchanged**. It continues its current alert-history and protocol-performance responsibility.

The new team contains eight specialist analysts and one Chief Analyst:

1. **SOT & Data Integrity Analyst** — validates SOT-only semantics, provider provenance, freshness, missing values, inconsistent totals, and suspicious jumps. It must never substitute total shots or shots off target for SOT.
2. **Trigger Performance Analyst** — attributes outcomes to explicitly stored trigger IDs and support signals; compares individual triggers and combinations. Legacy alerts without attribution remain unattributed; no retrospective guessing.
3. **Timing & Momentum Analyst** — studies alert minute, phase, rolling SOT windows, time since signal, and post-signal event sequence. It distinguishes observed timelines from unavailable timelines.
4. **League Intelligence Analyst** — compares competitions only with adequate sample size and compatible data coverage; reports league-specific uncertainty and avoids raw cross-provider comparisons.
5. **Team Intelligence Analyst** — evaluates team attack/defence profiles, home/away splits, opponent strength and recent form only where completed-match data supports them.
6. **Match Forensics Analyst** — creates an individual post-mortem for every verifiably settled win and loss: trigger-time evidence, score, SOT, available xG/chance data, subsequent events, settlement, and the strongest evidence-supported explanation. Missing evidence is explicitly labelled.
7. **Calibration & Strategy Analyst** — evaluates hit rate, precision, false-positive rate, Brier/log loss and calibration only where the required prediction probabilities and outcomes exist. It reports sample sizes and uncertainty; heuristic scores are never presented as probabilities.
8. **Provider & Latency Intelligence Analyst** — monitors source timestamps, retrieval timestamps, stale/missing statistics, provider disagreements, observed update delay and coverage. It must not claim end-to-end detection latency without comparable timestamps.
9. **Chief Analyst** — checks the specialists' findings for contradictions, merges them into one concise morning report, ranks recommendations by evidence and expected impact, and explicitly identifies insufficient-data areas.

## Required daily report

- Executive summary with reporting window and data coverage.
- One separate forensic record for every eligible settled AI alert: match, league, signal minute/phase, trigger IDs, trigger-time snapshot, outcome, final/period score, evidence after signal, and explanation with confidence/data caveats.
- Wins and losses reviewed symmetrically; no selective analysis.
- Comparisons by trigger, trigger combination, minute band, league, team, and SOT pattern.
- Provider quality and missing-data report.
- Recommendations with: evidence, sample size, expected benefit, risk, affected protocol, and a proposed offline test.
- A clear list of records excluded from evaluation and why (pending, unverified settlement, missing trigger attribution, incomplete snapshot, stale data, etc.).

## Evidence and data contract

Every observation must retain, where available:
- stable match/event ID and team/competition identity;
- source/provider and metric definition;
- provider event timestamp and GoalMatrix retrieval timestamp;
- match minute and period;
- exact SOT values (including team split and rolling window only when actually supplied/calculated from timestamped observations);
- score and red-card/game-state context;
- xG/xGOT/big chances and other metrics only when the source supplies them;
- immutable alert timestamp, trigger IDs, support signals, rule/model version;
- exact pre-alert `statsAtSignal` snapshot;
- independently verified settlement provider, fixture ID, score scope and result.

Do not infer that all historical snapshots contain all fields. Do not reconstruct old minute-by-minute timelines unless source data actually exists. Mark coverage per field and per record. Store new observations asynchronously and in bounded batches so analytics persistence cannot delay the live scanner or push delivery.

## Operating boundaries

- The new team is **post-match/offline analytics only**.
- It does not run inside the live scanner decision path.
- It does not send alerts or push notifications.
- It does not modify AI Alerts, VIP Alerts, HI Activity, Power Ranking, trigger thresholds, SOT rules, settlement, or user-facing live behavior.
- It cannot auto-apply recommendations. Every proposed protocol change requires explicit human approval and a separate reviewed PR.
- It must not call itself self-learning or claim improved accuracy until scheduled collection, evaluation, versioning and out-of-sample validation are demonstrably running.
- It must not require a paid provider or new subscription without explicit budget approval.

## Reliability and release gates

1. Audit the existing alert-history and snapshot schemas and quantify completeness by field.
2. Verify which old records have valid `statsAtSignal`, trigger attribution, verified outcome, competition/team identity and usable timestamps.
3. Confirm whether the connected providers expose historical per-minute statistics; otherwise limit retrospective claims to retained snapshots and start prospective capture.
4. Implement read-only specialist analysis against verified records.
5. Add tests for missing fields, unverified settlements, duplicate alerts, legacy unattributed records, SOT-only enforcement, small samples, and time-zone/day boundaries.
6. Verify that report generation is isolated from live alert execution and has bounded query/runtime costs.
7. Run in shadow/report-only mode, compare results and data coverage, then expose the morning report.
8. Only after those gates pass may the team be described as operational.

## Known current limitations

The current repository contains an existing protocol analyst and persistent alert/snapshot storage. However, the existence of a `statsAtSignal` field does not prove that every historical alert has a complete snapshot. Historical finished fixtures do not prove historical minute-by-minute statistics are available. The exact historical field coverage and provider depth must be measured before promising complete forensic analysis.

## Suggested implementation sequence

- **Phase 1 (this blueprint):** define roles, evidence contract, safety boundaries and release gates.
- **Phase 2:** read-only audit endpoint/report that measures real data completeness without changing existing analytics or live behavior.
- **Phase 3:** specialist analysis modules and deterministic tests, using only fields that pass the audit.
- **Phase 4:** scheduled morning Chief Analyst report, with failure isolation and visible data-coverage status.
- **Phase 5:** prospective asynchronous snapshot enrichment and longitudinal validation, if the existing feed supports it.
