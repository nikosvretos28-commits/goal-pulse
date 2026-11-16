import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures"
VALIDATOR = ROOT / "validate_snapshots.py"


class SyntheticDemoFixtureTests(unittest.TestCase):
    def test_three_match_demo_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            result = subprocess.run(
                [sys.executable, str(VALIDATOR),
                 "--snapshots", str(FIXTURES / "demo_snapshots.jsonl"),
                 "--events", str(FIXTURES / "demo_events.jsonl"),
                 "--out", str(out)],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            report = json.loads((out / "report.json").read_text(encoding="utf-8"))
            self.assertEqual(report["status"], "validated_structure_only")
            self.assertEqual(report["matches_with_snapshots"], 3)
            self.assertEqual(report["matches_with_goal_event_stream"], 3)
            with (out / "features.csv").open(encoding="utf-8", newline="") as handle:
                rows = {row["match_id"]: row for row in csv.DictReader(handle)}

            self.assertEqual(set(rows), {"demo-goal-4m", "demo-goal-8m", "demo-no-goal"})
            self.assertEqual(
                (rows["demo-goal-4m"]["label_goal_next_5m"],
                 rows["demo-goal-4m"]["label_goal_next_10m"],
                 rows["demo-goal-4m"]["label_goal_before_ft"]),
                ("1", "1", "1"),
            )
            self.assertEqual(
                (rows["demo-goal-8m"]["label_goal_next_5m"],
                 rows["demo-goal-8m"]["label_goal_next_10m"],
                 rows["demo-goal-8m"]["label_goal_before_ft"]),
                ("0", "1", "1"),
            )
            self.assertEqual(
                (rows["demo-no-goal"]["label_goal_next_5m"],
                 rows["demo-no-goal"]["label_goal_next_10m"],
                 rows["demo-no-goal"]["label_goal_before_ft"]),
                ("0", "0", "0"),
            )


if __name__ == "__main__":
    unittest.main()
