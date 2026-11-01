# MIE offline data tools

This folder is an isolated research utility. It is **not imported by the GoalMatrix server**, does not make network requests, and cannot alter alerts or production data.

## Purpose

Validate point-in-time match snapshots, create future-goal labels, and train a first transparent probability baseline for offline MIE experiments. It intentionally refuses to invent missing values or infer live history from final match statistics.

## Input format

Both inputs are UTF-8 JSON Lines (one JSON object per line).

### snapshots.jsonl

\`\`\`json
{"match_id":"demo-001","snapshot_at_utc":"2026-10-20T18:12:00Z","period":"1H","minute":12,"second":0,"home_score":0,"away_score":0,"home_red_cards":0,"away_red_cards":0,"provider":"licensed-provider","home":{"shots":4,"sot":2,"xg":0.48,"big_chances":1},"away":{"shots":2,"sot":0,"xg":0.11,"big_chances":0}}
\`\`\`

Required: match ID, timezone-aware snapshot timestamp, period, match clock, and home/away stat objects. Stats may be null when genuinely unavailable. Do not put final match values into a past snapshot.

### events.jsonl

Goal events use the timestamp when the goal occurred:

\`\`\`json
{"match_id":"demo-001","event_type":"goal","event_at_utc":"2026-10-20T18:16:42Z","team":"home"}
{"match_id":"demo-001","event_type":"final_time","event_at_utc":"2026-10-20T19:58:00Z"}
\`\`\`

Include the complete timestamped goal stream and one final_time event for each completed match. Without final_time, the before-full-time label remains blank. Non-goal event types are ignored for labels.

## Run the validator and label builder

Requires Python 3.10+ and only the standard library:

\`\`\`bash
python research/mie_tools/validate_snapshots.py \\
  --snapshots /path/to/snapshots.jsonl \\
  --events /path/to/events.jsonl \\
  --out /path/to/mie-output
\`\`\`

Outputs:
- features.csv: one row per valid snapshot with next-5m, next-10m and before-FT goal labels;
- report.json: errors, duplicate/regression checks, missing event streams and match-level chronological train/validation/test assignments.

## Train and evaluate the first MIE baseline

Only after the validator reports validated_structure_only:

\`\`\`bash
python research/mie_tools/train_model.py \\
  --features /path/to/mie-output/features.csv \\
  --validation-report /path/to/mie-output/report.json \\
  --out /path/to/mie-output/model-report.json
\`\`\`

The baseline is L2-regularized logistic regression for each of the three horizons. It builds time, score-state, red-card, shot, SOT, xG, big-chance and period features, plus explicit score/time and red-card/time interactions. Each match is given equal total training, calibration and test weight so matches with more snapshots do not dominate. Missing numeric inputs are median-imputed using training rows only, with explicit missingness indicators; scaling is also fitted on training rows only. A Platt calibration layer is fitted on validation rows only. The test partition is used only for final evaluation.

The report includes Brier score, log loss, a constant-prevalence baseline derived from the training partition (not the test set), reliability bins, sample counts and the strongest signed coefficients. It requires at least 200 training snapshots, 30 distinct training matches, 10 distinct validation matches, 10 distinct test matches, and at least 30 examples of each class in each relevant partition. It will not label an output calibrated unless validation contains at least 30 positive and 30 negative examples for that horizon. Insufficient data is reported, not disguised.

Run the unit tests:

\`\`\`bash
cd research/mie_tools
python -m unittest -v
\`\`\`

## Important interpretation

- This is a research baseline, not a production prediction engine and not yet a betting model.
- A structural pass does not establish source accuracy, licensing, completeness or model performance.
- Snapshot features use only values recorded at or before the snapshot timestamp; future goal events are labels only.
- All snapshots from a match remain in one partition to prevent same-match leakage.
- Corrections, clock semantics, stoppage time and extra-time policy require provider-specific review before model training.
- The first baseline is deliberately interpretable. More complex models must beat it on held-out data and remain calibrated before they are considered.
- Use only data the project is authorized to access and process. No Forebet scraping or unlicensed reuse is supported.

## Run the repeatable synthetic demo

The repository includes a clearly labelled **synthetic** three-match fixture. It is for checking the validator and future-goal labels only; it is not real match data and must not be used to train or evaluate a predictive model.

From the repository root:

```bash
python research/mie_tools/validate_snapshots.py \
  --snapshots research/mie_tools/fixtures/demo_snapshots.jsonl \
  --events research/mie_tools/fixtures/demo_events.jsonl \
  --out /tmp/mie-demo
