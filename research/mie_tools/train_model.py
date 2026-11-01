#!/usr/bin/env python3
"""Train and evaluate an isolated, dependency-free MIE logistic baseline.

Uses the match-level chronological split emitted by validate_snapshots.py.
Training statistics are fitted on train only; probability calibration is fitted
on validation only; the test partition is opened once for final evaluation.
No network, database, or GoalMatrix runtime access.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path
from typing import Optional

TARGETS = ("label_goal_next_5m", "label_goal_next_10m", "label_goal_before_ft")
PERIODS = ("1H", "2H", "ET1", "ET2")
MIN_TRAIN_ROWS = 200
MIN_TRAIN_MATCHES = 30
MIN_VALIDATION_MATCHES = 10
MIN_TEST_MATCHES = 10
MIN_TRAIN_PER_CLASS = 30
MIN_CALIBRATION_PER_CLASS = 30
MIN_TEST_PER_CLASS = 30
EPS = 1e-12


def number(row: dict, key: str) -> Optional[float]:
    value = row.get(key)
    if value is None or value == "":
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def features(row: dict) -> dict[str, Optional[float]]:
    minute = number(row, "minute")
    second = number(row, "second") or 0.0
    elapsed = max(1.0, (minute or 0.0) + second / 60.0)
    home_sot, away_sot = number(row, "home_sot"), number(row, "away_sot")
    home_shots, away_shots = number(row, "home_shots"), number(row, "away_shots")
    home_xg, away_xg = number(row, "home_xg"), number(row, "away_xg")
    home_big, away_big = number(row, "home_big_chances"), number(row, "away_big_chances")
    hs, aws = number(row, "home_score"), number(row, "away_score")
    hr, ar = number(row, "home_red_cards"), number(row, "away_red_cards")
    result = {
        "minute": minute, "second": second,
        "minute_fraction": None if minute is None else min(1.5, minute / 90.0),
        "remaining_regulation": None if minute is None else max(0.0, (90.0 - minute) / 90.0),
        "score_total": None if hs is None or aws is None else hs + aws,
        "score_difference": None if hs is None or aws is None else hs - aws,
        "red_cards_total": None if hr is None or ar is None else hr + ar,
        "red_card_difference": None if hr is None or ar is None else hr - ar,
        "sot_total": None if home_sot is None or away_sot is None else home_sot + away_sot,
        "sot_difference": None if home_sot is None or away_sot is None else home_sot - away_sot,
        "sot_rate_total": None if home_sot is None or away_sot is None else (home_sot + away_sot) / elapsed,
        "shots_total": None if home_shots is None or away_shots is None else home_shots + away_shots,
        "shots_difference": None if home_shots is None or away_shots is None else home_shots - away_shots,
        "xg_total": None if home_xg is None or away_xg is None else home_xg + away_xg,
        "xg_difference": None if home_xg is None or away_xg is None else home_xg - away_xg,
        "xg_rate_total": None if home_xg is None or away_xg is None else (home_xg + away_xg) / elapsed,
        "big_chances_total": None if home_big is None or away_big is None else home_big + away_big,
        "big_chances_difference": None if home_big is None or away_big is None else home_big - away_big,
        "home_sot": home_sot, "away_sot": away_sot,
        "home_xg": home_xg, "away_xg": away_xg,
    }
    score_diff = result["score_difference"]
    red_diff = result["red_card_difference"]
    minute_fraction = result["minute_fraction"]
    remaining = result["remaining_regulation"]
    result["home_leading"] = None if score_diff is None else float(score_diff > 0)
    result["away_leading"] = None if score_diff is None else float(score_diff < 0)
    result["score_pressure_interaction"] = (None if score_diff is None or minute_fraction is None
                                             else score_diff * minute_fraction)
    result["red_card_time_interaction"] = (None if red_diff is None or minute_fraction is None
                                            else red_diff * minute_fraction)
    result["sot_remaining_interaction"] = (None if result["sot_rate_total"] is None or remaining is None
                                            else result["sot_rate_total"] * remaining)
    result["xg_remaining_interaction"] = (None if result["xg_rate_total"] is None or remaining is None
                                           else result["xg_rate_total"] * remaining)
    period = str(row.get("period", "")).upper()
    for candidate in PERIODS:
        result[f"period_{candidate}"] = 1.0 if period == candidate else 0.0
    return result


def sigmoid(value: float) -> float:
    if value >= 0:
        z = math.exp(-min(value, 700.0))
        return 1.0 / (1.0 + z)
    z = math.exp(max(value, -700.0))
    return z / (1.0 + z)


def logit(probability: float) -> float:
    p = min(1.0 - 1e-8, max(1e-8, probability))
    return math.log(p / (1.0 - p))


def fit_transform(train_rows: list[dict], feature_names: list[str]):
    medians, means, scales = {}, {}, {}
    raw_train = [features(row) for row in train_rows]
    for name in feature_names:
        values = sorted(v[name] for v in raw_train if v[name] is not None)
        median = values[len(values) // 2] if values else 0.0
        medians[name] = median
        filled = [v[name] if v[name] is not None else median for v in raw_train]
        mean = sum(filled) / max(1, len(filled))
        variance = sum((x - mean) ** 2 for x in filled) / max(1, len(filled))
        means[name] = mean
        scales[name] = math.sqrt(variance) or 1.0
    names = []
    for name in feature_names:
        names.extend((name, name + "__missing"))
    def transform(rows):
        matrix = []
        for row in rows:
            values = features(row)
            vector = []
            for name in feature_names:
                missing = values[name] is None
                filled = medians[name] if missing else values[name]
                vector.append((filled - means[name]) / scales[name])
                vector.append(1.0 if missing else 0.0)
            matrix.append(vector)
        return matrix
    return names, transform(train_rows), transform, {"median": medians, "mean": means, "scale": scales}


def match_weights(rows: list[dict]) -> list[float]:
    counts = {}
    for row in rows:
        counts[row["match_id"]] = counts.get(row["match_id"], 0) + 1
    return [1.0 / counts[row["match_id"]] for row in rows]


def fit_logistic(matrix: list[list[float]], labels: list[int], sample_weights: list[float] | None = None,
                 *, l2: float = 1.0, steps: int = 1800, learning_rate: float = 0.08):
    width = len(matrix[0]) if matrix else 0
    weights = [0.0] * width
    prevalence = (sum(labels) + 0.5) / (len(labels) + 1.0)
    intercept = logit(prevalence)
    sample_weights = sample_weights or [1.0] * len(labels)
    total_weight = sum(sample_weights) or 1.0
    for step in range(steps):
        grad = [0.0] * width
        grad_intercept = 0.0
        for vector, label, sample_weight in zip(matrix, labels, sample_weights):
            score = intercept + sum(w * x for w, x in zip(weights, vector))
            error = (sigmoid(score) - label) * sample_weight
            grad_intercept += error
            for j, x in enumerate(vector):
                grad[j] += error * x
        rate = learning_rate / math.sqrt(1.0 + step / 80.0)
        intercept -= rate * grad_intercept / total_weight
        for j in range(width):
            weights[j] -= rate * (grad[j] / total_weight + l2 * weights[j])
    return {"intercept": intercept, "weights": weights}


def scores(model: dict, matrix: list[list[float]]) -> list[float]:
    return [model["intercept"] + sum(w * x for w, x in zip(model["weights"], row)) for row in matrix]


def fit_platt(validation_scores: list[float], labels: list[int], sample_weights: list[float] | None = None):
    a, b = 1.0, 0.0
    sample_weights = sample_weights or [1.0] * len(labels)
    total_weight = sum(sample_weights) or 1.0
    for step in range(2500):
        ga = gb = 0.0
        for score, label, sample_weight in zip(validation_scores, labels, sample_weights):
            error = (sigmoid(a * score + b) - label) * sample_weight
            ga += error * score
            gb += error
        rate = 0.04 / math.sqrt(1.0 + step / 100.0)
        a -= rate * (ga / total_weight + 0.001 * a)
        b -= rate * gb / total_weight
    return {"slope": a, "intercept": b}


def metrics(probabilities: list[float], labels: list[int], baseline_probability: float,
            sample_weights: list[float] | None = None) -> dict:
    if not labels:
        return {"n": 0}
    clipped = [min(1.0 - 1e-12, max(1e-12, p)) for p in probabilities]
    sample_weights = sample_weights or [1.0] * len(labels)
    total_weight = sum(sample_weights) or 1.0
    brier = sum(w * (p - y) ** 2 for p, y, w in zip(clipped, labels, sample_weights)) / total_weight
    loss = -sum(w * (y * math.log(p) + (1 - y) * math.log(1 - p))
                for p, y, w in zip(clipped, labels, sample_weights)) / total_weight
    baseline_p = min(1.0 - 1e-8, max(1e-8, baseline_probability))
    baseline_brier = sum(w * (baseline_p - y) ** 2 for y, w in zip(labels, sample_weights)) / total_weight
    baseline_loss = -sum(w * (y * math.log(baseline_p) + (1-y) * math.log(1-baseline_p))
                         for y, w in zip(labels, sample_weights)) / total_weight
    prevalence = sum(w * y for y, w in zip(labels, sample_weights)) / total_weight
    bins = []
    for index in range(10):
        members = [(p, y, w) for p, y, w in zip(clipped, labels, sample_weights)
                   if index / 10 <= p < (index + 1) / 10 or
                   (index == 9 and p == 1.0)]
        if members:
            bin_weight = sum(w for _, _, w in members)
            bins.append({"lower": index / 10, "upper": (index + 1) / 10,
                         "n": len(members),
                         "mean_probability": sum(p * w for p, _, w in members) / bin_weight,
                         "observed_rate": sum(y * w for _, y, w in members) / bin_weight})
    return {"n": len(labels), "event_rate": prevalence, "brier": brier,
            "log_loss": loss, "constant_baseline_brier": baseline_brier,
            "constant_baseline_log_loss": baseline_loss,
            "reliability_bins": bins}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--features", required=True, type=Path)
    parser.add_argument("--validation-report", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    report = json.loads(args.validation_report.read_text(encoding="utf-8"))
    if report.get("status") != "validated_structure_only" or report.get("errors"):
        raise SystemExit("Refusing to train: validator status is not validated_structure_only. Resolve missing event streams or data errors first.")
    with args.features.open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    split_map = {}
    for split_name in ("train", "validation", "test"):
        for match_id in report.get("match_level_split", {}).get(split_name, []):
            if match_id in split_map:
                raise SystemExit(f"Match {match_id} appears in multiple splits.")
            split_map[match_id] = split_name
    rows = [row for row in rows if row.get("match_id") in split_map]
    partitions = {name: [row for row in rows if split_map[row["match_id"]] == name]
                  for name in ("train", "validation", "test")}
    feature_names = [
        "minute", "second", "minute_fraction", "remaining_regulation",
        "score_total", "score_difference", "red_cards_total", "red_card_difference",
        "sot_total", "sot_difference", "sot_rate_total", "shots_total",
        "shots_difference", "xg_total", "xg_difference", "xg_rate_total",
        "big_chances_total", "big_chances_difference", "home_sot", "away_sot",
        "home_xg", "away_xg", "home_leading", "away_leading",
        "score_pressure_interaction", "red_card_time_interaction",
        "sot_remaining_interaction", "xg_remaining_interaction",
        *[f"period_{p}" for p in PERIODS],
    ]
    output = {
        "model": "MIE logistic baseline v0.2",
        "method": "L2-regularized logistic regression with train-only imputation/standardization and validation-only Platt calibration",
        "split": {key: {"snapshot_rows": len(value),
                        "unique_matches": len({r["match_id"] for r in value})}
                  for key, value in partitions.items()},
        "targets": {},
        "guardrails": [
            "No model is trained if the structural validator reports errors.",
            "All snapshots from a match remain in one chronological partition.",
            "Preprocessing is fitted on train only; calibration is fitted on validation only.",
            "Test rows are used only for final metrics.",
            "A probability is marked calibrated only when validation has at least 30 positive and 30 negative examples.",
            "This baseline is not a betting recommendation and is not connected to live alerts."
        ],
    }
    for target in TARGETS:
        train = [r for r in partitions["train"] if r.get(target, "") in ("0", "1", 0, 1)]
        valid = [r for r in partitions["validation"] if r.get(target, "") in ("0", "1", 0, 1)]
        test = [r for r in partitions["test"] if r.get(target, "") in ("0", "1", 0, 1)]
        result = {"train_n": len(train), "validation_n": len(valid), "test_n": len(test)}
        train_labels = [int(float(r[target])) for r in train]
        train_counts = {0: train_labels.count(0), 1: train_labels.count(1)}
        train_match_count = len({r["match_id"] for r in train})
        valid_match_count = len({r["match_id"] for r in valid})
        test_match_count = len({r["match_id"] for r in test})
        result["unique_matches"] = {"train": train_match_count,
                                    "validation": valid_match_count,
                                    "test": test_match_count}
        if (len(train) < MIN_TRAIN_ROWS or train_match_count < MIN_TRAIN_MATCHES
                or min(train_counts.values(), default=0) < MIN_TRAIN_PER_CLASS):
            result["status"] = "insufficient_training_class_coverage"
            result["training_class_counts"] = {str(k): v for k, v in train_counts.items()}
            output["targets"][target] = result
            continue
        names, x_train, transform, prep = fit_transform(train, feature_names)
        train_weights = match_weights(train)
        model = fit_logistic(x_train, train_labels, train_weights)
        valid_scores = scores(model, transform(valid))
        valid_labels = [int(float(r[target])) for r in valid]
        class_counts = {0: valid_labels.count(0), 1: valid_labels.count(1)}
        valid_weights = match_weights(valid)
        if (valid_match_count < MIN_VALIDATION_MATCHES
                or min(class_counts.values(), default=0) < MIN_CALIBRATION_PER_CLASS):
            result["status"] = "uncalibrated_insufficient_validation"
            result["validation_class_counts"] = {str(k): v for k, v in class_counts.items()}
            output["targets"][target] = result
            continue
        calibrator = fit_platt(valid_scores, valid_labels, valid_weights)
        test_labels = [int(float(r[target])) for r in test]
        test_counts = {0: test_labels.count(0), 1: test_labels.count(1)}
        if (test_match_count < MIN_TEST_MATCHES
                or min(test_counts.values(), default=0) < MIN_TEST_PER_CLASS):
            result["status"] = "insufficient_test_class_coverage"
            result["test_class_counts"] = {str(k): v for k, v in test_counts.items()}
            output["targets"][target] = result
            continue
        test_scores = scores(model, transform(test))
        calibrated = [sigmoid(calibrator["slope"] * s + calibrator["intercept"])
                      for s in test_scores]
        train_weight_total = sum(train_weights)
        train_prevalence = sum(w * y for w, y in zip(train_weights, train_labels)) / train_weight_total
        test_weights = match_weights(test)
        result.update({
            "status": "calibrated_evaluation",
            "validation_class_counts": {str(k): v for k, v in class_counts.items()},
            "calibration": calibrator,
            "test_metrics": metrics(calibrated, test_labels, train_prevalence, test_weights),
            "training_event_rate_baseline": train_prevalence,
            "test_class_counts": {str(k): v for k, v in test_counts.items()},
            "feature_coefficients": sorted(
                [{"feature": name, "coefficient": weight}
                 for name, weight in zip(names, model["weights"])],
                key=lambda item: abs(item["coefficient"]), reverse=True
            )[:20],
            "preprocessing": prep,
        })
        output["targets"][target] = result
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(args.out),
                      "target_status": {k: v["status"] for k, v in output["targets"].items()}},
                     indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
