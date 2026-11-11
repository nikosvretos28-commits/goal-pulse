"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { calculatePowerRankingScore, isPowerRankingMinuteEligible, shouldEmitAutonomousPowerRankingAlert } = require("./power-ranking-trigger");

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

test("Power Ranking first-half window is 1–35 inclusive", () => {
  assert.equal(isPowerRankingMinuteEligible(1, "live"), true);
  assert.equal(isPowerRankingMinuteEligible(35, "1st half"), true);
  assert.equal(isPowerRankingMinuteEligible(36, "1st half"), false);
  assert.equal(isPowerRankingMinuteEligible(45, "1st half"), false);
  assert.equal(isPowerRankingMinuteEligible(35, "2nd half"), false);
  assert.equal(isPowerRankingMinuteEligible(35, "1ο ημίχρονο"), true);
  assert.equal(isPowerRankingMinuteEligible(35, "first_half"), true);
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

test("autonomous Power Ranking uses its own 65+ threshold and eligibility gate", () => {
  assert.equal(shouldEmitAutonomousPowerRankingAlert({ score: 64, eligible: true, scoreAvailable: true }), false);
  assert.equal(shouldEmitAutonomousPowerRankingAlert({ score: 65, eligible: true, scoreAvailable: true }), true);
  assert.equal(shouldEmitAutonomousPowerRankingAlert({ score: 100, eligible: false, scoreAvailable: true }), false);
  // Missing match goals must not suppress an otherwise qualifying autonomous ranking alert.
  assert.equal(shouldEmitAutonomousPowerRankingAlert({ score: 65, eligible: true }), true);
  assert.equal(shouldEmitAutonomousPowerRankingAlert({ score: 100, eligible: true }), true);
  assert.equal(shouldEmitAutonomousPowerRankingAlert({ score: "65", eligible: true }), true);
});
