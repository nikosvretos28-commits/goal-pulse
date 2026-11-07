import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("validate_snapshots.py")


class ValidatorIntegrationTests(unittest.TestCase):
    def run_case(self, snapshots, events):
        temp = tempfile.TemporaryDirectory()
        root = Path(temp.name)
        snap = root / "snapshots.jsonl"
        event_file = root / "events.jsonl"
        out = root / "out"
        snap.write_text("\n".join(json.dumps(row) for row in snapshots) + "\n", encoding="utf-8")
        event_file.write_text("\n".join(json.dumps(row) for row in events) + "\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--snapshots", str(snap),
             "--events", str(event_file), "--out", str(out)],
            capture_output=True, text=True, check=False
        )
        if not (out / "report.json").exists():
            self.fail(f"validator produced no report; returncode={result.returncode}; stdout={result.stdout}; stderr={result.stderr}")
        report = json.loads((out / "report.json").read_text(encoding="utf-8"))
        with (out / "features.csv").open(encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle))
        return temp, result, report, rows

    def snapshot(self, match_id="m1", at="2026-01-01T12:00:00Z"):
        return {
            "match_id": match_id, "snapshot_at_utc": at, "period": "1H",
            "minute": 12, "second": 0, "home_score": 0, "away_score": 0,
            "home_red_cards": 0, "away_red_cards": 0,
            "home": {"shots": 3, "sot": 1, "xg": 0.2, "big_chances": 0},
            "away": {"shots": 2, "sot": 0, "xg": 0.1, "big_chances": 0}
        }

    def test_future_goal_labels(self):
        temp, result, report, rows = self.run_case(
            [self.snapshot()],
            [
                {"match_id": "m1", "event_type": "goal",
                 "event_at_utc": "2026-01-01T12:04:00Z", "team": "home"},
                {"match_id": "m1", "event_type": "final_time",
                 "event_at_utc": "2026-01-01T13:30:00Z"}
            ]
        )
        self.addCleanup(temp.cleanup)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["label_goal_next_5m"], "1")
        self.assertEqual(rows[0]["label_goal_next_10m"], "1")
        self.assertEqual(rows[0]["label_goal_before_ft"], "1")
        self.assertEqual(report["status"], "validated_structure_only")

    def test_no_goal_is_a_valid_zero_when_final_time_exists(self):
        temp, result, report, rows = self.run_case(
            [self.snapshot()],
            [{"match_id": "m1", "event_type": "final_time",
              "event_at_utc": "2026-01-01T13:30:00Z"}]
        )
        self.addCleanup(temp.cleanup)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(rows[0]["label_goal_next_5m"], "0")
        self.assertEqual(rows[0]["label_goal_next_10m"], "0")
        self.assertEqual(rows[0]["label_goal_before_ft"], "0")

    def test_missing_final_time_keeps_full_time_label_unknown(self):
        temp, result, report, rows = self.run_case(
            [self.snapshot()],
            [{"match_id": "m1", "event_type": "goal",
              "event_at_utc": "2026-01-01T12:04:00Z", "team": "home"}]
        )
        self.addCleanup(temp.cleanup)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(rows[0]["label_goal_next_5m"], "1")
        self.assertEqual(rows[0]["label_goal_before_ft"], "")


    def test_out_of_order_source_snapshots_are_flagged(self):
        temp, result, report, rows = self.run_case(
            [self.snapshot(at="2026-01-01T12:05:00Z"),
             self.snapshot(at="2026-01-01T12:00:00Z")],
            [{"match_id": "m1", "event_type": "final_time",
              "event_at_utc": "2026-01-01T13:30:00Z"}]
        )
        self.addCleanup(temp.cleanup)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["status"], "needs_review")
        self.assertTrue(any("out of timestamp order" in error for error in report["errors"]))

    def test_fractional_match_minute_is_rejected(self):
        row = self.snapshot()
        row["minute"] = 12.5
        temp, result, report, rows = self.run_case(
            [row],
            [{"match_id": "m1", "event_type": "final_time",
              "event_at_utc": "2026-01-01T13:30:00Z"}]
        )
        self.addCleanup(temp.cleanup)
        self.assertEqual(result.returncode, 1)
        self.assertTrue(any("minute must be an integer" in error for error in report["errors"]))

if __name__ == "__main__":
    unittest.main()
