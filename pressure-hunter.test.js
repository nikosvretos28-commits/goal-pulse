"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluatePressureHunter, liveMinuteEligible } = require("./pressure-hunter");

function fixture({ first = [[2, 1], [2, 1]], second = [[0, 0], [0, 0]], minute = 62, status = "2nd half" } = {}) {
  const window = rows => ({
    available: true,
    sampleMinutes: 8,
    teams: rows.map(([totalShots, shotsOnTarget]) => ({
      totalShots,
      shotsOnTarget,
      shotsOffTarget: totalShots - shotsOnTarget
    }))
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

test("first 8-minute window qualifies at 4 shots including at least 2 SOT; alert fires on first next-window shot", () => {
  const result = evaluatePressureHunter(fixture({ second: [[1, 0], [0, 0]] }));
  assert.equal(result.triggered, true);
  assert.equal(result.level, "DUAL_PRESSURE");
  assert.equal(result.reason, "continuous_shot_flow_first_shot");
  assert.equal(result.evidence.firstEightMinutes.totalShots, 4);
  assert.equal(result.evidence.firstEightMinutes.shotsOnTarget, 2);
  assert.equal(result.evidence.secondEightMinutes.totalShotsAtSignal, 1);
});

test("valid first window accepts 3 SOT plus 1 off-target shot", () => {
  const result = evaluatePressureHunter(fixture({ first: [[3, 3], [1, 0]], second: [[0, 0], [0, 0]] }));
  assert.equal(result.triggered, false);
  assert.equal(result.reason, "waiting_for_first_shot_in_second_8m");
});

test("valid first window accepts 4 SOT and does not require off-target shots", () => {
  const result = evaluatePressureHunter(fixture({ first: [[4, 4], [0, 0]], second: [[0, 0], [0, 0]] }));
  assert.equal(result.triggered, false);
  assert.equal(result.reason, "waiting_for_first_shot_in_second_8m");
});

test("first window fails when total shots are below 4", () => {
  const result = evaluatePressureHunter(fixture({ first: [[2, 2], [1, 0]], second: [[1, 0], [0, 0]] }));
  assert.equal(result.triggered, false);
  assert.equal(result.reason, "first_8m_thresholds_not_met");
});

test("first window fails when fewer than 2 SOT are recorded", () => {
  const result = evaluatePressureHunter(fixture({ first: [[4, 1], [0, 0]], second: [[1, 0], [0, 0]] }));
  assert.equal(result.triggered, false);
  assert.equal(result.reason, "first_8m_thresholds_not_met");
});

test("second window does not wait for its own four-shot or two-SOT threshold", () => {
  const result = evaluatePressureHunter(fixture({ second: [[0, 0], [1, 0]] }));
  assert.equal(result.triggered, true);
  assert.equal(result.evidence.secondEightMinutes.totalShotsAtSignal, 1);
});

test("missing shot counts fail closed", () => {
  const input = fixture();
  input.windows.firstEightMinutes.teams[0].totalShots = null;
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
