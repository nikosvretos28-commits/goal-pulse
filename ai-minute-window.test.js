"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isAiMinuteEligible, isCumulativeSotMinute } = require("./ai-minute-window");

test("AI alerts accept only second-half minutes 46 through 88", () => {
  for (const minute of [1, 40, 41, 45, 45.5, 89, 90, 120]) {
    assert.equal(isAiMinuteEligible(minute), false, `minute ${minute} must be rejected`);
  }
  for (const minute of [46, 47, 60, 69, 70, 88]) {
    assert.equal(isAiMinuteEligible(minute), true, `minute ${minute} must be accepted`);
  }
  assert.equal(isAiMinuteEligible(null), false);
  assert.equal(isAiMinuteEligible(Number.NaN), false);
});

test("cumulative 15-SOT trigger is limited to minutes 46 through 69", () => {
  for (const minute of [1, 40, 45, 69.9, 70, 88, 89]) {
    assert.equal(isCumulativeSotMinute(minute), false, `minute ${minute} must be rejected`);
  }
  for (const minute of [46, 47, 60, 69]) {
    assert.equal(isCumulativeSotMinute(minute), true, `minute ${minute} must be accepted`);
  }
});
