#!/usr/bin/env python3
"""Offline audit of timestamped football event streams for MIE research.

This utility checks source ordering and basic match-timeline consistency. It
does not fetch data, infer missing events, or connect to GoalMatrix production.
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_timestamp(value: Any) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("missing event_at_utc")
    parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("event timestamp must include timezone")
    return parsed.astimezone(timezone.utc)


def load_events(path: Path) -> tuple[list[dict], list[str]]:
    events, errors = [], []
    with path.open(encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            try:
                row = json.loads(line)
                if not isinstance(row, dict):
                    raise ValueError("each line must be a JSON object")
                match_id = str(row.get("match_id", "")).strip()
                event_type = str(row.get("event_type", "")).strip().lower()
                if not match_id:
                    raise ValueError("missing match_id")
                if not event_type:
                    raise ValueError("missing event_type")
                at = parse_timestamp(row.get("event_at_utc"))
                event = {"match_id": match_id, "event_type": event_type, "at": at}
                if event_type == "goal":
                    team = str(row.get("team", "")).strip().lower()
                    if team not in {"home", "away"}:
                        raise ValueError("goal team must be home or away")
                    event["team"] = team
                events.append(event)
            except Exception as exc:
                errors.append(f"{path}:{line_no}: {exc}")
    return events, errors


def audit(events: list[dict], parse_errors: list[str]) -> dict:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for event in events:
        grouped[event["match_id"]].append(event)

    errors = list(parse_errors)
    warnings = []
    match_reports = {}
    total_goals = 0
    for match_id, rows in sorted(grouped.items()):
        previous_at = None
        final_times = []
        goals = 0
        for index, event in enumerate(rows, 1):
            at = event["at"]
            if previous_at is not None and at < previous_at:
                errors.append(
                    f"{match_id}: source event order regressed at row {index}; "
                    "do not silently sort away this evidence"
                )
            previous_at = at
            if event["event_type"] == "goal":
                goals += 1
            elif event["event_type"] == "final_time":
                final_times.append(at)

        if len(final_times) > 1:
            errors.append(f"{match_id}: multiple final_time markers ({len(final_times)})")
        if final_times:
            final_at = final_times[0]
            if any(event["at"] > final_at for event in rows):
                errors.append(f"{match_id}: one or more events occur after final_time")
            if any(event["event_type"] == "goal" and event["at"] > final_at for event in rows):
                errors.append(f"{match_id}: goal occurs after final_time")
        else:
            warnings.append(f"{match_id}: no final_time marker; before-FT labels cannot be confirmed")

        match_reports[match_id] = {
            "event_count": len(rows),
            "goal_count": goals,
            "final_time_markers": len(final_times),
            "source_order_monotonic": not any(
                rows[i]["at"] < rows[i - 1]["at"] for i in range(1, len(rows))
            ),
        }
        total_goals += goals

    return {
        "status": "needs_review" if errors else "validated_event_structure_only",
        "note": "Structural checks only; not proof of source completeness, accuracy, licensing, or predictive value.",
        "matches_audited": len(grouped),
        "events_audited": len(events),
        "goals_audited": total_goals,
        "errors": errors,
        "warnings": warnings,
        "matches": match_reports,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--events", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    events, parse_errors = load_events(args.events)
    report = audit(events, parse_errors)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({
        "report": str(args.out),
        "status": report["status"],
        "matches": report["matches_audited"],
        "events": report["events_audited"],
        "errors": len(report["errors"]),
        "warnings": len(report["warnings"]),
    }, indent=2))
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
