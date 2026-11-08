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

const { readExactSotStat } = require("./sot-integrity");
test("exact SOT parser accepts only explicit total SOT labels", () => {
  const rows = [
    { key: "shots_on_target_inside_box", home: 3, away: 1 },
    { key: "total_shots", home: 12, away: 8 }
  ];
  assert.equal(readExactSotStat(rows, "home"), null);
  assert.equal(readExactSotStat(rows, "away"), null);
});
test("exact SOT parser accepts explicit shots-on-target totals", () => {
  const rows = [
    { key: "shots_on_target", home: 1, away: 0 },
    { key: "shots_on_target_inside_box", home: 3, away: 1 }
  ];
  assert.equal(readExactSotStat(rows, "home"), 1);
  assert.equal(readExactSotStat(rows, "away"), 0);
});
test("exact SOT parser rejects qualified labels and total shots", () => {
  const rows = [
    { title: "Shots on Target Inside Box", home: 4, away: 2 },
    { title: "Total Shots", home: 10, away: 7 }
  ];
  assert.equal(readExactSotStat(rows, "home"), null);
  assert.equal(readExactSotStat(rows, "away"), null);
});
