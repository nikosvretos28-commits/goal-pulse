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

test("missing cumulative or rolling statistics remain unavailable, never zero", () => {
  assert.equal(calculatePowerRankingScore({ teams: [], trend: {} }), null);
  assert.equal(calculatePowerRankingScore({
    teams: [{ shotsOnTarget: 5, xG: 1 }, { shotsOnTarget: null, xG: 2 }],
    trend: { window5m: makeWindow(5, [{ shotsOnTarget: 1 }, { shotsOnTarget: 1 }]), window10m: makeWindow(10, [
      { shotsOnTarget: 1, dangerousAttacks: 2, attacks: 10 },
      { shotsOnTarget: 1, dangerousAttacks: 2, attacks: 10 }
    ]) }
  }), null);
  assert.equal(calculatePowerRankingScore({
    teams: [{ shotsOnTarget: 5, xG: 1 }, { shotsOnTarget: 4, xG: 2 }],
    trend: {}
  }), null);
});

test("Power Ranking rolling windows accept only the agreed ±30-second tolerance", () => {
  const teams = [{ shotsOnTarget: 5, xG: 1.8 }, { shotsOnTarget: 4, xG: 1.4 }];
  const makeTrend = (age5, age10) => ({
    window5m: makeWindow(age5, [{ shotsOnTarget: 2 }, { shotsOnTarget: 1 }]),
    window10m: makeWindow(age10, [
      { shotsOnTarget: 3, dangerousAttacks: 9, attacks: 20 },
      { shotsOnTarget: 2, dangerousAttacks: 8, attacks: 18 }
    ])
  });
  for (const age of [4.5, 5, 5.5]) assert.notEqual(calculatePowerRankingScore({ teams, trend: makeTrend(age, 10) }), null);
  for (const age of [9.5, 10, 10.5]) assert.notEqual(calculatePowerRankingScore({ teams, trend: makeTrend(5, age) }), null);
  assert.equal(calculatePowerRankingScore({ teams, trend: makeTrend(5.51, 10) }), null);
  assert.equal(calculatePowerRankingScore({ teams, trend: makeTrend(5, 10.51) }), null);
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

test("autonomous Power Ranking requires a score strictly above 65 and eligibility", () => {
  assert.equal(shouldEmitAutonomousPowerRankingAlert({ score: 64, eligible: true, scoreAvailable: true }), false);
  assert.equal(shouldEmitAutonomousPowerRankingAlert({ score: 65, eligible: true, scoreAvailable: true }), false);
  assert.equal(shouldEmitAutonomousPowerRankingAlert({ score: 100, eligible: false, scoreAvailable: true }), false);
  // Missing match goals must not suppress an otherwise qualifying autonomous ranking alert.
  assert.equal(shouldEmitAutonomousPowerRankingAlert({ score: 65, eligible: true }), false);
  assert.equal(shouldEmitAutonomousPowerRankingAlert({ score: 100, eligible: true }), true);
  assert.equal(shouldEmitAutonomousPowerRankingAlert({ score: "65", eligible: true }), false);
  assert.equal(shouldEmitAutonomousPowerRankingAlert({ score: 66, eligible: true }), true);
  assert.equal(shouldEmitAutonomousPowerRankingAlert({ score: "66", eligible: true }), true);
});
