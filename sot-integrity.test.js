"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateRollingSot } = require("./sot-integrity");
test("rejects rolling SOT greater than cumulative match SOT", () => {
  const r=validateRollingSot({memoryDelta:3,persistedDelta:3,cumulativeTotal:2});
  assert.equal(r.value,0); assert.equal(r.valid,false); assert.equal(r.reason,"rolling_exceeds_cumulative");
});
test("uses conservative lower value when baselines disagree", () => {
  const r=validateRollingSot({memoryDelta:3,persistedDelta:0,cumulativeTotal:8});
  assert.equal(r.value,0); assert.equal(r.valid,true); assert.equal(r.reason,"conservative_minimum_on_disagreement");
});
test("accepts matching independent SOT readings", () => {
  const r=validateRollingSot({memoryDelta:3,persistedDelta:3,cumulativeTotal:8});
  assert.equal(r.value,3); assert.equal(r.valid,true); assert.equal(r.reason,"corroborated");
});
test("a single baseline still requires cumulative SOT validation", () => {
  assert.equal(validateRollingSot({memoryDelta:null,persistedDelta:2,cumulativeTotal:4}).value,2);
  assert.equal(validateRollingSot({memoryDelta:null,persistedDelta:2,cumulativeTotal:null}).value,0);
});
test("missing rolling baselines fail closed", () => {
  const r=validateRollingSot({memoryDelta:null,persistedDelta:null,cumulativeTotal:5});
  assert.equal(r.value,0); assert.equal(r.valid,false);
});
