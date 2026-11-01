# GoalMatrix Hybrid Mathematical Intelligence Engine
## Research blueprint — isolated from production

**Status:** Research specification only. No production integration, no merge, no deploy.
**Branch:** `research/goalmatrix-mathematical-intelligence-engine`
**Parent work:** Draft MIE research PR #134.
**Purpose:** Evaluate whether a carefully controlled mixture of mathematical models adds predictive value to the transparent MIE baseline.

## 1. Non-negotiable boundary

This research layer must not change or influence AI Alerts, HI Activity, VIP Alerts, their protocols, scanners, data-provider requests, alert delivery, UI, settings, history, or production storage. All experiments run offline on licensed, point-in-time historical data. A future shadow-mode proposal would require a separate review and explicit owner approval.

The hybrid engine is not a betting system and must not turn an unvalidated score into an alert, recommendation, or stake instruction.

## 2. Architecture: specialists plus a gated meta-model

Each specialist produces a small, versioned set of features or a probability estimate, plus a coverage/validity status. The meta-model learns whether and when those outputs add value. It must be possible to disable any specialist independently.

Pipeline:

1. Point-in-time data validation and match-state reconstruction.
2. Specialist feature/model calculations.
3. Per-specialist diagnostics and missingness/coverage flags.
4. Meta-model / stacking layer trained only on out-of-fold predictions.
5. Probability calibration on a chronological validation partition.
6. One untouched chronological test partition for final evaluation.
7. Explanation report with contributions, uncertainty, sample counts and model versions.

No specialist gets a fixed vote merely because its mathematics is interesting. The meta-model may assign it negligible or zero weight.

## 3. Candidate specialist models

### A. Goal-event intensity: Poisson and dynamic Cox-process family

Estimate home and away goal intensities as functions of information available at time t. Compare a constant-rate Poisson baseline with a state-dependent intensity model. Integrate intensity over the requested horizon. Test over-dispersion and dependence; use a negative-binomial or other alternative only if diagnostics justify it.

Outputs: next-5m, next-10m and before-FT goal probabilities; optional team-specific expected goals with uncertainty.

### B. Sequential Bayesian updating

Update estimates as timestamped events arrive. Start from a documented prior (competition/time band and team-strength information available before kickoff) and update using only events observed so far. Compare against a non-Bayesian baseline. Prior strength and update assumptions must be fitted on training data, not hand-tuned against test matches.

### C. Markov state transitions

Represent match pressure as empirically defined states, for example: quiet, building, sustained pressure, high-quality chance, post-chance reset. Estimate transition probabilities from timestamped event sequences. State definitions must be reproducible and not depend on future goals. Test whether transition features improve forecasts beyond current cumulative statistics.

### D. Fibonacci / integer-sequence hypotheses — exploratory only

Do not treat Fibonacci numbers (1, 1, 2, 3, 5, 8, 13, 21, 34...) as inherently predictive. Test narrow, pre-registered hypotheses such as:
- whether inter-event waiting times or bursts have distributions that differ around selected Fibonacci-sized minute/count windows;
- whether Fibonacci-window aggregation captures useful recency structure compared with equal-sized and randomly selected control windows;
- whether any apparent effect survives correction for the many windows and patterns examined.

The key comparison is against matched control windows and the existing recency features. If it does not improve chronological out-of-sample Brier score/log loss and calibration, discard it.

### E. Golden-ratio / scale-ratio hypotheses — exploratory only

The golden ratio (approximately 1.618) is a candidate numerical transform, not a football law. Only test a clearly defined feature with a plausible mechanism (for example, ratios of two measured time scales or pressure phases). Compare it with ordinary ratios, log-ratios, and flexible spline features. Do not search many arbitrary ratios and report only the winner.

### F. Number 7 / modular and periodic features — exploratory only

Test selected seven-minute windows, seven-event sequences, or modulo-7 time features only as pre-specified hypotheses. Compare against 5-, 6-, 8-, 9- and randomly chosen windows, plus a no-periodicity baseline. Correct for multiple testing. A pattern that appears only after trying many numbers is likely selection noise.

### G. Entropy and information theory

Measure diversity and concentration of event types, transition uncertainty, and changes in event-sequence entropy. Entropy may describe whether play is becoming more varied or predictable; it does not itself imply a goal is imminent. Use only event feeds with sufficient completeness and consistent event definitions.

### H. Temporal signal / spectral analysis

