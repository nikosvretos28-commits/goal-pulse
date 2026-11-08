"use strict";
function finiteNonNegative(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Math.max(0, Number(value));
}
function validateRollingSot({ memoryDelta, persistedDelta, cumulativeTotal }) {
  const memory = finiteNonNegative(memoryDelta);
  const persisted = finiteNonNegative(persistedDelta);
  const cumulative = finiteNonNegative(cumulativeTotal);
  if (cumulative == null) return { value: 0, valid: false, reason: "cumulative_sot_unavailable", memory, persisted, cumulative: null };
  if (memory == null && persisted == null) return { value: 0, valid: false, reason: "rolling_baseline_unavailable", memory: null, persisted: null, cumulative };
  const value = memory != null && persisted != null ? Math.min(memory, persisted) : (memory ?? persisted);
  if (value > cumulative) return { value: 0, valid: false, reason: "rolling_exceeds_cumulative", memory, persisted, cumulative };
  return {
    value, valid: true,
    reason: memory != null && persisted != null
      ? (memory === persisted ? "corroborated" : "conservative_minimum_on_disagreement")
      : (memory != null ? "memory_only" : "persisted_only"),
    memory, persisted, cumulative
  };
}

const EXACT_SOT_LABELS = new Set([
  "shots_on_target",
  "shots_on_goal",
  "shots_on_target_total",
  "sot",
  "on_target"
]);
function normalizeStatLabel(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
function readExactSotStat(items, side) {
  if (!Array.isArray(items) || !["home", "away"].includes(side)) return null;
  for (const stat of items) {
    const labels = [normalizeStatLabel(stat?.key), normalizeStatLabel(stat?.title)];
    if (!labels.some(label => EXACT_SOT_LABELS.has(label))) continue;
    const raw = stat?.[side];
    const value = Number.parseFloat(String(raw ?? "").replace("%", "").replace(",", "."));
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}
module.exports = { validateRollingSot, readExactSotStat, normalizeStatLabel };
