"use strict";

// Cloud Alert v0.2 isolated evaluator.
// Pure functions only: no server, provider, database, or push-pipeline imports.
// Activation remains the responsibility of a later, explicitly reviewed integration.

const THRESHOLDS = Object.freeze({
  early1H: Object.freeze({ total: 5, each: 2, sot90: 30, balance: 0.30, recent6: 1 }),
  sustained1H: Object.freeze({ total: 10, sot90: 22, balance: 0.30, recent10: 2 }),
  sustainedB2H: Object.freeze({ total: 10, each: 4, sot90: 12.5, balance: 0.35, recent10: 2 }),
  dualA2H: Object.freeze({ each: 10, total: 20, sot90At55: 32.7, sot90At80: 22.5, recent10: 1 })
});

function finiteNonNegative(value) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function calculateSotMetrics({ homeSot, awaySot, elapsedMinute }) {
  const home = finiteNonNegative(homeSot);
  const away = finiteNonNegative(awaySot);
  const minute = finiteNonNegative(elapsedMinute);
  if (home == null || away == null || minute == null || minute <= 0) {
    return { valid: false, reason: "invalid_sot_or_match_minute" };
  }
  const total = home + away;
  return {
    valid: true,
    home,
    away,
    total,
    sot90: 90 * total / minute,
    balance: total === 0 ? 0 : Math.min(home, away) / total
  };
}

// v0.2 supplies two DUAL-A anchors (55' and 80') and linear
// interpolation between them. It does not define extrapolation/clamping
// outside that interval, so fail closed rather than inventing thresholds.
function dualA2HSot90Threshold(elapsedMinute) {
  if (elapsedMinute === null || elapsedMinute === undefined ||
      (typeof elapsedMinute === "string" && elapsedMinute.trim() === "")) return null;
  const minute = Number(elapsedMinute);
  if (!Number.isFinite(minute) || minute < 55 || minute > 80) return null;
  const t = (minute - 55) / (80 - 55);
  return THRESHOLDS.dualA2H.sot90At55 +
    t * (THRESHOLDS.dualA2H.sot90At80 - THRESHOLDS.dualA2H.sot90At55);
}

function evaluateCloudAlert(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return { status: "held", reason: "snapshot_missing", triggers: [] };
  }
  if (!snapshot.matchId) return { status: "held", reason: "match_id_missing", triggers: [] };
  if (!["1H", "2H"].includes(snapshot.period)) {
    return { status: "not_applicable", reason: "outside_regular_play_halves", triggers: [] };
  }
  if (snapshot.dataQuality !== "valid") {
    return { status: "held", reason: snapshot.dataQualityReason || "data_quality_not_confirmed", triggers: [] };
  }
  if (snapshot.confirmed !== true) {
    return { status: "held", reason: "awaiting_confirmed_sot_sample", triggers: [] };
  }
  if (snapshot.rollingWindowsValid !== true) {
    return { status: "held", reason: "rolling_sot_window_unreliable", triggers: [] };
  }

  const metrics = calculateSotMetrics(snapshot);
  if (!metrics.valid) return { status: "held", reason: metrics.reason, triggers: [] };

  // Rolling windows are evaluated independently: a missing R6 must not
  // suppress an R10-only trigger, and a missing R10 must not suppress EARLY.
  const r6 = finiteNonNegative(snapshot.recentSot6);
  const r10 = finiteNonNegative(snapshot.recentSot10);
  const triggers = [];

  if (snapshot.period === "1H") {
    const e = THRESHOLDS.early1H;
    if (r6 != null && metrics.total >= e.total && metrics.home >= e.each && metrics.away >= e.each &&
        metrics.sot90 >= e.sot90 && metrics.balance >= e.balance && r6 >= e.recent6) {
      triggers.push("EARLY_1H");
    }
    const s = THRESHOLDS.sustained1H;
    if (r10 != null && metrics.total >= s.total && metrics.sot90 >= s.sot90 &&
        metrics.balance >= s.balance && r10 >= s.recent10) {
      triggers.push("SUSTAINED_1H");
    }
  } else {
    const b = THRESHOLDS.sustainedB2H;
    if (r10 != null && metrics.total >= b.total && metrics.home >= b.each && metrics.away >= b.each &&
        metrics.sot90 >= b.sot90 && metrics.balance >= b.balance && r10 >= b.recent10) {
      triggers.push("SUSTAINED_B_2H");
    }
    const a = THRESHOLDS.dualA2H;
    const aSot90 = dualA2HSot90Threshold(snapshot.elapsedMinute);
    if (r10 != null && aSot90 != null && metrics.total >= a.total &&
        metrics.home >= a.each && metrics.away >= a.each &&
        metrics.sot90 >= aSot90 && r10 >= a.recent10) {
      triggers.push("DUAL_A_2H");
    }
  }

  return {
    status: triggers.length ? "qualified" : "not_qualified",
    reason: triggers.length ? "one_or_more_cloud_triggers_met" : "no_cloud_trigger_met",
    matchId: String(snapshot.matchId),
    period: snapshot.period,
    elapsedMinute: Number(snapshot.elapsedMinute),
    metrics,
    recentSot6: r6,
    recentSot10: r10,
    triggers
  };
}

