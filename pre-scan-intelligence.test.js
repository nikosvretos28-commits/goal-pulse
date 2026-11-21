"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPreScanTracker } = require("./pre-scan-intelligence");

test("tracks live match observations using exact cumulative SOT only", () => {
  const tracker = createPreScanTracker();
  const first = tracker.observe({ eventId:"m1", at:1000, minute:3, status:"1st Half", home:"A", away:"B",
    teams:[{team:"A",shotsOnTarget:1,totalShots:9,shotsOffTarget:7},{team:"B",shotsOnTarget:0,totalShots:4,shotsOffTarget:4}] });
  const second = tracker.observe({ eventId:"m1", at:121000, minute:5, status:"1st Half",
    teams:[{team:"A",shotsOnTarget:3,totalShots:20,shotsOffTarget:15},{team:"B",shotsOnTarget:1,totalShots:9,shotsOffTarget:7}] });
  assert.equal(first.observationCount, 1);
  assert.equal(second.observationCount, 2);
  assert.deepEqual(second.deltaSot, {A:2,B:1});
  assert.equal(second.trackedMinutes, 2);
});

test("does not infer SOT from total shots or off-target data", () => {
  const tracker = createPreScanTracker();
  assert.equal(tracker.observe({eventId:"m2",at:1000,minute:8,status:"1st Half",
    teams:[{team:"A",totalShots:20,shotsOffTarget:15},{team:"B",shotsOnTarget:0}]}), null);
  assert.equal(tracker.size(), 0);
});

test("ignores completed, invalid-minute and incomplete observations", () => {
  const tracker = createPreScanTracker();
  const base = {eventId:"m3",at:1000,minute:90,teams:[{team:"A",shotsOnTarget:2},{team:"B",shotsOnTarget:1}]};
  assert.equal(tracker.observe({...base,status:"Full Time"}), null);
  assert.equal(tracker.observe({...base,minute:0,status:"1st Half"}), null);
  assert.equal(tracker.observe({...base,teams:[{team:"A",shotsOnTarget:2},{team:"B",shotsOnTarget:null}],status:"2nd Half"}), null);
});

test("restores persisted observation history for a later process cycle", () => {
  const tracker = createPreScanTracker();
  const payload = {home:"A",away:"B",league:"League",firstSeenAt:1000,lastSeenAt:61000,
    observations:[{at:1000,minute:1,teams:[{team:"A",shotsOnTarget:0},{team:"B",shotsOnTarget:0}]},
      {at:61000,minute:2,teams:[{team:"A",shotsOnTarget:1},{team:"B",shotsOnTarget:0}]}]};
  assert.equal(tracker.restore("m4",payload),true);
  assert.equal(tracker.get("m4").observationCount,2);
  assert.deepEqual(tracker.get("m4").deltaSot,{A:1,B:0});
});
