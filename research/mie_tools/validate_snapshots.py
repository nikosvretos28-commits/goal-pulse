#!/usr/bin/env python3
"""Offline, dependency-free validator and label builder for MIE point-in-time data.

Input:
  snapshots.jsonl: one JSON object per match snapshot (schema in README.md)
  events.jsonl: one JSON object per event; only timestamped goals are used as labels

Output:
  features.csv: validated point-in-time features and future-goal labels
  report.json: data-readiness and validation summary

This tool never connects to GoalMatrix or any live service.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

STAT_FIELDS = ("shots", "sot", "xg", "big_chances")
PERIODS = {"1H", "2H", "ET1", "ET2"}
FEATURE_FIELDS = [
    "match_id", "snapshot_at_utc", "period", "minute", "second",
    "home_score", "away_score", "home_red_cards", "away_red_cards",
    "home_shots", "away_shots", "home_sot", "away_sot",
    "home_xg", "away_xg", "home_big_chances", "away_big_chances",
    "label_goal_next_5m", "label_goal_next_10m", "label_goal_before_ft",
]


def parse_time(value: Any) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("missing timestamp")
    text = value.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        raise ValueError("timestamp must include timezone")
    return dt.astimezone(timezone.utc)


def finite_number(value: Any, field: str, *, minimum: float = 0.0) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be numeric")
    number = float(value)
    if not math.isfinite(number) or number < minimum:
        raise ValueError(f"{field} must be finite and >= {minimum}")
    return number


def integer_number(value: Any, field: str, *, minimum: float = 0.0) -> int:
    number = finite_number(value, field, minimum=minimum)
    if not number.is_integer():
        raise ValueError(f"{field} must be an integer")
    return int(number)


def load_jsonl(path: Path) -> tuple[list[dict], list[str]]:
    rows, errors = [], []
    with path.open(encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            try:
                item = json.loads(line)
                if not isinstance(item, dict):
                    raise ValueError("each line must be a JSON object")
                rows.append(item)
            except Exception as exc:
                errors.append(f"{path}:{line_no}: {exc}")
    return rows, errors


def normalize_snapshot(row: dict) -> dict:
    match_id = str(row.get("match_id", "")).strip()
    if not match_id:
        raise ValueError("missing match_id")
    timestamp = parse_time(row.get("snapshot_at_utc"))
    period = str(row.get("period", "")).upper()
    if period not in PERIODS:
        raise ValueError(f"period must be one of {sorted(PERIODS)}")
    minute = integer_number(row.get("minute"), "minute")
    second = integer_number(row.get("second", 0), "second")
    if minute > 140 or second > 59:
        raise ValueError("implausible match clock")
    result = {
        "match_id": match_id, "snapshot_at": timestamp, "period": period,
        "minute": minute, "second": second,
    }
    for field in ("home_score", "away_score", "home_red_cards", "away_red_cards"):
        result[field] = integer_number(row.get(field, 0), field)
    for side in ("home", "away"):
        values = row.get(side)
        if not isinstance(values, dict):
            raise ValueError(f"{side} must be an object")
        for field in STAT_FIELDS:
            value = values.get(field)
            result[f"{side}_{field}"] = None if value is None else finite_number(value, f"{side}.{field}")
    result["provider"] = str(row.get("provider", "unspecified"))
    return result


def normalize_event(row: dict) -> dict:
    match_id = str(row.get("match_id", "")).strip()
    if not match_id:
        raise ValueError("event missing match_id")
    event_type = str(row.get("event_type", "")).lower()
    if event_type != "goal":
        return {"match_id": match_id, "event_type": event_type, "at": parse_time(row.get("event_at_utc"))}
    team = str(row.get("team", "")).lower()
    if team not in {"home", "away"}:
        raise ValueError("goal team must be home or away")
    return {"match_id": match_id, "event_type": "goal", "team": team,
            "at": parse_time(row.get("event_at_utc"))}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshots", required=True, type=Path)
    parser.add_argument("--events", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    raw_snapshots, parse_errors = load_jsonl(args.snapshots)
    raw_events, event_errors = load_jsonl(args.events)
    errors = parse_errors + event_errors
    snapshots, events = [], []
    for index, row in enumerate(raw_snapshots, 1):
        try:
            snapshots.append(normalize_snapshot(row))
        except Exception as exc:
            errors.append(f"snapshot row {index}: {exc}")
    for index, row in enumerate(raw_events, 1):
        try:
            events.append(normalize_event(row))
        except Exception as exc:
            errors.append(f"event row {index}: {exc}")

    # Preserve evidence of provider row order before sorting for deterministic processing.
    input_previous: dict[str, datetime] = {}
    for row in snapshots:
        previous_at = input_previous.get(row["match_id"])
        if previous_at is not None and row["snapshot_at"] < previous_at:
            errors.append(
                f"{row['match_id']}: snapshots arrived out of timestamp order; source order needs review"
            )
        input_previous[row["match_id"]] = row["snapshot_at"]

    snapshots.sort(key=lambda r: (r["match_id"], r["snapshot_at"]))
    events_by_match: dict[str, list[dict]] = defaultdict(list)
    for event in events:
        events_by_match[event["match_id"]].append(event)
    for values in events_by_match.values():
        values.sort(key=lambda e: e["at"])

    accepted, duplicate_count, regressions = [], 0, 0
    previous: dict[str, dict] = {}
    seen = set()
    for row in snapshots:
        key = (row["match_id"], row["snapshot_at"])
        if key in seen:
            duplicate_count += 1
            errors.append(f"duplicate snapshot: {row['match_id']} at {row['snapshot_at'].isoformat()}")
            continue
        seen.add(key)
        prev = previous.get(row["match_id"])
        if prev:
            for field in ("home_score", "away_score", "home_red_cards", "away_red_cards"):
                if row[field] < prev[field]:
                    regressions += 1
                    errors.append(f"{row['match_id']}: {field} regressed; provider correction needs review")
            for field in (f"{side}_{stat}" for side in ("home", "away") for stat in STAT_FIELDS):
                old, new = prev[field], row[field]
                if old is not None and new is not None and new < old:
                    regressions += 1
                    errors.append(f"{row['match_id']}: {field} regressed; provider correction needs review")
        previous[row["match_id"]] = row
        accepted.append(row)

    # Only rows with a complete timestamped future-goal event stream can receive labels.
    output_rows = []
    missing_event_matches = set()
    for row in accepted:
        match_events = events_by_match.get(row["match_id"])
        if match_events is None:
            missing_event_matches.add(row["match_id"])
            continue
        goals = [event for event in match_events if event["event_type"] == "goal"]
        final_events = [event for event in match_events if event["event_type"] == "final_time"]
        final_at = min((event["at"] for event in final_events), default=None)
        future = [goal for goal in goals if goal["at"] > row["snapshot_at"]
                  and (final_at is None or goal["at"] <= final_at)]
        next5 = any((goal["at"] - row["snapshot_at"]).total_seconds() <= 5 * 60 for goal in future)
        next10 = any((goal["at"] - row["snapshot_at"]).total_seconds() <= 10 * 60 for goal in future)
        # Without a final_time marker, "before FT" cannot be labelled safely.
        before_ft = None if final_at is None else any(
            row["snapshot_at"] < goal["at"] <= final_at for goal in future
        )
        output = {key: value for key, value in row.items() if key not in {"snapshot_at", "provider"}}
        output["snapshot_at_utc"] = row["snapshot_at"].isoformat().replace("+00:00", "Z")
        output["label_goal_next_5m"] = int(next5)
        output["label_goal_next_10m"] = int(next10)
        output["label_goal_before_ft"] = "" if before_ft is None else int(before_ft)
        output_rows.append(output)

    args.out.mkdir(parents=True, exist_ok=True)
    csv_path = args.out / "features.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FEATURE_FIELDS)
        writer.writeheader()
        for row in output_rows:
            writer.writerow({key: row.get(key) for key in FEATURE_FIELDS})

    # Chronological holdout assignment is by match, never by snapshot.
    # All snapshots from one match remain together to prevent same-match leakage.
    first_seen = {}
    for row in output_rows:
        first_seen[row["match_id"]] = min(
            first_seen.get(row["match_id"], row["snapshot_at"]), row["snapshot_at"]
        )
    match_ids = sorted(first_seen, key=lambda match_id: (first_seen[match_id], match_id))
    n = len(match_ids)
    train_end, valid_end = int(n * 0.70), int(n * 0.85)
    split = {match_id: ("train" if i < train_end else "validation" if i < valid_end else "test")
             for i, match_id in enumerate(match_ids)}
    report = {
        "status": "needs_review" if errors or missing_event_matches else "validated_structure_only",
        "note": "Structural validation only; no model was trained and no predictive accuracy is claimed.",
        "snapshot_rows_read": len(raw_snapshots),
        "snapshot_rows_accepted": len(accepted),
        "feature_rows_written": len(output_rows),
        "matches_with_snapshots": len({r["match_id"] for r in accepted}),
        "matches_with_goal_event_stream": len({r["match_id"] for r in output_rows}),
        "matches_missing_event_stream": sorted(missing_event_matches),
        "event_rows_read": len(raw_events),
        "duplicate_snapshots": duplicate_count,
        "monotonicity_violations": regressions,
        "errors": errors,
        "match_level_split": {
            "train": [m for m in match_ids if split[m] == "train"],
            "validation": [m for m in match_ids if split[m] == "validation"],
            "test": [m for m in match_ids if split[m] == "test"],
        },
        "limitations": [
            "A goal event stream without a final_time marker cannot label goal_before_ft.",
            "Provider corrections must be reviewed; this validator does not infer corrected values.",
            "A structural pass is not proof that provider timestamps are accurate or complete.",
            "Small datasets may produce empty validation or test partitions.",
            "Snapshots from the same match are always assigned to the same partition."
        ],
    }
    (args.out / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(args.out / "report.json"), "features": str(csv_path),
                      "status": report["status"], "feature_rows": len(output_rows),
                      "errors": len(errors)}, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
