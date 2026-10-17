# Goal Pulse AI — Advanced Football Analytics Protocol

Status: **design and implementation requirements**. This document defines what the system must use; it does not claim that every metric is already implemented or available from the current data provider.

## 1. Non-negotiable principles

1. **Evidence before alerts.** Never manufacture missing values, infer unavailable xG, or present a proxy as a provider-measured metric.
2. **Separate observation from prediction.** Show observed match statistics separately from model-derived estimates and confidence.
3. **Context matters.** Adjust for scoreline, minute, home/away, red cards, opponent strength, competition, and game state where the feed supports them.
4. **Sample-size awareness.** Shrink noisy team rates toward league/competition baselines; show sample size and reduce confidence for small samples.
5. **Evaluate outcomes honestly.** Keep immutable alert timestamps, pre-alert features, prediction horizon, and observed outcome. Report calibration and false alarms, not only a flattering hit rate.
6. **Provider provenance.** Store provider, metric definition, timestamp, match ID, and freshness for each data point. Do not silently combine incompatible providers or xG models.

## 2. Metric hierarchy

### A. Chance creation and quality
- Goals, total shots, shots on target, shots inside the box, big chances created/missed, key passes, assists and expected assists (xA), where supplied.
- Expected goals (xG), non-penalty xG (npxG), xG per shot, and set-piece/open-play xG when available.
- Post-shot xG / xG on target (PSxG/xGOT) to distinguish chance creation from shot placement; never substitute it for pre-shot xG.
- Chance-creation rates per 90 minutes and per possession/attack where the necessary denominator exists.
- Track rolling match windows and season-level rates separately.

### B. Attacking conversion
- Goals per shot and goals per shot on target, alongside xG and xG per shot.
- Compare actual goals with xG over a meaningful sample; do not label a short finishing streak as stable skill.
- Split open play and set pieces when the feed supports the distinction.

### C. Defensive vulnerability (the inverse view)
- Shots and shots on target faced per match; goals conceded per shot faced and per shot on target faced.
- xG conceded and big chances conceded, plus opponent chance quality.
- Goals conceded relative to xG conceded; goalkeeper shot-stopping via PSxG faced only if supplied.
- Interpret ratios with zero denominators and small samples safely; never divide by zero or imply certainty from a clean sheet in one match.

### D. Possession value and progression
- Expected Threat (xT) for carries/passes that move the ball into more dangerous areas.
- VAEP / action-value models to estimate how actions change the probability of scoring or conceding.
- These require event-level actions and consistent action definitions; they cannot be derived reliably from a feed containing only aggregate shots/corners/possession.
- Tracking-based measures (pressure, player/space positioning, defensive line, speed) require actual tracking data and must remain disabled without it.

### E. Live match state
- Current score, minute, red cards, shots/SOT, corners, possession, attacks and recent event sequence when supplied.
- Change over rolling windows (e.g. last 5/10/15 minutes) rather than only full-match totals.
- Pressure is a time-series signal, not a synonym for possession or a single dangerous-attack count.
- Goal and corner alerts must use separate calibrated models; evidence for one market must not automatically trigger another.

## 3. Team profile and historical baseline

For each team, maintain separate home/away and competition-aware profiles:
- recent form with recency weighting;
- chances created, xG, shots/SOT and conversion;
- chances and xG conceded, shots/SOT faced and defensive vulnerability;
- opponent strength and red-card/game-state context;
- sample size, data coverage and uncertainty.

Use a sensible league prior / shrinkage for sparse samples. Do not compare raw rates across leagues or providers without adjustment. Historical metrics must be sourced from completed matches and persisted; the current live feed alone cannot provide this profile.

## 4. Alert decision protocol

For every candidate alert:
1. Verify match identity, minute, score and data freshness.
2. Check the required metrics exist and are internally consistent.
3. Combine team attack profile, opponent defensive profile, chance quality, recent live momentum and game state.
4. Produce a calibrated probability or a clearly labelled heuristic score. Do not call a heuristic a probability.
5. Require multiple independent signals where appropriate, apply cooldowns, and suppress alerts on stale/insufficient data.
6. Explain the main supporting evidence and show missing-data caveats.
7. Save the exact pre-alert feature snapshot and later outcome so the alert can be evaluated without hindsight.

## 5. Validation and improvement loop

- Use chronological train/validation/test splits; avoid leakage from future match events.
- Benchmark against simple baselines (league average, current score/minute, shots/SOT-only).
- Evaluate Brier score, log loss, calibration, precision/recall, false-positive rate, lead time and coverage, split by league, market and prediction horizon.
- Keep model/data versions and roll back changes that degrade out-of-sample performance.
- Do not claim that the AI learns or improves daily until data collection, scheduled evaluation, versioning and deployment are actually running.

## 6. Current integration gap to close

The existing live endpoint primarily exposes aggregate live shots, shots on target, corners, possession and dangerous attacks for a limited set of matches. The historical team profiles, persistent match/event history, live xG/big-chance/xA data and event-level feeds required for the full protocol are **not yet reliably wired into the current live alert pipeline**. Some xG/xGOT and event analytics are available through a separate provider path for completed matches, subject to provider coverage and configuration.

Implementation priority:
1. Confirm provider licensing, definitions, live coverage, historical depth, rate limits and costs.
2. Add persistent storage for match/team/event observations and alert outcomes.
3. Normalize provider data and retain provenance/freshness.
4. Implement team profiles and uncertainty-aware baselines.
5. Integrate chance-quality and defensive metrics where the provider actually supplies them.
6. Add xT/VAEP only after reliable event-level data is available.
7. Backtest and calibrate each alert market before describing it as predictive.

## Reference methods

- Expected Goals (xG) and post-shot xG (PSxG): shot-quality estimation before and after the shot.
- Expected Threat (xT): values ball progression into dangerous areas.
- VAEP: values on-ball actions by their change in scoring/conceding probabilities.
- Tracking-based metrics: use only when validated player/ball tracking is actually available.

These methods are complementary, not interchangeable. Use the most informative method supported by the data, rather than selecting a sophisticated name for data that is not present.
