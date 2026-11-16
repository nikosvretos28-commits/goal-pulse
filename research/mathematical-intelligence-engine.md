# GoalMatrix Mathematical Intelligence Engine (MIE)
## Research specification — isolated shadow-mode proposal

**Status:** Research/design only. Not connected to production.
**Branch:** `research/goalmatrix-mathematical-intelligence-engine`
**Primary consumer:** AI Analyst (read-only, advisory output).

## 1. Safety boundary

This first phase must not change or influence:
- AI Alerts, HI Activity, VIP Alerts, their thresholds, eligibility, timing, settlement, or history;
- scanners, data-provider requests, alert delivery, UI, branding, configuration, or production storage;
- any existing match selection or alert decision.

MIE runs offline against historical snapshots first. A later shadow-mode service may calculate outputs in parallel, but those outputs must be ignored by production alert logic until separately reviewed and explicitly approved. No deploy or merge is implied by this document.

## 2. Purpose

Produce calibrated, explainable estimates of match-goal events from information available at a particular match timestamp. MIE is a measurement and research layer, not a betting recommendation engine and not a guarantee of outcomes.

Initial outputs:
- probability of at least one goal in the next 5 minutes;
- probability of at least one goal in the next 10 minutes;
- probability of at least one further goal before full time;
- expected remaining goals for each team;
- data-quality and model-coverage indicators;
- concise factors that influenced the estimate.

The AI Analyst may eventually use these as additional evidence, while retaining its own independent reasoning and existing rules.

## 3. Proposed model: time-aware goal intensity

Use a separate goal-intensity estimate for each team. For team i at timestamp t:

`log(lambda_i(t)) = log(max(remaining_minutes, epsilon) / 90)
                   + beta_0
                   + beta_team_strength
                   + beta_1 * xG_rate_i
                   + beta_2 * SOT_rate_i
                   + beta_3 * big_chance_rate_i
                   + beta_4 * momentum_i
                   + beta_5 * score_state
                   + beta_6 * red_card_balance
                   + beta_7 * competition_context`

Where:
- rates are calculated only from events observed up to t, with exposure/time normalization;
- momentum is a recency-weighted feature, not a raw sum; use a documented decay window and cap extreme values;
- score state and remaining time are explicit because teams change behavior when leading, drawing, or trailing;
- team/competition effects are learned only from training data available before the evaluation period;
- missing values are represented explicitly, never silently converted to zero;
- features with unreliable coverage are omitted or cause a lower coverage flag.

The first implementation should compare a transparent Poisson baseline with a regularized count model. Do not assume xG, SOT, and big chances are independent: inspect feature correlation and use regularization / ablation tests to limit double-counting. If the data does not support a feature, remove it rather than inventing a coefficient.

For a short horizon H, assuming locally constant intensity only as an initial approximation:

`P(goal in next H minutes) = 1 - exp(-(lambda_home + lambda_away) * H)`

For full-time probability, integrate the estimated time-varying intensity over the remaining match rather than extrapolating the current rate blindly. The model must account for stoppage-time uncertainty and avoid claiming precision beyond the data.

## 4. Probability calibration

Raw model scores are not probabilities until calibrated. Evaluate calibration separately by:
- minute bands;
- score state;
- competition / provider coverage where sample sizes permit;
- prediction horizon (5m, 10m, full time).

Use a time-ordered train/validation/test split. Never randomly mix later matches into training for earlier test matches. Candidate calibration methods: logistic/Platt calibration or isotonic regression, selected only on validation data.

Required metrics:
- Brier score;
- log loss;
- reliability/calibration plots;
- observed event rate by probability bucket;
- coverage and sample count for every reported segment.

Always compare against simple baselines (historical league/time-band rate and a basic Poisson model). If MIE does not beat a baseline on held-out data, it does not advance.

## 5. Data quality gate

Every estimate must carry:
- source timestamp and match clock;
- age of the latest statistics snapshot;
- required-field coverage;
- missing/invalid-field count;
- consistency checks (monotonic cumulative stats, plausible clock, valid score);
- a status: `usable`, `degraded`, or `unavailable`.

Stale or inconsistent data must suppress the probability or mark it unavailable; it must not create false confidence. Do not compare provider timing to another site unless timestamps are synchronized and the comparison is measured.

## 6. Explainability contract for AI Analyst

For each estimate, provide a structured explanation:
- horizon and calibrated probability;
- expected remaining goals (with uncertainty/coverage caveat);
- strongest positive and negative contributing factors;
- data freshness / coverage status;
- model version and evaluation sample count.

