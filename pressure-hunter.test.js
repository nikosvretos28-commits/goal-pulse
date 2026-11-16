"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluatePressureHunter, liveMinuteEligible } = require("./pressure-hunter");

function fixture({ first = [1, 1], second = [0, 0], minute = 62, status = "2nd half" } = {}) {
  const window = values => ({
    available: true,
    sampleMinutes: 8,
    teams: values.map(shotsOnTarget => ({ shotsOnTarget }))
  });
  return {
    minute,
    status,
    teams: [{ shotsOnTarget: 3 }, { shotsOnTarget: 2 }],
    windows: {
      firstEightMinutes: window(first),
      secondEightMinutes: window(second)
    }
  };
}

test("first 8-minute window qualifies at 2 combined SOT; first next-window SOT triggers", () => {
  const result = evaluatePressureHunter(fixture({ second: [1, 0] }));
  assert.equal(result.triggered, true);
  assert.equal(result.level, "DUAL_PRESSURE");
  assert.equal(result.reason, "continuous_sot_flow_first_sot");
  assert.equal(result.evidence.firstEightMinutes.shotsOnTarget, 2);
  assert.equal(result.evidence.secondEightMinutes.shotsOnTargetAtSignal, 1);
  assert.equal(result.evidence.secondEightMinutes.activation, "first_sot");
});

test("first window qualifies using SOT alone without total-shot or off-target fields", () => {
  const result = evaluatePressureHunter(fixture({ first: [2, 0] }));
  assert.equal(result.triggered, false);
  assert.equal(result.reason, "waiting_for_first_sot_in_second_8m");
});

test("first window accepts 4 combined SOT", () => {
  const result = evaluatePressureHunter(fixture({ first: [4, 0] }));
  assert.equal(result.triggered, false);
  assert.equal(result.reason, "waiting_for_first_sot_in_second_8m");
});

test("first window fails when combined SOT are below 2", () => {
  const result = evaluatePressureHunter(fixture({ first: [1, 0], second: [1, 0] }));
  assert.equal(result.triggered, false);
  assert.equal(result.reason, "first_8m_sot_threshold_not_met");
});

test("second window activates on one SOT without a total-shots threshold", () => {
  const result = evaluatePressureHunter(fixture({ second: [0, 1] }));
  assert.equal(result.triggered, true);
  assert.equal(result.evidence.secondEightMinutes.shotsOnTargetAtSignal, 1);
});

test("missing SOT counts fail closed", () => {
  const input = fixture();
  input.windows.firstEightMinutes.teams[0].shotsOnTarget = null;
  assert.equal(evaluatePressureHunter(input).reason, "two_valid_consecutive_8m_windows_required");
});

test("stale or unavailable windows fail closed", () => {
  const input = fixture();
  input.windows.secondEightMinutes.sampleMinutes = 20;
  assert.equal(evaluatePressureHunter(input).reason, "two_valid_consecutive_8m_windows_required");
});

test("finished and halftime matches are rejected", () => {
  assert.equal(liveMinuteEligible(60, "HT"), false);
  assert.equal(liveMinuteEligible(90, "finished"), false);
  assert.equal(evaluatePressureHunter({ ...fixture(), status: "finished" }).reason, "match_not_live");
});

test("only valid in-play minutes are eligible", () => {
  assert.equal(liveMinuteEligible(1, "1st half"), true);
  assert.equal(liveMinuteEligible(120, "extra time"), true);
  assert.equal(liveMinuteEligible(0, "live"), false);
});