```

Expected structural result: `validated_structure_only`, 3 snapshot rows accepted, 3 matches with goal-event streams, and 0 errors. Expected labels:

| Synthetic match | Goal timing | Next 5m | Next 10m | Before FT |
|---|---:|---:|---:|---:|
| demo-goal-4m | +4 minutes | 1 | 1 | 1 |
| demo-goal-8m | +8 minutes | 0 | 1 | 1 |
| demo-no-goal | No goal | 0 | 0 | 0 |

The dedicated automated test checks these exact labels. The fixture deliberately has only three matches, so it does **not** meet the training minimums and the logistic model must not be trained on it.


## Audit a timestamped event stream

Before using an event-log source for event-sequence research, run the independent timeline audit:

```bash
python research/mie_tools/audit_event_stream.py \
  --events /path/to/events.jsonl \
  --out /path/to/event-audit.json
```

The audit checks required match IDs, event types and timezone-aware timestamps; preserves and checks source row order per match; validates goal team labels; flags multiple final-time markers and events after final time; and warns when a completed-match boundary is absent. It does not sort away source-order problems, infer missing events, or prove source completeness/licensing. A structural pass is not predictive validation.

The accompanying `test_audit_event_stream.py` checks these cases using small in-memory examples. The audit is independent of the snapshot validator and remains offline/research-only.


## Import a Wyscout open event match (offline)

The optional adapter accepts the processed Wyscout match-event JSON format documented by the public dataset repository. Download the source files separately after reviewing the current dataset terms; do not commit the raw match files to this repository.

```bash
python research/mie_tools/wyscout_adapter.py \
  --events /path/to/one-match-events.json \
  --out /path/to/mie-wyscout-events.jsonl \
  --report /path/to/mie-wyscout-report.json
```

If the corresponding Wyscout match metadata JSON is available, also pass `--match-meta /path/to/match.json` to map team IDs to home/away. The adapter emits the provider-neutral `mie.event.v1` shape while retaining source event IDs, names, tags, period and team identifiers.

Important semantics:
- Wyscout `eventSec` is seconds since the beginning of its match period. The adapter preserves it as `period_seconds` and provides a nominal period-offset `elapsed_seconds_nominal` only for event ordering/horizon prototypes. It does **not** fabricate UTC timestamps or exact wall-clock kickoff offsets.
- Tag 101 is retained as a goal indicator; tag 1801 on a shot is retained as a source-tagged accurate shot; tag 201 remains an opportunity tag, not a provider-independent Big Chance.
- No xG, final-time marker, or live rolling-stat snapshot is invented. Penalty-shootout events remain identified as period `P` and are excluded from the nominal regulation clock.
- The source dataset repository describes 2016/2017–2018 competitions and states CC BY 4.0. Cite Pappalardo et al. and the Wyscout dataset; verify current source terms and attribution before publication or any commercial use.

Run adapter tests with the rest of the suite:

```bash
cd research/mie_tools
python -m unittest -v
```

### First real-match structural audit (Wyscout match 2499841)

The public processed-v2 event file for the repository's documented default match (Huddersfield Town–Manchester City) was inspected directly from the dataset repository. The event payload contains 1,593 events across two teams: 844 first-half and 749 second-half events. It contains 17 primary `Shot` events, four `Shot` events with the source accurate tag 1801, eleven opportunity tags 201, no duplicate event IDs, and no within-period source-clock regressions.

**Goal-tag audit:** the raw file has five occurrences of tag 101, but three are on goalkeeper `Save attempt` events. Counting every tag-101 row as a goal would therefore double-count associated goalkeeper events. The adapter was corrected to count tag 101 only on `Shot` / `Free Kick` goal-attempt events, and to count tag 102 as the explicit own-goal event. For this match, that yields three goal events (two goal-attempt rows plus one own-goal row), while retaining the three goalkeeper tag-101 rows as warnings/source metadata rather than separate goals.

The embedded team metadata includes names but not home/away sides; the adapter now preserves team names and leaves `team_side` null unless explicit match metadata supplies it. The event file does not provide continuous live-stat snapshots or xG. This is a structural source audit, not a model-performance test. The complete raw match file is not copied into this repository.
