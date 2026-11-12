"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isVerifiedSecondHalfMieRecord } = require("./mie-alert-verification");

const valid = { period: "second_half", minute: 78, outcome: "won", scoreScope: "full_time", settlementProvider: "ESPN", settlementFixtureId: "fixture-123", finalScore: "2-1" };

test("accepts a verified second-half full-time settlement", () => assert.equal(isVerifiedSecondHalfMieRecord(valid), true));
test("rejects first-half scope for a second-half alert even when scores match", () => assert.equal(isVerifiedSecondHalfMieRecord({ ...valid, scoreScope: "first_half" }), false));
test("rejects missing provider or fixture identity", () => {
  assert.equal(isVerifiedSecondHalfMieRecord({ ...valid, settlementProvider: "" }), false);
  assert.equal(isVerifiedSecondHalfMieRecord({ ...valid, settlementFixtureId: "" }), false);
});
test("rejects invalid scores and out-of-window minutes", () => {
  assert.equal(isVerifiedSecondHalfMieRecord({ ...valid, finalScore: "2:x" }), false);
  assert.equal(isVerifiedSecondHalfMieRecord({ ...valid, minute: 89 }), false);
  assert.equal(isVerifiedSecondHalfMieRecord({ ...valid, minute: 45 }), false);
});
test("rejects pending and non-second-half records", () => {
  assert.equal(isVerifiedSecondHalfMieRecord({ ...valid, outcome: "pending" }), false);
  assert.equal(isVerifiedSecondHalfMieRecord({ ...valid, period: "first_half" }), false);
});
