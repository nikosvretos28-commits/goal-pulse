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

function confirmSotSignal({ stateMap, eventId, now, qualifies, cumulativeByTeam, minIntervalMs = 30000, maxIntervalMs = 150000 }) {
  if (!(stateMap instanceof Map) || !eventId) return { confirmed: false, reason: "confirmation_state_unavailable", regression: false };
  const id = String(eventId);
  if (!Array.isArray(cumulativeByTeam) || cumulativeByTeam.length < 2 ||
      cumulativeByTeam.some(side => !side?.team || side.value == null || !Number.isFinite(Number(side.value)) || Number(side.value) < 0)) {
    stateMap.delete(id);
    return { confirmed: false, reason: "complete_team_sot_unavailable", regression: false };
  }
  const current = cumulativeByTeam.slice(0, 2).map(side => ({
    team: String(side.team).trim().toLowerCase(),
    value: Number(side.value)
  }));
  if (new Set(current.map(side => side.team)).size !== 2) {
    stateMap.delete(id);
    return { confirmed: false, reason: "ambiguous_team_sot_identity", regression: false };
  }
  const previous = stateMap.get(id);
  if (previous) {
    const priorByTeam = new Map(previous.teams.map(side => [side.team, side.value]));
    const comparable = current.every(side => priorByTeam.has(side.team));
    const regressed = comparable && current.some(side => side.value < priorByTeam.get(side.team));
    if (!comparable || regressed) {
      if (qualifies) stateMap.set(id, { at: now, teams: current, confirmed: false });
      else stateMap.delete(id);
      return { confirmed: false, reason: regressed ? "provider_cumulative_sot_regression" : "team_identity_changed", regression: regressed };
    }
  }
  if (!qualifies) {
    stateMap.delete(id);
    return { confirmed: false, reason: "sot_signal_not_qualifying", regression: false };
  }
  if (!previous) {
    stateMap.set(id, { at: now, teams: current, confirmed: false });
    return { confirmed: false, reason: "awaiting_second_sot_sample", regression: false };
  }
  const age = Number(now) - Number(previous.at);
  if (!Number.isFinite(age) || age < minIntervalMs || age > maxIntervalMs) {
    stateMap.set(id, { at: now, teams: current, confirmed: false });
    return { confirmed: false, reason: "sot_confirmation_sample_interval_invalid", regression: false };
  }
  stateMap.set(id, { at: now, teams: current, confirmed: true });
  return { confirmed: true, reason: previous.confirmed ? "sot_signal_still_confirmed" : "sot_signal_confirmed_by_second_sample", regression: false };
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
module.exports = { validateRollingSot, confirmSotSignal, readExactSotStat, normalizeStatLabel };
