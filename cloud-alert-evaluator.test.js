"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateSotMetrics, dualA2HSot90Threshold, evaluateCloudAlert,
  decideCloudAlertPush, recordCloudAlertPush
} = require("./cloud-alert-evaluator");

const base = {
  matchId: "m1", period: "1H", elapsedMinute: 20,
  homeSot: 3, awaySot: 2, recentSot6: 1, recentSot10: 2,
  dataQuality: "valid", confirmed: true, rollingWindowsValid: true
};

test("calculates total SOT, SOT90 and balanced SOT", () => {
  const m = calculateSotMetrics({ homeSot: 3, awaySot: 2, elapsedMinute: 15 });
  assert.equal(m.total, 5);
  assert.equal(m.sot90, 30);
  assert.equal(m.balance, 0.4);
});

test("rejects total shots or missing/invalid SOT values by failing closed", () => {
  const m = calculateSotMetrics({ homeSot: null, awaySot: 5, elapsedMinute: 20 });
  assert.equal(m.valid, false);
});

test("EARLY 1H trigger qualifies with exact SOT-only thresholds", () => {
  const r = evaluateCloudAlert({ ...base, elapsedMinute: 15, homeSot: 3, awaySot: 2, recentSot6: 1 });
  assert.ok(r.triggers.includes("EARLY_1H"));
});

test("SUSTAINED 1H trigger qualifies without a minute cutoff", () => {
  const r = evaluateCloudAlert({ ...base, elapsedMinute: 45, homeSot: 6, awaySot: 4, recentSot10: 2 });
  assert.ok(r.triggers.includes("SUSTAINED_1H"));
});

test("2H B trigger requires each team, balance, SOT90 and recent SOT", () => {
  const r = evaluateCloudAlert({
    ...base, period: "2H", elapsedMinute: 72, homeSot: 5, awaySot: 5,
    recentSot10: 2
  });
  assert.ok(r.triggers.includes("SUSTAINED_B_2H"));
});

test("2H A threshold interpolates between the two approved anchors", () => {
  assert.equal(dualA2HSot90Threshold(55), 32.7);
  assert.equal(dualA2HSot90Threshold(80), 22.5);
  assert.equal(dualA2HSot90Threshold(67.5), 27.6);
});

test("2H A threshold uses endpoint values outside the interpolation anchors", () => {
  assert.equal(dualA2HSot90Threshold(48), 32.7);
  assert.equal(dualA2HSot90Threshold(90), 22.5);
});

test("holds when provider integrity or rolling windows are not confirmed", () => {
  assert.equal(evaluateCloudAlert({ ...base, confirmed: false }).reason, "awaiting_confirmed_sot_sample");
  assert.equal(evaluateCloudAlert({ ...base, rollingWindowsValid: false }).reason, "rolling_sot_window_unreliable");
  assert.equal(evaluateCloudAlert({ ...base, dataQuality: "stale" }).status, "held");
});

test("does not apply to extra time or penalty periods", () => {
  assert.equal(evaluateCloudAlert({ ...base, period: "ET" }).status, "not_applicable");
  assert.equal(evaluateCloudAlert({ ...base, period: "PEN" }).status, "not_applicable");
});

test("first notification and re-alert are limited to two per half", () => {
  let state = {};
  let d = decideCloudAlertPush({ period: "1H", signalId: "s1", qualifies: true, state });
  assert.equal(d.kind, "initial");
  state = recordCloudAlertPush({ state, period: "1H", signalId: "s1" });
  d = decideCloudAlertPush({ period: "1H", signalId: "s2", qualifies: true, goalSinceLastPush: false, state });
  assert.equal(d.send, false);
  assert.equal(d.reason, "re_alert_requires_goal_since_last_push");
  d = decideCloudAlertPush({ period: "1H", signalId: "s3", qualifies: true, goalSinceLastPush: true, state });
  assert.equal(d.kind, "re_alert");
  state = recordCloudAlertPush({ state, period: "1H", signalId: "s3" });
  d = decideCloudAlertPush({ period: "1H", signalId: "s4", qualifies: true, goalSinceLastPush: true, state });
  assert.equal(d.reason, "half_push_limit_reached");
});

test("allows four pushes per match: initial plus re-alert in each half", () => {
  let state = {};
  for (const period of ["1H", "2H"]) {
    const initial = decideCloudAlertPush({ period, signalId: period + "-1", qualifies: true, state });
    assert.equal(initial.kind, "initial");
    state = recordCloudAlertPush({ state, period, signalId: period + "-1" });
    const re = decideCloudAlertPush({ period, signalId: period + "-2", qualifies: true, goalSinceLastPush: true, state });
    assert.equal(re.kind, "re_alert");
    state = recordCloudAlertPush({ state, period, signalId: period + "-2" });
  }
  assert.equal(state["1H"].sentCount + state["2H"].sentCount, 4);
});

test("prevents duplicate delivery of the same signal", () => {
  let state = recordCloudAlertPush({ state: {}, period: "2H", signalId: "same" });
  assert.equal(decideCloudAlertPush({ period: "2H", signalId: "same", qualifies: true, state }).reason, "duplicate_signal");
});
