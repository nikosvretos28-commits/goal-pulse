"use strict";

function sotTriggerConfirmationKey(eventId, triggerId) {
  return String(eventId) + "::" + String(triggerId);
}

// Return one candidate per independently satisfied protocol trigger.
// Each SOT trigger requires confirmation under its own trigger ID; xG remains
// an independent second-half alternative and never borrows SOT confirmation.
function buildIndependentAiTriggers({
  eligibleMinute,
  firstHalfSotWindow,
  recentSotQualifies,
  cumulativeSotQualifies,
  firstHalfEightSotQualifies,
  manAdvantagePressure,
  xGQualifies,
  confirmedSotTriggerIds = []
} = {}) {
  const confirmed = new Set(confirmedSotTriggerIds);
  const triggers = [];
  const inApprovedAiWindow = Boolean(eligibleMinute || firstHalfSotWindow);
  if ((eligibleMinute || firstHalfSotWindow) && recentSotQualifies && confirmed.has("recent_sot_pressure")) {
    triggers.push({ id: "recent_sot_pressure" });
  }
  if (inApprovedAiWindow && cumulativeSotQualifies && confirmed.has("cumulative_20_sot")) {
    triggers.push({ id: "cumulative_20_sot" });
  }
  if (firstHalfSotWindow && firstHalfEightSotQualifies && confirmed.has("first_half_8_sot")) {
    triggers.push({ id: "first_half_8_sot" });
  }
  if (inApprovedAiWindow && manAdvantagePressure && confirmed.has("man_advantage_pressure")) {
    triggers.push({ id: "man_advantage_pressure" });
  }
  if (inApprovedAiWindow && xGQualifies) {
    triggers.push({ id: "xg_threshold" });
  }
  return triggers;
}

module.exports = { sotTriggerConfirmationKey, buildIndependentAiTriggers };
