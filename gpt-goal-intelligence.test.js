"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateGptGoalIntelligence, liveEligible } = require("./gpt-goal-intelligence");

const base = { minute: 18, status: "1st Half", teams: [{shotsOnTarget: 4},{shotsOnTarget: 2}],
  window5m: {available:true,sampleMinutes:5,teams:[{shotsOnTarget:2},{shotsOnTarget:1}]},
  window10m: {available:true,sampleMinutes:10,teams:[{shotsOnTarget:3},{shotsOnTarget:1}]} };

test("activates explosive and sustained SOT triggers in first half", () => {
  const r = evaluateGptGoalIntelligence(base);
  assert.equal(r.triggered, true);
  assert.ok(r.triggers.includes("EXPLOSIVE_5M"));
  assert.ok(r.triggers.includes("SUSTAINED_PRESSURE_10M"));
});
test("supports late stoppage and extra-time minutes without fixed cutoff", () => {
  assert.equal(liveEligible(90, "2nd Half"), true);
  assert.equal(liveEligible(105, "Extra Time"), true);
  assert.equal(evaluateGptGoalIntelligence({...base, minute: 105, status:"Extra Time"}).eligible, true);
});
test("rejects completed match", () => assert.equal(liveEligible(90, "Full Time"), false));
test("fails closed when cumulative SOT are missing", () => {
  const r = evaluateGptGoalIntelligence({...base, teams:[{shotsOnTarget:4},{shotsOnTarget:null}]});
  assert.equal(r.triggered, false);
  assert.equal(r.reason, "complete_cumulative_sot_required");
});
test("does not treat total shots or off-target values as SOT", () => {
  const r = evaluateGptGoalIntelligence({...base, teams:[{shotsOnTarget:0,totalShots:20,shotsOffTarget:8},{shotsOnTarget:0,totalShots:18,shotsOffTarget:9}],
    window5m:{available:true,sampleMinutes:5,teams:[{shotsOnTarget:0},{shotsOnTarget:0}]},
    window10m:{available:true,sampleMinutes:10,teams:[{shotsOnTarget:0},{shotsOnTarget:0}]}});
  assert.equal(r.triggered, false);
});
test("does not trigger on stale or malformed rolling windows", () => {
  const r = evaluateGptGoalIntelligence({...base, window5m:{available:true,sampleMinutes:15,teams:[{shotsOnTarget:5},{shotsOnTarget:0}]}});
  assert.equal(r.evidence.rolling5m, null);
});
