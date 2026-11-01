#!/usr/bin/env python3
"""Convert a Wyscout processed match-event JSON file to MIE's offline schema.

No network access. No absolute timestamps are fabricated: Wyscout eventSec is
relative to the beginning of each match period, not a UTC timestamp.
"""
from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any

PERIOD_BASE_SECONDS = {"1H": 0, "2H": 45 * 60, "E1": 90 * 60, "E2": 105 * 60}
PENALTY_PERIOD = "P"
GOAL_TAG = 101
OWN_GOAL_TAG = 102
ACCURATE_TAG = 1801
OPPORTUNITY_TAG = 201


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _tags(row: dict) -> set[int]:
    raw = row.get("tags") or []
    if not isinstance(raw, list):
        raise ValueError("tags must be a list")
    result = set()
    for item in raw:
        if not isinstance(item, dict) or "id" not in item:
            raise ValueError("each tag must be an object with an id")
        tag_id = item["id"]
        if isinstance(tag_id, bool) or not isinstance(tag_id, int):
            raise ValueError("tag id must be an integer")
        result.add(tag_id)
    return result


def _event_rows(payload: Any) -> list[dict]:
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict) and isinstance(payload.get("events"), list):
        rows = payload["events"]
    else:
        raise ValueError("expected a JSON array or an object with an events array")
    if any(not isinstance(row, dict) for row in rows):
        raise ValueError("every event must be a JSON object")
    return rows


def _team_sides(match_meta: Any) -> dict[str, str]:
    if match_meta is None:
        return {}
    if not isinstance(match_meta, dict):
        raise ValueError("match metadata must be a JSON object")
    teams = match_meta.get("teamsData") or {}
    if not isinstance(teams, dict):
        raise ValueError("teamsData must be an object")
    sides = {}
    for details in teams.values():
        if not isinstance(details, dict):
            continue
        team_id = details.get("teamId")
        side = str(details.get("side", "")).lower()
        if team_id is not None and side in {"home", "away"}:
            sides[str(team_id)] = side
    return sides


def _team_names(payload: Any) -> dict[str, str]:
    if not isinstance(payload, dict):
        return {}
    raw = payload.get("teams") or {}
    if not isinstance(raw, dict):
        return {}
    names = {}
    for key, details in raw.items():
        if not isinstance(details, dict):
            continue
        team = details.get("team") or details
        if isinstance(team, dict):
            name = team.get("name") or team.get("officialName")
            if name:
                names[str(team.get("wyId", key))] = str(name)
    return names


