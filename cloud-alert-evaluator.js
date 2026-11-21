"use strict";

// Matrix Alert v1: independent, SOT-gated 15-metric evaluator.
const MINUTE_START = 1;
const MINUTE_END_EXCLUSIVE = 70;
const REQUIRED_TOTAL_SOT = 20;
const MIN_METRIC_COVERAGE = 8;
const MIN_SCORE = 75;

function finite(value) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function sum(a, b) { return a == null || b == null ? null : a + b; }
function difference(a, b) { return a == null || b == null ? null : Math.abs(a - b); }

const METRIC_DEFINITIONS = Object.freeze([
  ["totalSot", "Total match SOT", v => v >= 20],
  ["homeSot", "Home SOT", v => v >= 8],
  ["awaySot", "Away SOT", v => v >= 8],
  ["recentSot6", "SOT last 6 minutes", v => v >= 3],
  ["recentSot10", "SOT last 10 minutes", v => v >= 5],
  ["xgTotal", "Combined xG", v => v >= 3],
  ["xgDifference", "Absolute xG difference", v => v <= 1.5],
  ["psxgTotal", "Combined PSxG", v => v >= 2],
  ["bigChancesTotal", "Combined big chances", v => v >= 3],
  ["boxEntriesTotal", "Combined box entries", v => v >= 25],
  ["keyPassesTotal", "Combined key passes", v => v >= 8],
  ["progressivePassesTotal", "Combined progressive passes", v => v >= 20],
  ["dangerousAttacksTotal", "Combined dangerous attacks", v => v >= 40],
  ["cornersTotal", "Combined corners", v => v >= 8],
  ["possessionDifference", "Absolute possession difference", v => v <= 25]
]);

function buildMatrixMetrics(input = {}) {
  const homeSot = finite(input.homeSot), awaySot = finite(input.awaySot);
  const homeXg = finite(input.homeXg), awayXg = finite(input.awayXg);
  const homePsxg = finite(input.homePsxg), awayPsxg = finite(input.awayPsxg);
  const homeBig = finite(input.homeBigChances), awayBig = finite(input.awayBigChances);
  const homeBox = finite(input.homeBoxEntries), awayBox = finite(input.awayBoxEntries);
  const homeKey = finite(input.homeKeyPasses), awayKey = finite(input.awayKeyPasses);
  const homeProgressive = finite(input.homeProgressivePasses), awayProgressive = finite(input.awayProgressivePasses);
  const homeDanger = finite(input.homeDangerousAttacks), awayDanger = finite(input.awayDangerousAttacks);
  const homeCorners = finite(input.homeCorners), awayCorners = finite(input.awayCorners);
  const homePossession = finite(input.homePossession), awayPossession = finite(input.awayPossession);
  const totalSot = sum(homeSot, awaySot);
  return {
    totalSot, homeSot, awaySot,
    recentSot6: finite(input.recentSot6),
    recentSot10: finite(input.recentSot10),
    xgTotal: sum(homeXg, awayXg),
    xgDifference: difference(homeXg, awayXg),
    psxgTotal: sum(homePsxg, awayPsxg),
    bigChancesTotal: sum(homeBig, awayBig),
    boxEntriesTotal: sum(homeBox, awayBox),
    keyPassesTotal: sum(homeKey, awayKey),
    progressivePassesTotal: sum(homeProgressive, awayProgressive),
    dangerousAttacksTotal: sum(homeDanger, awayDanger),
    cornersTotal: sum(homeCorners, awayCorners),
    possessionDifference: difference(homePossession, awayPossession)
  };
}

function evaluateCloudAlert(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return { status: "held", reason: "snapshot_missing", triggers: [] };
  if (!snapshot.matchId) return { status: "held", reason: "match_id_missing", triggers: [] };
  if (!["1H", "2H"].includes(snapshot.period)) return { status: "not_applicable", reason: "outside_regular_play_halves", triggers: [] };
  const minute = finite(snapshot.elapsedMinute);
  if (minute == null || minute < MINUTE_START || minute >= MINUTE_END_EXCLUSIVE) {
    return { status: "not_qualified", reason: "outside_matrix_minute_window", triggers: [] };
  }
  if (snapshot.dataQuality !== "valid" || snapshot.confirmed !== true) {
    return { status: "held", reason: snapshot.dataQualityReason || "sot_sample_not_confirmed", triggers: [] };
  }
  const metrics = buildMatrixMetrics(snapshot);
  if (metrics.totalSot == null) return { status: "held", reason: "sot_unavailable", triggers: [] };
  if (metrics.totalSot < REQUIRED_TOTAL_SOT) {
    return { status: "not_qualified", reason: "total_sot_below_20", metrics, triggers: [] };
  }
  const rows = METRIC_DEFINITIONS.map(([key, label, qualifies]) => {
    const value = metrics[key];
    return { key, label, value, available: value != null, qualifies: value == null ? null : Boolean(qualifies(value)) };
  });
  const available = rows.filter(row => row.available);
  const passed = available.filter(row => row.qualifies).length;
  const score = available.length ? Math.round(100 * passed / available.length) : 0;
  if (available.length < MIN_METRIC_COVERAGE) {
    return { status: "held", reason: "insufficient_metric_coverage", metrics, score, availableMetrics: available.length, totalMetrics: 15, metricBreakdown: rows, triggers: [] };
  }
  const qualified = score >= MIN_SCORE;
  return {
    status: qualified ? "qualified" : "not_qualified",
    reason: qualified ? "matrix_score_threshold_met" : "matrix_score_below_threshold",
    matchId: String(snapshot.matchId), period: snapshot.period, elapsedMinute: minute,
    metrics, score, availableMetrics: available.length, totalMetrics: 15,
    metricBreakdown: rows, triggers: qualified ? ["MATRIX_20_SOT_15_METRICS"] : []
  };
}

module.exports = {
  MINUTE_START, MINUTE_END_EXCLUSIVE, REQUIRED_TOTAL_SOT, MIN_METRIC_COVERAGE, MIN_SCORE,
  METRIC_DEFINITIONS, buildMatrixMetrics, evaluateCloudAlert
};
