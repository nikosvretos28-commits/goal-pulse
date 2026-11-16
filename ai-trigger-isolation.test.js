"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { sotTriggerConfirmationKey, buildIndependentAiTriggers } = require("./ai-trigger-isolation");

test("each SOT trigger has a distinct confirmation key", () => {
  assert.notEqual(
    sotTriggerConfirmationKey("match-1", "recent_sot_pressure"),
    sotTriggerConfirmationKey("match-1", "cumulative_20_sot")
  );
});

test("all independently qualified triggers are returned separately", () => {
  const triggers = buildIndependentAiTriggers({
    eligibleMinute: true,
    firstHalfSotWindow: true,
    cumulativeSotWindow: true,
    recentSotQualifies: true,
    cumulativeSotQualifies: true,
    firstHalfEightSotQualifies: true,
    manAdvantagePressure: true,
    xGQualifies: true,
    confirmedSotTriggerIds: [
      "recent_sot_pressure",
      "cumulative_20_sot",
      "first_half_8_sot",
      "man_advantage_pressure"
    ]
  });
  assert.deepEqual(triggers.map(item => item.id), [
    "recent_sot_pressure",
    "cumulative_20_sot",
    "first_half_8_sot",
    "man_advantage_pressure",
    "xg_threshold"
  ]);
});

test("one SOT trigger cannot borrow another trigger's confirmation", () => {
  const triggers = buildIndependentAiTriggers({
    eligibleMinute: true,
    recentSotQualifies: true,
    cumulativeSotQualifies: true,
    confirmedSotTriggerIds: ["recent_sot_pressure"]
  });
  assert.deepEqual(triggers.map(item => item.id), ["recent_sot_pressure"]);
});

test("xG remains independent of SOT confirmation", () => {
  const triggers = buildIndependentAiTriggers({
    eligibleMinute: true,
    xGQualifies: true,
    confirmedSotTriggerIds: []
  });
  assert.deepEqual(triggers.map(item => item.id), ["xg_threshold"]);
});

test("first-half window admits all approved non-Hunter AI trigger families", () => {
  const firstHalf = buildIndependentAiTriggers({
    firstHalfSotWindow: true,
    cumulativeSotWindow: true,
    recentSotQualifies: true,
    firstHalfEightSotQualifies: true,
    cumulativeSotQualifies: true,
    manAdvantagePressure: true,
    xGQualifies: true,
    confirmedSotTriggerIds: ["recent_sot_pressure", "first_half_8_sot", "cumulative_20_sot", "man_advantage_pressure"]
  });
  assert.deepEqual(firstHalf.map(item => item.id), [
    "recent_sot_pressure",
    "cumulative_20_sot",
    "first_half_8_sot",
    "man_advantage_pressure",
    "xg_threshold"
  ]);
});


test("all non-Hunter AI protocols accept first-half and second-half approved windows", () => {
  const firstHalf = buildIndependentAiTriggers({
    eligibleMinute: false,
    firstHalfSotWindow: true,
    cumulativeSotWindow: true,
    recentSotQualifies: false,
    cumulativeSotQualifies: true,
    firstHalfEightSotQualifies: false,
    manAdvantagePressure: true,
    xGQualifies: true,
    confirmedSotTriggerIds: ["cumulative_20_sot", "man_advantage_pressure"]
  });
  assert.deepEqual(firstHalf.map(item => item.id), [
    "cumulative_20_sot",
    "man_advantage_pressure",
    "xg_threshold"
  ]);
});

test("non-Hunter AI protocols remain blocked outside both approved windows", () => {
  const outside = buildIndependentAiTriggers({
    eligibleMinute: false,
    firstHalfSotWindow: false,
    recentSotQualifies: true,
    cumulativeSotQualifies: true,
    firstHalfEightSotQualifies: true,
    manAdvantagePressure: true,
    xGQualifies: true,
    confirmedSotTriggerIds: [
      "recent_sot_pressure", "cumulative_20_sot", "first_half_8_sot", "man_advantage_pressure"
    ]
  });
  assert.deepEqual(outside, []);
});


test("20+ cumulative SOT trigger is independently allowed through minute 65 in either half", () => {
  const firstHalfLate = buildIndependentAiTriggers({
    eligibleMinute: false,
    firstHalfSotWindow: false,
    cumulativeSotWindow: true,
    cumulativeSotQualifies: true,
    confirmedSotTriggerIds: ["cumulative_20_sot"]
  });
  assert.deepEqual(firstHalfLate.map(item => item.id), ["cumulative_20_sot"]);

  const secondHalfThrough65 = buildIndependentAiTriggers({
    eligibleMinute: true,
    firstHalfSotWindow: false,
    cumulativeSotWindow: true,
    cumulativeSotQualifies: true,
    confirmedSotTriggerIds: ["cumulative_20_sot"]
  });
  assert.deepEqual(secondHalfThrough65.map(item => item.id), ["cumulative_20_sot"]);
});

test("20+ cumulative SOT trigger remains blocked when its own minute window is false", () => {
  const outside = buildIndependentAiTriggers({
    eligibleMinute: true,
    firstHalfSotWindow: false,
    cumulativeSotWindow: false,
    cumulativeSotQualifies: true,
    confirmedSotTriggerIds: ["cumulative_20_sot"]
  });
  assert.deepEqual(outside, []);
});
