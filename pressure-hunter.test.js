"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluatePressureHunter, liveMinuteEligible } = require("./pressure-hunter");

function fixture({ five = [1, 1], ten = [2, 2], total = [3, 3], box = [2, 1], chances = [1, 0] } = {}) {
  return {
    minute: 62,
    status: "2nd half",
    teams: [{ shotsOnTarget: total[0] }, { shotsOnTarget: total[1] }],
    windows: {
      last5m: { available: true, sampleMinutes: 5, teams: five.map((shotsOnTarget, i) => ({ shotsOnTarget, shotsInBox: 1, bigChances: 0 })) },
      last10m: { available: true, sampleMinutes: 10, teams: ten.map((shotsOnTarget, i) => ({ shotsOnTarget, shotsInBox: box[i], bigChances: chances[i] })) }
    }
  };
}

test("basic dual-team pressure requires both teams in both rolling windows", () => {
  const result = evaluatePressureHunter(fixture());
  assert.equal(result.triggered, true);
  assert.equal(result.level, "DUAL_PRESSURE");
  assert.equal(result.evidence.last10mShotsInBox, 3);
  assert.equal(result.evidence.last10mBigChances, 1);
});

test("extreme pressure is independently classified", () => {
  const result = evaluatePressureHunter(fixture({ five: [2, 2], ten: [3, 3], total: [4, 4] }));
  assert.equal(result.triggered, true);
  assert.equal(result.level, "EXTREME");
});

test("one-sided pressure does not trigger", () => {
  const result = evaluatePressureHunter(fixture({ ten: [4, 0], five: [2, 0], total: [6, 0] }));
  assert.equal(result.triggered, false);
  assert.equal(result.level, null);
});

test("supporting stats cannot trigger without mandatory SOT thresholds", () => {
  const input = fixture({ five: [0, 0], ten: [1, 1], total: [2, 2], box: [20, 20], chances: [5, 5] });
  const result = evaluatePressureHunter(input);
  assert.equal(result.triggered, false);
  assert.ok(result.score > 0);
});

test("missing or stale windows fail closed", () => {
  const input = fixture();
  input.windows.last10m.sampleMinutes = 20;
  assert.equal(evaluatePressureHunter(input).reason, "valid_5m_and_10m_windows_required");
});

test("missing SOT never falls back to total shots", () => {
  const input = fixture();
  input.teams = [{ shots: 9 }, { shots: 8 }];
  assert.equal(evaluatePressureHunter(input).reason, "cumulative_sot_unavailable");
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