Do not expose a percentage when calibration or sample-size requirements are not met. Do not convert the estimate into an alert, recommendation, or stake instruction.

## 7. Validation and promotion gates

Phase 0 — inventory historical data and verify timestamp/settlement quality.
Phase 1 — build an offline feature dataset with strict point-in-time correctness.
Phase 2 — fit and evaluate baseline models with time-based holdout.
Phase 3 — calibration, subgroup checks, leakage checks, and ablation tests.
Phase 4 — shadow mode only, with no effect on user-facing alerts.
Phase 5 — review results and obtain explicit approval before any integration.

Promotion requires:
1. no data leakage;
2. improved held-out performance versus baselines;
3. acceptable calibration in adequately sampled segments;
4. stable results across competitions and score states;
5. documented failure modes and a rollback/disable switch;
6. explicit owner approval.

## 8. First engineering tasks

1. Inventory existing match/statistics/history schemas without changing them.
2. Identify whether historical snapshots contain reliable timestamps and final outcomes.
3. Define a read-only adapter from existing data to a versioned MIE input schema.
4. Create deterministic feature calculations with unit tests.
5. Build a reproducible offline evaluation report.
6. Keep all outputs isolated from alert and settlement code.

## 9. Open research questions

- Which competitions have enough reliable historical snapshots?
- Are xG values timestamped snapshots or final/current values overwritten in place?
- Are rolling SOT windows stored historically, or must they be reconstructed from event timestamps?
- How are stoppage time, extra time, red cards, abandoned matches, and provider corrections represented?
- Is there enough historical data to estimate team strength without leakage?

**Decision:** Begin with data inventory and an offline baseline. Do not implement live predictions until historical point-in-time data quality is proven.


## 10. Research findings and model direction (2026-11-01)

Recent statistical literature supports a time-aware event-intensity approach for in-play football rather than treating a live match as a static pre-match forecast:

- Maia et al., *Stochastic modelling of football matches using dynamic regressors*, International Journal of Forecasting 42(2), 2026, DOI: 10.1016/j.ijforecast.2025.10.006. The paper models goals and other match events as Cox processes whose intensities vary with match state and external factors. This supports testing dynamic, state-dependent goal intensity, while its reported coefficients must not be copied as GoalMatrix coefficients.
- *Real-time forecasting within soccer matches through a Bayesian lens*, Journal of the Royal Statistical Society Series A, 2024, DOI: 10.1093/jrsssa/qnad136. This supports sequential updating from time-ordered in-match events and evaluating forecasts at multiple match times.
- The standard Poisson / Dixon–Coles family remains a transparent baseline. More complex models must demonstrate out-of-sample improvement over it rather than being assumed superior.

The first MIE experiment should therefore compare:
1. A simple time-band / league-rate baseline.
2. A transparent Poisson goal-intensity baseline.
3. A dynamic state-dependent intensity model (Cox-process-style / regularized regression).
4. A sequential Bayesian update only if the timestamped event history is sufficiently complete.

The final model is chosen by chronological holdout performance and calibration, not by complexity or attractive live percentages.

## 11. Initial repository data audit — read-only

A source inspection of `server.js` confirms that the existing history tables include:
- `alert_history`: alert ID, event ID, level, creation timestamp and JSON payload;
- `high_activity_history`: observation ID, event ID, creation timestamp and JSON payload;
- `protocol_analyst_reports`: report generation timestamp and JSON report.

The existing AI Analyst reads settled AI-alert payloads and their signal-time statistics for retrospective segment summaries. These are useful for studying the alerts that were actually emitted, but they are not equivalent to a complete minute-by-minute match dataset.

**Current limitation:** an alert-history row is a selected observation, not a full match timeline. It cannot by itself support unbiased estimates for every match-minute or reliable next-5 / next-10-minute probabilities. We must not train a general goal model from alert-only samples because that would introduce selection bias. We also must not substitute final match statistics for live values that were available at the forecast timestamp.

This is a code/schema inspection only. No database was queried, no production data was changed, and no application code was edited.

## 12. Independent MIE input contract

The offline research engine should accept versioned, provider-neutral records with at least:

- `match_id`, competition, season, home/away team IDs;
- `snapshot_at_utc`, provider event timestamp, match minute/second and period;
- score at snapshot, red cards at snapshot, match status;
- per-team cumulative SOT, shots, xG and big chances **as they stood at that timestamp**;
- optional event-level records with event timestamp and event type;
- final outcome / goal timestamps, stored separately as labels and never exposed to feature generation;
- provenance, provider, ingestion timestamp, field coverage and correction/version metadata.

