"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createCloudAlertScanner, numericMinute, matchPeriod, getRecentSot10 } = require("./cloud-alert-scanner");

test("parses stoppage time without losing added minutes", () => {
  assert.equal(numericMinute("45+3′"), 48);
  assert.equal(numericMinute("90+4"), 94);
  assert.equal(numericMinute("HT"), null);
});

test("classifies regular halves and excludes HT, extra time, penalties and finished matches", () => {
  assert.equal(matchPeriod({ statusText: "1st Half" }, 45), "1H");
  assert.equal(matchPeriod({ statusText: "2nd Half" }, 46), "2H");
  assert.equal(matchPeriod({ statusText: "Half Time" }, 45), null);
  assert.equal(matchPeriod({ statusText: "Extra Time" }, 95), null);
  assert.equal(matchPeriod({ statusText: "Penalty Shootout" }, 120), null);
  assert.equal(matchPeriod({ statusText: "FT" }, 90), null);
  assert.equal(matchPeriod({ statusText: "Finished" }, 90), null);
  assert.equal(matchPeriod({ statusText: "Postponed" }, 0), null);
  assert.equal(matchPeriod({}, 48), null, "45+ stoppage cannot be assumed to be the second half");
  assert.equal(matchPeriod({}, 45), "1H");
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

test("rejects blank SOT values instead of coercing them to zero", () => {
  const { getTeamSot } = require("./cloud-alert-scanner");
  assert.equal(getTeamSot({ teams: [
    { homeAway: "home", shotsOnTarget: " " },
    { homeAway: "away", shotsOnTarget: "2" }
  ] }), null);
  assert.equal(getRecentSot10({ trend: { window10m: {
    available: true, sampleMinutes: 10,
    teams: [{ shotsOnTarget: "" }, { shotsOnTarget: 1 }]
  } } }), null);
});

test("a provider SOT regression resets the two-sample confirmation window", async () => {
  let clock = Date.parse("2026-11-20T08:10:00Z");
  let sampleIndex = 0;
  const values = [[6, 4], [5, 4], [6, 4], [6, 4]];
  const saved = [];
  const match = () => ({
    eventId: "fixture-regression", home: "Home", away: "Away", minute: "40",
    statusText: "1st Half", statsAvailable: true, statsSource: "ESPN",
    homeScore: 0, awayScore: 0,
    teams: [
      { homeAway: "home", shotsOnTarget: values[sampleIndex][0] },
      { homeAway: "away", shotsOnTarget: values[sampleIndex][1] }
    ],
    trend: { window10m: { available: true, sampleMinutes: 10, teams: [
      { shotsOnTarget: 1 }, { shotsOnTarget: 1 }
    ] } }
  });
  const runtime = {
    async recordSnapshot() { return { valid: true, value: 1 }; },
    async recordShadowCandidate(candidate) { saved.push(candidate); return { saved: true }; }
  };
  const scanner = createCloudAlertScanner({
    baseUrl: "http://127.0.0.1:3000", runtime,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        const body = { updatedAt: new Date(clock).toISOString(), matches: [match()] };
        sampleIndex++;
        return body;
      }
    }),
    now: () => clock,
    logger: { info() {}, warn() {} }
  });
  const results = [];
  for (let i = 0; i < values.length; i++) {
    results.push(await scanner.runOnce());
    clock += 60_000;
  }
  assert.deepEqual(results.map(result => result.qualified), [0, 0, 0, 1]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].confirmation, "two_monotonic_samples");
});
