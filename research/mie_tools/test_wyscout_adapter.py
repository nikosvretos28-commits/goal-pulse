import unittest

from wyscout_adapter import normalize_events


class WyscoutAdapterTests(unittest.TestCase):
    def event(self, event_id, period, seconds, name="Shot", sub="Shot", tags=None, team=10):
        return {
            "id": event_id, "matchId": 77, "teamId": team,
            "matchPeriod": period, "eventSec": seconds,
            "eventName": name, "subEventName": sub,
            "tags": [{"id": value} for value in (tags or [])],
        }

    def test_normalizes_shot_goal_and_period_relative_clock(self):
        rows, report = normalize_events([
            self.event(1, "1H", 120.5, tags=[1801]),
            self.event(2, "2H", 60, tags=[101, 1801]),
        ])
        self.assertEqual(report["status"], "validated_event_structure_only")
        self.assertEqual(rows[0]["elapsed_seconds_nominal"], 120.5)
        self.assertEqual(rows[1]["elapsed_seconds_nominal"], 2760)
        self.assertTrue(rows[0]["is_shot_on_target_tagged"])
        self.assertTrue(rows[1]["is_goal"])
        self.assertEqual(rows[0]["team_side"], None)

    def test_maps_home_away_when_match_metadata_is_supplied(self):
        meta = {"teamsData": {
            "home": {"teamId": 10, "side": "home"},
            "away": {"teamId": 20, "side": "away"},
        }}
        rows, _ = normalize_events([self.event(1, "1H", 1, team=20)], meta)
        self.assertEqual(rows[0]["team_side"], "away")

    def test_keeps_opportunity_distinct_from_big_chance(self):
        rows, _ = normalize_events([self.event(1, "1H", 1, tags=[201])])
        self.assertTrue(rows[0]["is_opportunity_tagged"])
        self.assertNotIn("is_big_chance", rows[0])

    def test_penalty_shootout_is_preserved_but_not_added_to_match_clock(self):
        rows, report = normalize_events([self.event(1, "P", 1, tags=[101])])
        self.assertIsNone(rows[0]["elapsed_seconds_nominal"])
        self.assertEqual(report["counts"]["period_P"], 1)
        self.assertFalse(rows[0]["is_goal"])
        self.assertTrue(rows[0]["is_shootout_goal"])
        self.assertEqual(report["counts"]["goals"], 0)
        self.assertEqual(report["counts"]["shootout_goals"], 1)


    def test_extra_time_goal_remains_a_match_play_goal(self):
        rows, report = normalize_events([
            self.event(1, "E1", 30, name="Shot", tags=[101, 1801])
        ])
        self.assertTrue(rows[0]["is_goal"])
        self.assertFalse(rows[0]["is_shootout_goal"])
        self.assertEqual(report["counts"]["goals"], 1)
        self.assertEqual(report["counts"]["shootout_goals"], 0)

    def test_saved_penalty_shootout_attempt_is_not_a_shootout_goal(self):
        rows, report = normalize_events([
            self.event(1, "P", 20, name="Save attempt", sub="Reflexes", tags=[101, 1802])
        ])
        self.assertFalse(rows[0]["is_goal"])
        self.assertFalse(rows[0]["is_shootout_goal"])
        self.assertEqual(report["counts"]["goals"], 0)
        self.assertEqual(report["counts"]["shootout_goals"], 0)

    def test_clock_regression_and_duplicate_ids_are_reported(self):
        rows, report = normalize_events([
            self.event(1, "1H", 20),
            self.event(1, "1H", 21),
            self.event(2, "1H", 10),
        ])
        self.assertEqual(len(rows), 2)
        self.assertEqual(report["status"], "needs_review")
        self.assertTrue(any("duplicate event id" in item for item in report["errors"]))
        self.assertTrue(any("clock regressed" in item for item in report["errors"]))

    def test_missing_xg_is_not_invented(self):
        rows, _ = normalize_events([self.event(1, "1H", 1)])
        self.assertNotIn("xg", rows[0])


    def test_goal_tag_on_save_attempt_is_not_counted_as_second_goal(self):
        rows, report = normalize_events({
            "events": [self.event(1, "1H", 100, name="Save attempt", sub="Reflexes", tags=[101])]
        })
        self.assertFalse(rows[0]["is_goal"])
        self.assertEqual(report["counts"]["goals"], 0)
        self.assertEqual(report["counts"]["goal_tagged_save_attempts_ignored"], 1)
        self.assertTrue(any("not counted as a separate goal" in item for item in report["warnings"]))

    def test_goal_shot_and_own_goal_are_counted_once(self):
        rows, report = normalize_events({
            "events": [
                self.event(1, "1H", 100, name="Free Kick", sub="Penalty", tags=[101]),
                self.event(2, "1H", 101, name="Others on the ball", sub="Touch", tags=[102]),
            ]
        })
        self.assertTrue(rows[0]["is_goal"])
        self.assertTrue(rows[1]["is_goal"])
        self.assertTrue(rows[1]["is_own_goal"])
        self.assertEqual(report["counts"]["goals"], 2)
        self.assertEqual(report["counts"]["own_goals"], 1)

    def test_embedded_team_names_are_preserved(self):
        payload = {
            "events": [self.event(1, "1H", 1, team=10)],
            "teams": {"10": {"team": {"wyId": 10, "name": "Home FC"}}},
        }
        rows, _ = normalize_events(payload)
        self.assertEqual(rows[0]["team_name"], "Home FC")

    def test_unknown_period_is_rejected(self):
        rows, report = normalize_events([self.event(1, "HT", 0)])
        self.assertEqual(rows, [])
        self.assertEqual(report["status"], "needs_review")


if __name__ == "__main__":
    unittest.main()