Each row must represent a point-in-time snapshot. A later correction or final value must not overwrite what the model would have known earlier. The dataset builder must enforce a strict cutoff: features at time t can only use information timestamped at or before t; target windows are calculated only from subsequent goal events.

## 13. Next external deliverable

Build the offline data validator and feature-dataset builder as an isolated research component. It should:
- ingest a documented CSV/JSON snapshot format;
- reject duplicate or out-of-order snapshots, impossible clocks, score/stat regressions that cannot be explained by provider corrections, and missing timestamps;
- generate next-5m, next-10m and remaining-match goal labels from later goal events;
- split by match and chronologically, never by randomly mixing snapshots from the same match across train and test;
- emit a data-quality report before any model is fitted.

Do not connect this component to the running GoalMatrix service. Until a legitimate timestamped dataset is available, the correct result is a data-readiness report, not invented model accuracy.


## 14. First executable modelling baseline — 2026-11-01

An isolated standard-library implementation now exists in `research/mie_tools/train_model.py` (baseline v0.2). It is a deliberately transparent first model, not a claim that the final MIE is complete.

### Feature layer

At each snapshot, construct point-in-time features for:
- match time and period;
- current score total and difference;
- red-card total and difference;
- cumulative SOT, shots, xG and big chances, including team differences and time-normalized SOT/xG rates;
- explicit missingness flags for unavailable numeric inputs;
- interactions between score state and match time, red-card balance and time, and shot/xG rates and remaining regulation time.

No feature is sourced from a future event. The current input contract does not contain reliable rolling-window SOT values, so the first baseline must not pretend it can calculate recent 5-minute/10-minute pressure from cumulative totals.

### Baseline and calibration

For each target (goal in next 5 minutes, next 10 minutes, and before full time):
1. Fit L2-regularized logistic regression on the chronological training matches.
2. Fit imputation and standardization statistics on training rows only.
3. Fit a Platt calibration layer on validation matches only, and only when that validation partition contains at least 30 positive and 30 negative examples.
4. Evaluate once on the held-out test matches using Brier score, log loss, constant-prevalence baselines and reliability bins.

The script requires at least 200 training snapshots, at least 30 distinct training matches, and at least 10 distinct matches in each validation and test partition. It requires at least 30 examples of each class for training, calibration and final test scoring. Each match receives equal total weight, so matches with dense snapshot feeds cannot dominate the fit or evaluation. The constant-rate comparator is calculated from training prevalence, never from test outcomes. It reports insufficient data instead of presenting an uncalibrated score as a reliable probability. It refuses to train unless the structural validator reports `validated_structure_only`.

This first model intentionally does not yet estimate expected remaining goals or model the two teams' goal processes separately. Those are later experiments, and must be evaluated against this transparent baseline.

### Further research safeguards

- Validate source row order before sorting; flag out-of-order provider snapshots.
- Reject fractional values for integer match-clock and count fields rather than silently truncating them.
- Preserve same-match grouping across train/validation/test.
- Keep test data closed until final scoring; never tune features or calibration against test outcomes.
- Do not infer rolling pressure from cumulative totals.

### Research references

- Maia et al. (2026), [Stochastic modelling of football matches using dynamic regressors](https://doi.org/10.1016/j.ijforecast.2025.10.006), *International Journal of Forecasting*. Supports testing state-dependent event intensities and dynamic match-state regressors; published coefficients are not transplanted into MIE.
- [Real-time forecasting within soccer matches through a Bayesian lens](https://doi.org/10.1093/jrsssa/qnad136), *Journal of the Royal Statistical Society: Series A* (2024). Supports sequential updates from time-ordered match events.
- Klemp, Wunderlich & Memmert (2021), [In-play forecasting in football using event and positional data](https://doi.org/10.1038/s41598-021-03157-3), *Scientific Reports*. Important counterweight: in-play indicators should be tested for incremental value after controlling for team strength and pre-match expectation, not assumed predictive.
- Clegg, Song & Cartlidge (2026), [A market-calibrated accelerated failure time model for in-play football forecasting](https://doi.org/10.48550/arXiv.2605.16066), arXiv preprint. Useful as a research comparator; its results are not a guarantee and its market inputs/data are not assumed available to GoalMatrix.

**Current status:** implementation and unit tests have been added to the draft research PR. They have not yet been executed in a test environment, and no historical dataset has been fitted. No accuracy claim is made.
