"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isAiMinuteEligible, isCumulativeSotMinute, isFirstHalfCumulativeSotMinute } = require("./ai-minute-window");

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

test("completed fixtures are never eligible even when a stale minute remains", () => {
  for (const status of ["Finished", "Full Time", "FT", "Ended", "Completed", "AET", "Ολοκληρώθηκε", "Λήξη αγώνα"]) {
    assert.equal(isAiMinuteEligible(54, status), false, status);
    assert.equal(isCumulativeSotMinute(54, status), false, status);
  }
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

test("first-half 8+ combined SOT trigger is eligible only before minute 35", () => {
  for (const minute of [0, 35, 36, 40, 45, 46, 60, 89, 34.5, null, Number.NaN]) {
    assert.equal(isFirstHalfCumulativeSotMinute(minute), false, String(minute));
  }
  for (const minute of [1, 2, 20, 34]) {
    assert.equal(isFirstHalfCumulativeSotMinute(minute), true, String(minute));
  }
});

test("first-half 8+ SOT trigger rejects halftime, second-half, and completed statuses", () => {
  for (const status of ["HT", "Half Time", "Halftime", "2H", "2nd half", "Second Half", "FT", "Finished", "AET", "ανάπαυλα", "2ο ημίχρονο", "δεύτερο ημίχρονο", "Ολοκληρώθηκε"]) {
    assert.equal(isFirstHalfCumulativeSotMinute(30, status), false, status);
  }
  assert.equal(isFirstHalfCumulativeSotMinute(30, "1H"), true);
  assert.equal(isFirstHalfCumulativeSotMinute(30, "LIVE"), true);
});
