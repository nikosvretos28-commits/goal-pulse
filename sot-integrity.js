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
module.exports = { validateRollingSot };
