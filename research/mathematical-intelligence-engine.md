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
