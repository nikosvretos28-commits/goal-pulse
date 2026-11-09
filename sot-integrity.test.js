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

const { confirmSotSignal } = require("./sot-integrity");
test("does not confirm an SOT spike that the provider reverses on the next sample", () => {
  const stateMap = new Map();
  const first = confirmSotSignal({stateMap,eventId:"match-1",now:100000,qualifies:true,cumulativeByTeam:[{team:"home",value:2},{team:"away",value:6}]});
  const corrected = confirmSotSignal({stateMap,eventId:"match-1",now:160000,qualifies:true,cumulativeByTeam:[{team:"home",value:2},{team:"away",value:0}]});
  assert.equal(first.confirmed,false);
  assert.equal(first.reason,"awaiting_second_sot_sample");
  assert.equal(corrected.confirmed,false);
  assert.equal(corrected.regression,true);
  assert.equal(corrected.reason,"provider_cumulative_sot_regression");
});
test("confirms a qualifying SOT signal only after a stable second sample", () => {
  const stateMap = new Map();
  const first = confirmSotSignal({stateMap,eventId:"match-2",now:100000,qualifies:true,cumulativeByTeam:[{team:"home",value:2},{team:"away",value:6}]});
  const second = confirmSotSignal({stateMap,eventId:"match-2",now:160000,qualifies:true,cumulativeByTeam:[{team:"home",value:2},{team:"away",value:7}]});
  assert.equal(first.confirmed,false);
  assert.equal(second.confirmed,true);
  assert.equal(second.reason,"sot_signal_confirmed_by_second_sample");
});
test("rejects team-side decreases even when the combined SOT total is unchanged", () => {
  const stateMap = new Map();
  confirmSotSignal({stateMap,eventId:"match-3",now:100000,qualifies:true,cumulativeByTeam:[{team:"home",value:2},{team:"away",value:6}]});
  const second = confirmSotSignal({stateMap,eventId:"match-3",now:160000,qualifies:true,cumulativeByTeam:[{team:"home",value:3},{team:"away",value:5}]});
  assert.equal(second.confirmed,false);
  assert.equal(second.regression,true);
});
test("does not confirm when either team's cumulative SOT is missing", () => {
  const stateMap = new Map();
  const result = confirmSotSignal({stateMap,eventId:"match-4",now:100000,qualifies:true,cumulativeByTeam:[{team:"home",value:2},{team:"away",value:null}]});
  assert.equal(result.confirmed,false);
  assert.equal(result.reason,"complete_team_sot_unavailable");
});
test("a non-qualifying scan clears a pending SOT confirmation", () => {
  const stateMap = new Map();
  confirmSotSignal({stateMap,eventId:"match-5",now:100000,qualifies:true,cumulativeByTeam:[{team:"home",value:2},{team:"away",value:6}]});
  const result = confirmSotSignal({stateMap,eventId:"match-5",now:160000,qualifies:false,cumulativeByTeam:[{team:"home",value:2},{team:"away",value:6}]});
  assert.equal(result.confirmed,false);
  assert.equal(result.reason,"sot_signal_not_qualifying");
  assert.equal(stateMap.has("match-5"),false);
});

test("detects an 8-to-2 provider correction even after the trigger stops qualifying", () => {
  const stateMap = new Map();
  confirmSotSignal({stateMap,eventId:"match-6",now:100000,qualifies:true,cumulativeByTeam:[{team:"home",value:2},{team:"away",value:6}]});
  const corrected = confirmSotSignal({stateMap,eventId:"match-6",now:160000,qualifies:false,cumulativeByTeam:[{team:"home",value:2},{team:"away",value:0}]});
  assert.equal(corrected.confirmed,false);
  assert.equal(corrected.regression,true);
  assert.equal(corrected.reason,"provider_cumulative_sot_regression");
  assert.equal(stateMap.has("match-6"),false);
});