def normalize_events(payload: Any, match_meta: Any = None) -> tuple[list[dict], dict]:
    rows = _event_rows(payload)
    team_sides = _team_sides(match_meta)
    team_names = _team_names(payload)
    normalized = []
    errors = []
    warnings = []
    previous_clock: dict[tuple[str, str], float] = {}
    seen_ids = set()
    counts = Counter()
    matches = set()

    for line_no, row in enumerate(rows, 1):
        try:
            match_id = str(row.get("matchId", "")).strip()
            if not match_id:
                raise ValueError("missing matchId")
            period = str(row.get("matchPeriod", "")).upper()
            if period not in {*PERIOD_BASE_SECONDS, PENALTY_PERIOD}:
                raise ValueError(f"unsupported matchPeriod: {period or '(missing)'}")
            event_sec = row.get("eventSec")
            if isinstance(event_sec, bool):
                raise ValueError("eventSec must be a finite non-negative number")
            event_sec = float(event_sec)
            if not math.isfinite(event_sec) or event_sec < 0:
                raise ValueError("eventSec must be a finite non-negative number")

            event_id = str(row.get("id", "")).strip()
            if not event_id:
                raise ValueError("missing event id")
            unique_key = (match_id, event_id)
            if unique_key in seen_ids:
                raise ValueError(f"duplicate event id {event_id}")
            seen_ids.add(unique_key)

            event_name = str(row.get("eventName", "")).strip()
            sub_event_name = str(row.get("subEventName", "")).strip()
            if not event_name:
                raise ValueError("missing eventName")
            team_id = row.get("teamId")
            team_key = "" if team_id is None else str(team_id)
            tags = _tags(row)
            shot = event_name.lower() == "shot" or "shot" in sub_event_name.lower()
            # Wyscout also places tag 101 on goalkeeper "Save attempt"
            # events associated with a goal. Do not count those as a second
            # goal. Count tag 101 only on the attacking shot/free-kick event;
            # tag 102 is the explicit own-goal event.
            own_goal = OWN_GOAL_TAG in tags
            goal_attempt_event = event_name.lower() in {"shot", "free kick"}
            goal_signal = own_goal or (GOAL_TAG in tags and goal_attempt_event)
            # Post-match shootout goals are not match-play goals and must not
            # enter next-goal / before-full-time labels. Preserve them separately.
            shootout_goal = period == PENALTY_PERIOD and goal_signal
            goal = period != PENALTY_PERIOD and goal_signal
            if GOAL_TAG in tags and not goal_attempt_event and not own_goal:
                warnings.append(
                    f"row {line_no}: tag 101 on {event_name!r} retained as source tag, not counted as a separate goal"
                )

            # eventSec is period-relative. This nominal elapsed clock is useful
            # for ordering/horizons but is not an absolute UTC match timestamp.
            elapsed = None if period == PENALTY_PERIOD else PERIOD_BASE_SECONDS[period] + event_sec
            if period != PENALTY_PERIOD:
                key = (match_id, period)
                prior = previous_clock.get(key)
                if prior is not None and event_sec < prior:
                    errors.append(
                        f"row {line_no}: {match_id} {period} source event clock regressed"
                    )
                previous_clock[key] = event_sec

            normalized.append({
                "schema_version": "mie.event.v1",
                "source": "wyscout_open_event_dataset",
                "match_id": match_id,
                "source_event_id": event_id,
                "team_id": team_key or None,
                "team_name": team_names.get(team_key),
                "team_side": team_sides.get(team_key),
                "period": period,
                "period_seconds": event_sec,
                "elapsed_seconds_nominal": elapsed,
                "event_type": event_name.lower().replace(" ", "_"),
                "sub_event_type": sub_event_name.lower().replace(" ", "_") or None,
                "is_shot": shot,
                "is_shot_on_target_tagged": bool(shot and ACCURATE_TAG in tags),
                "is_goal": goal,
                "is_shootout_goal": shootout_goal,
                "is_own_goal": own_goal,
                "is_opportunity_tagged": OPPORTUNITY_TAG in tags,
                "tags": sorted(tags),
            })
            matches.add(match_id)
            counts["events"] += 1
            counts["shots"] += int(shot)
            counts["tagged_shots_on_target"] += int(shot and ACCURATE_TAG in tags)
            counts["goals"] += int(goal)
            counts["shootout_goals"] += int(shootout_goal)
            counts["own_goals"] += int(own_goal)
            counts["goal_tagged_save_attempts_ignored"] += int(GOAL_TAG in tags and event_name.lower() == "save attempt")
            counts["opportunity_tagged"] += int(OPPORTUNITY_TAG in tags)
            counts[f"period_{period}"] += 1
        except Exception as exc:
            errors.append(f"row {line_no}: {exc}")

    report = {
        "status": "needs_review" if errors else "validated_event_structure_only",
        "source": "Wyscout public soccer match-event dataset",
        "schema_version": "mie.event.v1",
        "matches": len(matches),
        "counts": dict(sorted(counts.items())),
        "errors": errors,
        "warnings": warnings,
        "limitations": [
            "eventSec is relative to each period; no UTC event timestamps are fabricated.",
            "elapsed_seconds_nominal uses 45-minute period offsets and is not an exact wall-clock timeline.",
            "Wyscout event logs are not continuous live-stat snapshots.",
            "No xG is inferred; this adapter preserves no xG field unless a future documented source mapping is added.",
            "Wyscout tag 101 on goalkeeper Save attempt events is retained but not counted as a separate goal; own-goal tag 102 is counted as an own goal.",
            "The opportunity tag is not silently relabelled as a provider-independent Big Chance.",
            "Tagged accurate shots are preserved as a source-specific field; validate its definition before comparing with other providers.",
            "Penalty-shootout events are retained but have no regulation elapsed_seconds_nominal; shootout goals are flagged separately and excluded from is_goal / regulation goal counts.",
            "No final-time marker is inferred; before-full-time labels require separate validated match-end metadata.",
            "This converter does not establish data completeness, source licensing for a particular use, or predictive value."
        ],
    }
    return normalized, report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--events", required=True, type=Path, help="Wyscout processed match JSON")
    parser.add_argument("--match-meta", type=Path, help="Optional Wyscout match JSON for home/away mapping")
    parser.add_argument("--out", required=True, type=Path, help="Output normalized JSONL")
    parser.add_argument("--report", required=True, type=Path, help="Output quality report JSON")
    args = parser.parse_args()

    payload = load_json(args.events)
    meta = load_json(args.match_meta) if args.match_meta else None
    normalized, report = normalize_events(payload, meta)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as handle:
        for row in normalized:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({
        "status": report["status"],
        "matches": report["matches"],
        "events": report["counts"].get("events", 0),
        "errors": len(report["errors"]),
        "normalized_events": str(args.out),
        "report": str(args.report),
    }, indent=2))
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
