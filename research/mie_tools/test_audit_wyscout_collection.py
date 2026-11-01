import json
import tempfile
import unittest
from pathlib import Path

from audit_wyscout_collection import audit_collection


def event(event_id, match_id, period="1H", seconds=10, tags=None):
    return {
        "id": event_id,
        "matchId": match_id,
        "teamId": 10,
        "matchPeriod": period,
        "eventSec": seconds,
        "eventName": "Shot",
        "subEventName": "Shot",
        "tags": [{"id": value} for value in (tags or [])],
    }


class WyscoutCollectionAuditTests(unittest.TestCase):
    def write_json(self, folder, filename, payload):
        path = folder / filename
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_audits_multiple_files_and_aggregates_counts(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            self.write_json(folder, "b.json", [event(2, 200, tags=[101])])
            self.write_json(folder, "a.json", [event(1, 100, tags=[1801])])

            report = audit_collection(folder)

            self.assertEqual(report["status"], "validated_event_structure_only")
            self.assertEqual(report["files_audited"], 2)
            self.assertEqual(report["unique_matches"], 2)
            self.assertEqual(report["counts"]["events"], 2)
            self.assertEqual(report["counts"]["goals"], 1)
            self.assertEqual([item["file"] for item in report["files"]], ["a.json", "b.json"])

    def test_duplicate_match_across_files_requires_review(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            self.write_json(folder, "one.json", [event(1, 77)])
            self.write_json(folder, "two.json", [event(2, 77)])

            report = audit_collection(folder)

            self.assertEqual(report["status"], "needs_review")
            self.assertEqual(report["unique_matches"], 1)
            self.assertTrue(any("duplicate match_id 77" in item for item in report["errors"]))

    def test_empty_collection_is_not_a_success(self):
        with tempfile.TemporaryDirectory() as temp:
            report = audit_collection(Path(temp))
            self.assertEqual(report["status"], "needs_review")
            self.assertEqual(report["files_audited"], 0)
            self.assertTrue(report["errors"])

    def test_invalid_json_is_reported_without_aborting_batch(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            (folder / "broken.json").write_text("{not json", encoding="utf-8")
            self.write_json(folder, "valid.json", [event(1, 88)])

            report = audit_collection(folder)

            self.assertEqual(report["files_audited"], 2)
            self.assertEqual(report["unique_matches"], 1)
            self.assertEqual(report["status"], "needs_review")
            self.assertTrue(any("could not audit file" in item for item in report["errors"]))


if __name__ == "__main__":
    unittest.main()
