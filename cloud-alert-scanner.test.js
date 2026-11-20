"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createCloudAlertScanner, numericMinute, matchPeriod, getRecentSot10 } = require("./cloud-alert-scanner");

test("parses stoppage time without losing added minutes", () => {
  assert.equal(numericMinute("45+3′"), 48);
  assert.equal(numericMinute("90+4"), 94);
  assert.equal(numericMinute("HT"), null);
});

test("classifies regular halves and excludes HT, extra time and penalties", () => {
  assert.equal(matchPeriod({ statusText: "1st Half" }, 45), "1H");
  assert.equal(matchPeriod({ statusText: "2nd Half" }, 46), "2H");
  assert.equal(matchPeriod({ statusText: "Half Time" }, 45), null);
  assert.equal(matchPeriod({ statusText: "Extra Time" }, 95), null);
  assert.equal(matchPeriod({ statusText: "Penalty Shootout" }, 120), null);
});

test("accepts only a measured ten-minute SOT window", () => {
  const match = { trend: { window10m: { available: true, sampleMinutes: 10, teams: [
    { shotsOnTarget: 1 }, { shotsOnTarget: 2 }
  ] } } };
  assert.equal(getRecentSot10(match), 3);
  assert.equal(getRecentSot10({ trend: { window10m: { available: true, sampleMinutes: 4, teams: [{shotsOnTarget:1},{shotsOnTarget:2}] } } }), null);
});

test("independent scanner persists shadow candidates but never invokes push delivery", async () => {
  let clock = Date.parse("2026-11-20T07:30:00Z");
  const saved = [];
  const snapshots = [];
  const runtime = {
    async recordSnapshot(sample) {
      snapshots.push(sample);
      return { valid: true, value: 1 };
    },
    async recordShadowCandidate(candidate) {
      saved.push(candidate);
      return { saved: true };
    },
    async processCandidate() {
      throw new Error("push delivery must never be called by the shadow scanner");
    }
  };
  const match = {
    eventId: "fixture-1", home: "Home", away: "Away", minute: "15",
    statusText: "1st Half", statsAvailable: true, statsSource: "ESPN+PitchAPI",
    homeScore: 0, awayScore: 0,
    teams: [
      { homeAway: "home", shotsOnTarget: 3 },
      { homeAway: "away", shotsOnTarget: 2 }
    ],
    trend: { window10m: { available: false, sampleMinutes: null, teams: [] } }
  };
  const requestedUrls = [];
  const fetchImpl = async url => {
    requestedUrls.push(url);
    return {
    ok: true,
    async json() { return { updatedAt: new Date(clock).toISOString(), matches: [match] }; }
  };
  };
  const scanner = createCloudAlertScanner({
    baseUrl: "http://127.0.0.1:3000",
    runtime,
    fetchImpl,
    now: () => clock,
    logger: { info() {}, warn() {} }
  });
  const first = await scanner.runOnce();
  assert.equal(first.qualified, 0);
  clock += 60_000;
  const second = await scanner.runOnce();
  assert.equal(second.qualified, 1);
  assert.equal(snapshots.length, 2);
  assert.equal(saved.length, 1);
  assert.ok(requestedUrls.every(url => url.includes("scope=cloud-alert")));
  assert.deepEqual(saved[0].triggers, ["EARLY_1H"]);
});
