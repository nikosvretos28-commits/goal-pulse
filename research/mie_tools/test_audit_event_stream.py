import unittest
from datetime import datetime, timezone

from audit_event_stream import audit, parse_timestamp


class EventStreamAuditTests(unittest.TestCase):
    def event(self, kind, at, **extra):
        row = {"match_id": "m1", "event_type": kind,
               "at": datetime.fromisoformat(at.replace("Z", "+00:00"))}
        row.update(extra)
        return row

    def test_valid_timeline_with_goal_and_final_time(self):
        report = audit([
            self.event("shot", "2026-01-01T12:01:00Z"),
            self.event("goal", "2026-01-01T12:04:00Z", team="home"),
            self.event("final_time", "2026-01-01T13:30:00Z"),
        ], [])
        self.assertEqual(report["status"], "validated_event_structure_only")
        self.assertEqual(report["goals_audited"], 1)
        self.assertEqual(report["warnings"], [])

    def test_out_of_order_events_are_not_silently_accepted(self):
        report = audit([
            self.event("shot", "2026-01-01T12:05:00Z"),
            self.event("goal", "2026-01-01T12:04:00Z", team="away"),
        ], [])
        self.assertEqual(report["status"], "needs_review")
        self.assertTrue(any("source event order regressed" in e for e in report["errors"]))

    def test_multiple_final_time_markers_are_rejected(self):
        report = audit([
            self.event("final_time", "2026-01-01T13:30:00Z"),
            self.event("final_time", "2026-01-01T13:31:00Z"),
        ], [])
        self.assertTrue(any("multiple final_time" in e for e in report["errors"]))

    def test_event_after_final_time_is_rejected(self):
        report = audit([
            self.event("final_time", "2026-01-01T13:30:00Z"),
            self.event("shot", "2026-01-01T13:31:00Z"),
        ], [])
        self.assertTrue(any("events occur after final_time" in e for e in report["errors"]))

    def test_missing_final_time_is_warning_not_fabricated(self):
        report = audit([self.event("goal", "2026-01-01T12:04:00Z", team="home")], [])
        self.assertEqual(report["status"], "validated_event_structure_only")
        self.assertTrue(any("no final_time" in w for w in report["warnings"]))

    def test_timezone_is_required(self):
        with self.assertRaisesRegex(ValueError, "include timezone"):
            parse_timestamp("2026-01-01T12:00:00")


if __name__ == "__main__":
    unittest.main()
