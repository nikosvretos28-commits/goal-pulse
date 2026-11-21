"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { calculatePowerRankingScore, calculateAutonomousPowerRankingScore, confirmAutonomousPowerRankingObservation, isPowerRankingMinuteEligible, shouldEmitAutonomousPowerRankingAlert } = require("./power-ranking-trigger");

function makeWindow(sampleMinutes, teams) {
  return { available: true, sampleMinutes, teams };
}

test("Power Ranking score matches the displayed weighted formula and rounds to an integer", () => {
  const score = calculatePowerRankingScore({
    teams: [
      { shotsOnTarget: 5, xG: 1.8, dangerousAttacks: 30, attacks: 70 },
      { shotsOnTarget: 4, xG: 1.4, dangerousAttacks: 24, attacks: 62 }
    ],
    trend: {
      window5m: makeWindow(5, [
        { shotsOnTarget: 2 }, { shotsOnTarget: 1 }
      ]),
      window10m: makeWindow(10, [
        { shotsOnTarget: 3, dangerousAttacks: 9, attacks: 20 },
        { shotsOnTarget: 2, dangerousAttacks: 8, attacks: 18 }
      ])
    }
  });
  assert.equal(score, 91);
});

test("missing or stale statistics contribute zero and never fabricate a score", () => {
  assert.equal(calculatePowerRankingScore({ teams: [], trend: {} }), 0);
  // Missing SOT on one side must not be imputed; valid xG still contributes its own points.
  assert.equal(calculatePowerRankingScore({
    teams: [{ shotsOnTarget: 5, xG: 1 }, { shotsOnTarget: null, xG: 2 }],
    trend: { window5m: makeWindow(20, [{ shotsOnTarget: 5 }, { shotsOnTarget: 5 }]) }
  }), 18);
  assert.equal(calculatePowerRankingScore({
    teams: [{ shotsOnTarget: null, xG: null }, { shotsOnTarget: null, xG: null }],
    trend: {}
  }), 0);
});

test("Power Ranking first-half window is 1–34 inclusive", () => {
  assert.equal(isPowerRankingMinuteEligible(1, "live"), true);
  assert.equal(isPowerRankingMinuteEligible(34, "1st half"), true);
  assert.equal(isPowerRankingMinuteEligible(35, "1st half"), false);
  assert.equal(isPowerRankingMinuteEligible(36, "1st half"), false);
  assert.equal(isPowerRankingMinuteEligible(45, "1st half"), false);
  assert.equal(isPowerRankingMinuteEligible(35, "2nd half"), false);
  assert.equal(isPowerRankingMinuteEligible(34, "1ο ημίχρονο"), true);
  assert.equal(isPowerRankingMinuteEligible(34, "first_half"), true);
});

test("Power Ranking second-half window is 46–84 inclusive", () => {
  assert.equal(isPowerRankingMinuteEligible(46, "2nd half"), true);
  assert.equal(isPowerRankingMinuteEligible(84, "live"), true);
  for (const minute of [85, 86, 87, 88]) assert.equal(isPowerRankingMinuteEligible(minute, "live"), false);
  assert.equal(isPowerRankingMinuteEligible(45, "2nd half"), false);
  assert.equal(isPowerRankingMinuteEligible(89, "2nd half"), false);
  assert.equal(isPowerRankingMinuteEligible(60, "1st half"), false);
  assert.equal(isPowerRankingMinuteEligible(60, "2ο ημίχρονο"), true);
  assert.equal(isPowerRankingMinuteEligible(60, "second_half"), true);
  assert.equal(isPowerRankingMinuteEligible(60, "first_half"), false);
});

test("halftime and completed matches are always rejected", () => {
  assert.equal(isPowerRankingMinuteEligible(46, "HT"), false);
  assert.equal(isPowerRankingMinuteEligible(60, "finished"), false);
});

