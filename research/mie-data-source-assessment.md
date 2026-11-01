# MIE data-source assessment
## Research-only audit — 2026-11-01

**Scope:** identify lawful public football data that can support offline development of time-aware goal forecasting.
**Boundary:** this document does not authorize production changes, data ingestion into GoalMatrix, model deployment, or any change to AI Alerts, HI Activity, VIP Alerts, scanners, protocols, settings, or history.

## Executive finding

No public source reviewed here has been verified as a large, multi-season archive of frequent, point-in-time live-stat snapshots equivalent to a commercial live-score feed.

There are, however, useful open event datasets with timestamps. They can support event-sequence experiments and reconstruction of selected cumulative features *when the event definitions and coverage permit*. They must not be misrepresented as complete historical snapshots of every statistic available to a live operator.

The immediate research path is therefore:
1. Use open timestamped event data for parser/feature prototypes and limited method benchmarking.
2. Keep the MIE v0.2 snapshot model separate; it requires genuine point-in-time snapshots.
3. Seek a licensed provider archive or explicit research data agreement for large-scale snapshot-based validation.
4. Do not claim predictive performance from synthetic data or tiny public samples.

## Candidate sources

### 1. StatsBomb Open Data
- Format: JSON match, event, lineup and selected 360 files.
- The repository states that selected competitions are freely available for research and genuine football-analytics interest.
- Published/shared research and analysis must attribute StatsBomb and use its logo according to the repository terms.
- Potential use: timestamped event parsing, shot/event-sequence features, event-state reconstruction and reproducible research baselines.
- Limitation: event logs are not a continuous archive of live API snapshots. Verify competition coverage, event fields and current terms before any use or redistribution.
- Official repository: https://github.com/hudl/open-data

### 2. Wyscout public soccer match-event dataset
- The Scientific Data paper describes timestamped spatiotemporal event logs across seven competitions for a season, including passes, shots, fouls and other actions.
- The paper is open access under CC BY 4.0; its metadata files carry a CC0 waiver. Check the dataset record and any third-party exceptions before reuse.
- Potential use: event timing, Markov/state-transition features, event-sequence entropy, waiting-time analysis and limited goal-intensity experiments.
- Limitation: event logs are not repeated live-stat snapshots; verify exact season/competition coverage and available fields before building labels.
- Paper and dataset description: https://pmc.ncbi.nlm.nih.gov/articles/PMC6817871/
- Figshare metadata: https://doi.org/10.6084/m9.figshare.9711164

### 3. DFL integrated event + tracking dataset (2025)
- Seven Bundesliga / 2. Bundesliga matches; 11,137 events and more than one million player/ball tracking frames.
- Event records include ISO-8601 timestamps; the paper describes synchronized event and position data.
- Released with DFL authorization under CC BY 4.0, with attribution requirements.
- Potential use: high-quality parser validation, synchronized event/tracking feature prototypes, entropy and temporal/change-point methods, and benchmarking.
- Limitation: only seven matches, explicitly too small for representative/generalizable predictive claims. It is a benchmark, not a training-scale archive.
- Paper: https://pmc.ncbi.nlm.nih.gov/articles/PMC11787359/
- DOI: https://doi.org/10.1038/s41597-025-04505-y

### 4. Metrica Sports sample data
- Public sample repository documents three anonymized matches with synchronized tracking and event data.
- Potential use: verify event/tracking alignment, prototype spatial and temporal feature extraction.
- Limitation: three matches only; not suitable for estimating general goal probabilities or training the MIE.
- Repository: https://github.com/metrica-sports/sample-data

### 5. Synthetic event-stream samples
- A newly published small sample contains 16 matches between invented clubs and explicitly synthetic/random event generation.
- Potential use: software tests, schema checks and controlled unit tests only.
- Limitation: not real football evidence and not suitable for model fitting, calibration or predictive evaluation.
- Dataset description: https://databasesample.com/datasets/football-match-event-stream

## Fit to MIE research questions

| Research component | Event-log suitability | Important caveat |
|---|---|---|
| Poisson / dynamic intensity | Good for event-time prototypes | Requires enough matches and accurate exposure/time-at-risk |
| Markov transitions | Good | State definitions must use only past/current events |
| Bayesian sequential updates | Good if event order and timestamps are reliable | Prior and update parameters must be trained/validated chronologically |
| Entropy / event diversity | Good | Sensitive to event taxonomy and missing events |
| Change-point detection | Possible | Event streams are irregular; do not assume evenly sampled signals |
| Fibonacci / 7 / golden-ratio hypotheses | Exploratory only | Pre-register windows; compare matched controls; correct multiple testing |
| Tracking-derived pressure/spatial features | DFL/Metrica useful for prototypes | Small samples; provider-specific tracking and event definitions |
| MIE v0.2 cumulative snapshot model | Not sufficient by themselves | Needs true point-in-time stat snapshots, not final totals or selected event rows |

## Data contract and licensing gate

Before accepting any source:
- Record source, dataset version, access date, license/terms, attribution and permitted research/commercial use.
- Preserve raw timestamps, source event timestamps and ingestion timestamps separately.
- Preserve corrections/version history; never overwrite what was known at an earlier forecast time.
- Confirm event completeness and definitions for goals, shots, shots on target, cards, substitutions, periods and stoppage time.
- Derive cumulative values only from events that are actually present and whose definitions match the target statistic.
- Keep final outcomes in a label-only path; never expose them to feature generation.
- Split by match and chronologically; all snapshots/events from a match remain in one partition.
- Do not scrape restricted websites or repurpose data whose terms do not permit model training.

## Recommended next experiment

Start with a small **event-stream research adapter**, not a new predictor:
1. Choose one source after checking its current license and exact fields.
2. Parse match metadata and timestamped events into the MIE's provider-neutral event schema.
3. Generate only event-derived as-of features (e.g. goals, shots/SOT where definitions support it, cards, corners and recent event counts).
4. Add explicit coverage/missingness flags; never invent unavailable xG or rolling stats.
5. Verify event order, timestamps, period transitions, stoppage time and goal labels.
6. Run parser/label tests and report data coverage by match.
7. Only then benchmark event-based Poisson and Markov prototypes against simple time-band baselines.

This adapter would be a research utility only. It would not connect to the live GoalMatrix service or alter production data.

## Decision

Open event data can move the MIE forward on methodology and software validation, but it does **not** remove the main data bottleneck: large-scale, lawful, point-in-time in-play snapshots. The DFL set is a valuable small benchmark; StatsBomb and Wyscout are stronger candidates for event-sequence research; a licensed snapshot archive remains necessary for a credible snapshot-based probability model.