Explore autocorrelation and frequency-domain features of timestamped pressure/event series. Require adequate sampling cadence and duration; irregular event streams must be handled explicitly rather than treated as evenly sampled. Compare with simple rolling-rate and recency features. Avoid interpreting noise as a cycle.

### I. Nonlinear dynamics / change-point detection

Test whether pressure series contain statistically supported regime changes (acceleration, decay, abrupt shifts). Use robust change-point methods and validate detection latency. Do not label ordinary match randomness as deterministic chaos; chaos claims require evidence of suitable data length, sampling and stability.

### J. Machine-learning meta-model

Start with transparent regularized logistic regression or a similarly interpretable model over specialist outputs. Consider a more flexible model only if the data volume supports it. Train the stacker using out-of-fold predictions generated within the training period; never train it on in-sample specialist predictions. Calibration remains a separate chronological validation step.

## 4. Candidate features and output contract

For every specialist:
- feature/model name and version;
- value or probability;
- source timestamps and data age;
- coverage / missingness;
- validity status and reason;
- training period and sample count, where applicable.

For the combined model:
- P(goal in next 5m), P(goal in next 10m), P(goal before FT);
- optional expected remaining goals by team only after validated count-model work;
- calibrated / uncalibrated / unavailable status;
- positive and negative explanatory factors;
- uncertainty, data coverage, sample count, model version;
- specialist ablation results showing what changes when each specialist is removed.

No calibrated probability is shown if calibration or sample-size gates fail.

## 5. Experimental protocol

1. Freeze hypotheses and features before opening the test set.
2. Use licensed data with true point-in-time snapshots or timestamped event streams. Never substitute final match totals for what was known at time t.
3. Split by match and chronologically. Keep all snapshots from one match in one partition.
4. Generate specialist predictions out-of-fold inside the training period.
5. Fit the meta-model on those out-of-fold predictions only.
6. Fit calibration on validation data only.
7. Open the test partition once for final comparison.
8. Report Brier score, log loss, reliability curves, calibration slope/intercept, coverage, confidence intervals and sample counts.
9. Compare against time-band/league-rate, Poisson, and current MIE v0.2 baselines.
10. Run ablations, subgroup checks (minute, score state, competition, red cards, provider) and sensitivity analysis.
11. Apply multiple-testing correction to exploratory Fibonacci, golden-ratio, number-7, periodicity and nonlinear-dynamics experiments.
12. Repeat across later time periods / competitions before considering shadow mode.

A candidate advances only if it adds stable, reproducible, held-out value and does not materially damage calibration or coverage. Statistical significance alone is insufficient; effect size and uncertainty must be reported.

## 6. Specific anti-patterns to reject

- Assigning mystical or privileged predictive power to 7, Fibonacci numbers, or φ.
- Selecting the best-looking sequence after testing dozens or hundreds of alternatives without correction.
- Using the same match in both training and test through different snapshots.
- Building meta-model training data from in-sample specialist predictions.
- Using future goals, final totals, post-match corrections or future event timestamps in features.
- Counting correlated versions of SOT, shots, xG and pressure as independent evidence.
- Claiming calibrated probabilities from synthetic fixtures or tiny samples.
- Treating a high model score as proof of causation or a guaranteed goal.

## 7. Build order

**Stage 1 — specification and data readiness:** confirm licensed point-in-time data and event definitions. No new model claims.

**Stage 2 — specialist baselines:** implement Poisson/dynamic intensity, sequential Bayesian update and Markov transitions first, because their assumptions are clearer and easier to test.

**Stage 3 — exploratory mathematics:** implement Fibonacci, golden-ratio, number-7, entropy, spectral and change-point features behind experiment flags, with pre-registered controls and multiple-testing correction.

**Stage 4 — stacking and calibration:** combine only specialist outputs that pass individual checks; use out-of-fold stacking and a separate chronological calibration partition.

**Stage 5 — independent evaluation:** compare all variants with the MIE v0.2 and simple baselines on untouched later matches.

**Stage 6 — shadow-mode proposal:** only after robust improvement, prepare a separate read-only design. No production connection without explicit approval.

## 8. Current limitation and decision

The existing MIE synthetic fixtures validate only the data validator and future-goal label mechanics. They are not training data and cannot demonstrate predictive performance. The current MIE input contract also lacks verified high-frequency event histories for several candidate features.

**Decision:** prepare the hybrid architecture and evaluation protocol now; implement specialist models incrementally only when their required data are available. Keep the entire effort research-only and isolated from the running GoalMatrix.