test("autonomous Power Ranking requires score above 65, SOT qualification, and eligibility", () => {
  assert.equal(shouldEmitAutonomousPowerRankingAlert({ score: 65, eligible: true, qualified: true }), false);
  assert.equal(shouldEmitAutonomousPowerRankingAlert({ score: 66, eligible: false, qualified: true }), false);
  assert.equal(shouldEmitAutonomousPowerRankingAlert({ score: 100, eligible: true, qualified: false }), false);
  assert.equal(shouldEmitAutonomousPowerRankingAlert({ score: 66, eligible: true, qualified: true }), true);
});

test("autonomous model weights SOT 65 points and records all six score components", () => {
  const result = calculateAutonomousPowerRankingScore({
    teams: [
      { shotsOnTarget: 3, xG: 1.5, dangerousAttacks: 8, attacks: 20 },
      { shotsOnTarget: 2, xG: 1.5, dangerousAttacks: 7, attacks: 20 }
    ],
    trend: {
      window5m: makeWindow(5, [{ shotsOnTarget: 2 }, { shotsOnTarget: 0 }]),
      window10m: makeWindow(10, [
        { shotsOnTarget: 2, dangerousAttacks: 7.5, attacks: 20 },
        { shotsOnTarget: 0, dangerousAttacks: 7.5, attacks: 20 }
      ])
    }
  });
  assert.equal(result.qualified, true);
  assert.equal(result.score, 68);
  assert.deepEqual(Object.keys(result.components.points), [
    "totalSot", "sot5m", "sot10m", "xg", "dangerousAttacks10m", "attacks10m"
  ]);
});

test("autonomous model requires five cumulative SOT and two valid SOT in the last ten minutes", () => {
  const teams = [
    { shotsOnTarget: 3, xG: 3 },
    { shotsOnTarget: 2, xG: 3 }
  ];
  const recentOne = calculateAutonomousPowerRankingScore({
    teams,
    trend: { window10m: makeWindow(10, [{ shotsOnTarget: 1 }, { shotsOnTarget: 0 }]) }
  });
  assert.equal(recentOne.qualified, false);

  const totalFour = calculateAutonomousPowerRankingScore({
    teams: [{ shotsOnTarget: 2, xG: 3 }, { shotsOnTarget: 2, xG: 3 }],
    trend: { window10m: makeWindow(10, [{ shotsOnTarget: 2 }, { shotsOnTarget: 0 }]) }
  });
  assert.equal(totalFour.qualified, false);
});

test("stale or missing ten-minute SOT data cannot satisfy autonomous qualification", () => {
  const result = calculateAutonomousPowerRankingScore({
    teams: [{ shotsOnTarget: 3 }, { shotsOnTarget: 2 }],
    trend: { window10m: makeWindow(14, [{ shotsOnTarget: 2 }, { shotsOnTarget: 0 }]) }
  });
  assert.equal(result.components.sot10m, null);
  assert.equal(result.qualified, false);
});

test("autonomous alerts require two qualifying observations 30–90 seconds apart", () => {
  const candidates = new Map();
  const args = { candidates, eventId: "fixture-1", qualified: true };
  assert.equal(confirmAutonomousPowerRankingObservation({ ...args, now: 100000 }), false);
  assert.equal(confirmAutonomousPowerRankingObservation({ ...args, now: 129999 }), false);
  assert.equal(confirmAutonomousPowerRankingObservation({ ...args, now: 130000 }), true);
  assert.equal(confirmAutonomousPowerRankingObservation({ ...args, now: 190001 }), false);
});

test("autonomous confirmation resets after a failed qualification or stale observation", () => {
  const candidates = new Map();
  assert.equal(confirmAutonomousPowerRankingObservation({
    candidates, eventId: "fixture-2", qualified: true, now: 100000
  }), false);
  assert.equal(confirmAutonomousPowerRankingObservation({
    candidates, eventId: "fixture-2", qualified: false, now: 140000
  }), false);
  assert.equal(confirmAutonomousPowerRankingObservation({
    candidates, eventId: "fixture-2", qualified: true, now: 150000
  }), false);
  assert.equal(confirmAutonomousPowerRankingObservation({
    candidates, eventId: "fixture-2", qualified: true, now: 240001
  }), false);
});