function validateHalfState(half) {
  if (half == null) return { valid: true, sentCount: 0, sentSignalIds: [] };
  if (typeof half !== "object" || !Number.isInteger(half.sentCount) ||
      half.sentCount < 0 || half.sentCount > 2 || !Array.isArray(half.sentSignalIds) ||
      half.sentSignalIds.length !== half.sentCount ||
      half.sentSignalIds.some(id => id === null || id === undefined || String(id).trim() === "")) {
    return { valid: false };
  }
  const ids = half.sentSignalIds.map(String);
  if (new Set(ids).size !== ids.length) return { valid: false };
  return { valid: true, sentCount: half.sentCount, sentSignalIds: ids };
}

// Per-half delivery policy: one initial push plus one re-alert after a new
// goal and a genuinely new qualifying signal. Persist state only after a
// push provider confirms successful delivery.
function decideCloudAlertPush({ period, signalId, qualifies, goalSinceLastPush, state = {} }) {
  if (!["1H", "2H"].includes(period)) return { send: false, reason: "invalid_period" };
  if (!qualifies) return { send: false, reason: "signal_not_qualified" };
  if (signalId === null || signalId === undefined || String(signalId).trim() === "") {
    return { send: false, reason: "signal_id_missing" };
  }

  const half = validateHalfState(state[period]);
  const other = validateHalfState(state[period === "1H" ? "2H" : "1H"]);
  if (!half.valid || !other.valid) return { send: false, reason: "invalid_push_state" };
  if (half.sentSignalIds.includes(String(signalId))) return { send: false, reason: "duplicate_signal" };
  if (half.sentCount >= 2) return { send: false, reason: "half_push_limit_reached" };
  if (half.sentCount + other.sentCount >= 4) return { send: false, reason: "match_push_limit_reached" };
  if (half.sentCount === 0) return { send: true, kind: "initial", reason: "first_push_in_half" };
  if (half.sentCount === 1 && goalSinceLastPush === true) {
    return { send: true, kind: "re_alert", reason: "new_goal_and_new_qualifying_signal" };
  }
  return { send: false, reason: "re_alert_requires_goal_since_last_push" };
}

function recordCloudAlertPush({ state = {}, period, signalId }) {
  if (!["1H", "2H"].includes(period) ||
      signalId === null || signalId === undefined || String(signalId).trim() === "") {
    throw new TypeError("period and signalId are required");
  }
  const current = validateHalfState(state[period]);
  const other = validateHalfState(state[period === "1H" ? "2H" : "1H"]);
  if (!current.valid || !other.valid) throw new TypeError("Invalid Cloud Alert push state");
  if (current.sentSignalIds.includes(String(signalId))) {
    throw new Error("Duplicate Cloud Alert signal cannot be recorded");
  }
  if (current.sentCount >= 2) throw new RangeError("Cloud Alert maximum of two pushes per half exceeded");
  const total = current.sentCount + other.sentCount;
  if (total >= 4) throw new RangeError("Cloud Alert maximum of four pushes per match exceeded");
  return {
    ...state,
    [period]: {
      sentCount: current.sentCount + 1,
      sentSignalIds: [...current.sentSignalIds, String(signalId)]
    }
  };
}

module.exports = {
  THRESHOLDS,
  calculateSotMetrics,
  dualA2HSot90Threshold,
  evaluateCloudAlert,
  decideCloudAlertPush,
  recordCloudAlertPush
};
