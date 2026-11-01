#!/usr/bin/env python3
"""Read-only batch audit for a directory of processed Wyscout match JSON files.

The report contains aggregate counts and source filenames only; raw event rows
are never copied into the report or repository.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

from wyscout_adapter import load_json, normalize_events


def audit_collection(input_dir: Path, pattern: str = "*.json") -> dict[str, Any]:
    files = sorted(path for path in input_dir.glob(pattern) if path.is_file())
    errors: list[str] = []
    warnings: list[str] = []
    match_to_file: dict[str, str] = {}
    totals: Counter[str] = Counter()
    file_reports = []

    if not files:
        errors.append(f"no files matched {pattern!r} in {input_dir}")

    for path in files:
        try:
            payload = load_json(path)
            normalized, report = normalize_events(payload)
            match_ids = sorted({row["match_id"] for row in normalized})
            file_errors = list(report["errors"])
            file_warnings = list(report["warnings"])

            if len(match_ids) != 1:
                file_warnings.append(
                    f"expected one match per source file; found {len(match_ids)}"
                )

            for match_id in match_ids:
                previous = match_to_file.get(match_id)
                if previous is not None:
                    errors.append(
                        f"duplicate match_id {match_id} appears in {previous} and {path.name}"
                    )
                else:
                    match_to_file[match_id] = path.name

            for key, value in report["counts"].items():
                totals[key] += value

            errors.extend(f"{path.name}: {item}" for item in file_errors)
            warnings.extend(f"{path.name}: {item}" for item in file_warnings)
            file_reports.append({
                "file": path.name,
                "match_ids": match_ids,
                "matches": report["matches"],
                "counts": report["counts"],
                "errors": file_errors,
                "warnings": file_warnings,
            })
        except Exception as exc:
            message = f"{path.name}: could not audit file: {exc}"
            errors.append(message)
            file_reports.append({
                "file": path.name,
                "match_ids": [],
                "matches": 0,
                "counts": {},
                "errors": [message],
                "warnings": [],
            })

    return {
        "status": "needs_review" if errors else "validated_event_structure_only",
        "scope": "processed Wyscout event JSON collection",
        "files_audited": len(file_reports),
        "unique_matches": len(match_to_file),
        "counts": dict(sorted(totals.items())),
        "errors": errors,
        "warnings": warnings,
        "files": file_reports,
        "limitations": [
            "A structural pass does not establish event completeness, source accuracy, licensing, or predictive value.",
            "Each file is parsed independently; no event rows or raw source payloads are copied into the report.",
            "eventSec remains period-relative; no UTC timestamps or exact wall-clock match times are fabricated.",
            "Wyscout event logs are not continuous live-stat snapshots and do not alone support snapshot-based MIE training.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", required=True, type=Path)
    parser.add_argument("--pattern", default="*.json")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    report = audit_collection(args.input_dir, args.pattern)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({
        "status": report["status"],
        "files_audited": report["files_audited"],
        "unique_matches": report["unique_matches"],
        "errors": len(report["errors"]),
        "warnings": len(report["warnings"]),
        "report": str(args.out),
    }, indent=2))
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
