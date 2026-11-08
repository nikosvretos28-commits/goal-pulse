"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isAiMinuteEligible, isCumulativeSotMinute } = require("./ai-minute-window");

test("AI alerts accept only integer second-half minutes 46 through 88", () => {
  for (const minute of [1, 40, 41, 45, 89, 90, 120, 45.5, 46.5, null, Number.NaN]) {
    assert.equal(isAiMinuteEligible(minute), false, String(minute));
  }
  for (const minute of [46, 47, 60, 69, 70, 88]) {
    assert.equal(isAiMinuteEligible(minute), true, String(minute));
  }
});

test("explicit first-half and halftime statuses override a misleading clock", () => {
  for (const status of ["1H", "1st half", "First Half", "HT", "Half Time", "1ο ημίχρονο", "Πρώτο ημίχρονο", "ανάπαυλα"]) {
    assert.equal(isAiMinuteEligible(46, status), false, status);
  }
  assert.equal(isAiMinuteEligible(46, "2nd half"), true);
  assert.equal(isAiMinuteEligible(60, "LIVE"), true);
});

test("cumulative 15-SOT trigger is limited to minutes 46 through 69", () => {
  for (const minute of [1, 40, 45, 70, 88, 89, 69.9]) {
    assert.equal(isCumulativeSotMinute(minute), false, String(minute));
  }
  for (const minute of [46, 47, 60, 69]) {
    assert.equal(isCumulativeSotMinute(minute), true, String(minute));
  }
  assert.equal(isCumulativeSotMinute(60, "1st half"), false);
});
