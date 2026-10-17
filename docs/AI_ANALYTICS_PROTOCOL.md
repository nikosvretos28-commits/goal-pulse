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

## 7. Dedicated live-corner alert protocol

Corner alerts are a separate market from goal alerts. A high-pressure phase can raise corner likelihood, but shots, possession or a goal alert must never automatically become a corner alert.

### 7.1 Alert definition and horizon
- Every alert must name its target: **at least one additional corner in the next 5, 10 or 15 minutes**. Do not mix these horizons in one hit-rate figure.
- Use a distinct alert key per match, market, horizon and model version. Apply a market-specific cooldown and suppress duplicate alerts while the same pressure episode continues.
- Distinguish a live in-play alert from a pre-match estimate. Do not issue a live alert for a match whose state or data freshness cannot be verified.

### 7.2 Required live evidence
Use the strongest available evidence, in this order:
1. Timestamped corner events and match clock, to confirm the true event sequence and measure time since the last corner.
2. Recent attacks into the final third/penalty area, crosses, blocked shots, shots from inside the box, clearances and sustained territorial pressure, if the provider supplies these event types.
3. Rolling 5/10-minute changes in shots, shots on target and corners; use the recent corner rate as context, not as a stand-alone trigger.
4. Scoreline, minute, red cards, home/away status and game state, plus the attacking team's historical corners-for and opponent corners-conceded profile, split by home/away and competition where possible.
5. League and match-level baselines with sample sizes and missing-data indicators.

Aggregate possession or a provider's “dangerous attacks” count is supporting evidence only: definitions vary by provider and neither measure proves that a corner is imminent. Do not invent crosses, box entries, blocked shots, or historical rates when absent.

### 7.3 Two-stage trigger
**Stage A — pressure watch:** enter watch state only when the match is live, data is fresh, and at least two independent signals support sustained attacking pressure. Examples include a rise in recent shots/SOT plus an increase in attacks/crosses/blocked shots, or verified box pressure plus a recent corner sequence. A single high full-match total is insufficient.

**Stage B — alert decision:** issue a corner alert only if the target horizon has adequate evidence from a validated model, or from a clearly labelled heuristic while the model is not calibrated. Require:
- at least two independent live signals, with no contradictory stale/missing critical data;
- a score/minute/red-card adjustment where those inputs are available;
- a threshold selected from chronological out-of-sample testing for that horizon and league group;
- a clear confidence label and short explanation listing the observed evidence;
- cooldown and duplicate suppression.

If the provider supplies only aggregate shots, shots on target and corners, use a conservative **“corner pressure” heuristic**, not a claimed probability of the next corner. If recent deltas are unavailable, show “insufficient live data” rather than guessing.

### 7.4 Model and baseline
When enough licensed data is available, estimate the probability of one or more corners in each horizon using time-to-event or discrete-time hazard modelling. Inputs may include:
- recent and match corner rates, time since last corner and corner sequences;
- event-level attacking actions and pressure proxies;
- home/away, minute, score difference, red cards and competition;
- team corners-for and opponent corners-conceded, adjusted for opponent strength;
- data freshness and missingness.

Fit separate horizon outputs or a properly calibrated survival model. Compare against simple league/minute and recent-rate baselines. Avoid leakage by using only information timestamped before the alert. Calibrate per competition only when sample size supports it; otherwise shrink toward a broader baseline.

### 7.5 Outcomes, evaluation and honest reporting
- Store every candidate/issued alert with event ID, issue timestamp, horizon, observed features, data/provider version, rule/model version and threshold.
- Label success only if at least one verified corner occurs after the alert timestamp and within the declared horizon. A corner already taken at or before the alert cannot count.
- If the match feed ends, becomes stale, or the match is abandoned before the horizon completes, label the case **censored/unevaluable**, not a win or loss.
- Report precision, false-alert rate, coverage, lead time and calibration separately for each horizon; include sample size and confidence intervals.
- Do not present a local-device alert history as the site's global history. Do not advertise a hit rate as predictive accuracy until outcomes are persisted and evaluated.

### 7.6 User-facing alert copy
Use concise, evidence-based language, for example:
- **CORNER PRESSURE — WATCH**: “Pressure increased in the last 5 minutes; shots rose and recent attacking actions are sustained. Corner probability not calibrated.”
- **CORNER ALERT — 10 MIN**: show only after the validated threshold is met; display the estimated probability, model version and supporting evidence.
- **INSUFFICIENT DATA**: “Live event data is incomplete/stale; no corner alert issued.”

Never promise a corner, say it is “sure”, or imply betting certainty. Clearly separate measured statistics from model estimates.

### 7.7 Rollout gates
1. Verify that live corner events and timestamps are available and correctly ordered in each target competition.
2. Collect timestamped pre-alert snapshots and verified corner outcomes in persistent storage.
3. Build chronological training/validation/test sets, separated by match and time.
4. Backtest 5/10/15-minute horizons against simple baselines and measure calibration, false alarms and lead time.
5. Start in shadow mode; compare predictions without showing users actionable alerts.
6. Enable user-facing corner alerts only after pre-defined performance and data-coverage gates pass; monitor drift and disable automatically if the feed degrades.

**Current status:** the live pipeline currently exposes aggregate corner totals and rolling corner deltas when available. It does not yet provide a verified event-level corner timeline, persistent alert-outcome labels, a calibrated corner model, or a proven corner-alert hit rate. Therefore, a dedicated heuristic “corner pressure” signal is the honest interim option; a calibrated predictive alert is not yet implemented.
