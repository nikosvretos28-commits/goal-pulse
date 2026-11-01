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

The baseline is L2-regularized logistic regression for each of the three horizons. It builds time, score-state, red-card, shot, SOT, xG, big-chance and period features. Missing numeric inputs are median-imputed using training rows only, with explicit missingness indicators; scaling is also fitted on training rows only. A Platt calibration layer is fitted on validation rows only. The test partition is used only for final evaluation.

The report includes Brier score, log loss, a constant-prevalence baseline, reliability bins, sample counts and the strongest signed coefficients. It will not label an output calibrated unless validation contains at least 30 positive and 30 negative examples for that horizon. It requires at least 200 training rows. Insufficient data is reported, not disguised.

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
