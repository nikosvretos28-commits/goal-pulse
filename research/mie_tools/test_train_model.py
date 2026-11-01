import unittest

from train_model import features, fit_logistic, fit_platt, match_weights, metrics, sigmoid


class MieModelTests(unittest.TestCase):
    def test_features_respect_missing_values_and_clock(self):
        row = {
            "minute": "30", "second": "30", "period": "1H",
            "home_score": "1", "away_score": "0",
            "home_red_cards": "0", "away_red_cards": "1",
            "home_sot": "3", "away_sot": "2",
            "home_shots": "7", "away_shots": "5",
            "home_xg": "", "away_xg": "0.4",
            "home_big_chances": "1", "away_big_chances": "0",
        }
        values = features(row)
        self.assertAlmostEqual(values["sot_rate_total"], 5 / 30.5)
        self.assertEqual(values["score_difference"], 1)
        self.assertIsNone(values["xg_total"])
        self.assertEqual(values["period_1H"], 1.0)
        self.assertEqual(values["period_2H"], 0.0)

    def test_logistic_model_learns_separable_signal(self):
        matrix = [[-2.0], [-1.0], [1.0], [2.0]] * 30
        labels = [0, 0, 1, 1] * 30
        model = fit_logistic(matrix, labels, steps=1200)
        low = sigmoid(model["intercept"] + model["weights"][0] * -2)
        high = sigmoid(model["intercept"] + model["weights"][0] * 2)
        self.assertLess(low, 0.2)
        self.assertGreater(high, 0.8)

    def test_platt_calibration_returns_probabilities(self):
        scores = [-2.0, -1.0, 1.0, 2.0] * 20
        labels = [0, 0, 1, 1] * 20
        calibration = fit_platt(scores, labels)
        probabilities = [sigmoid(calibration["slope"] * x + calibration["intercept"])
                         for x in scores]
        self.assertTrue(all(0.0 < p < 1.0 for p in probabilities))
        self.assertGreater(probabilities[-1], probabilities[0])

    def test_metrics_include_constant_baseline_and_reliability(self):
        result = metrics([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1], 0.5)
        self.assertEqual(result["n"], 4)
        self.assertIn("constant_baseline_brier", result)
        self.assertTrue(result["reliability_bins"])
        self.assertLess(result["brier"], result["constant_baseline_brier"])


    def test_match_weights_prevent_dense_matches_dominating(self):
        rows = [{"match_id": "a"}, {"match_id": "a"}, {"match_id": "b"}]
        weights = match_weights(rows)
        self.assertEqual(weights, [0.5, 0.5, 1.0])
        self.assertAlmostEqual(sum(weights[:2]), weights[2])

    def test_state_interactions_are_explicit(self):
        row = {
            "minute": "60", "second": "0", "period": "2H",
            "home_score": "0", "away_score": "1",
            "home_red_cards": "0", "away_red_cards": "1",
            "home_sot": "4", "away_sot": "2",
            "home_shots": "9", "away_shots": "6",
            "home_xg": "0.8", "away_xg": "0.4",
            "home_big_chances": "1", "away_big_chances": "0",
        }
        values = features(row)
        self.assertEqual(values["away_leading"], 1.0)
        self.assertAlmostEqual(values["score_pressure_interaction"], -2 / 3)
        self.assertAlmostEqual(values["red_card_time_interaction"], -2 / 3)

if __name__ == "__main__":
    unittest.main()
