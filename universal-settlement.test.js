"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateEvidence, parseGoalMarket, gradeGoalMarket, resolveAlertSettlement,
  resolveGoalAfterSignal, isPendingRecord
} = require("./universal-settlement");

const evidence = {
  provider: "nowgoal", fixtureId: "ng-123", sourceUrl: "https://www.nowgoal.net/match/123",
  home: "Alpha FC", away: "Beta SC", league: "Regional League", date: "2026-11-18",
  finished: true, homeScore: 3, awayScore: 1, homeHtScore: 1, awayHtScore: 0
};

test("evidence is rejected when fixture identity, final score or source is incomplete", () => {
  assert.equal(validateEvidence({ ...evidence, finished: false }).ok, false);
  assert.equal(validateEvidence({ ...evidence, homeScore: null }).ok, false);
  assert.equal(validateEvidence({ ...evidence, fixtureId: "" }).ok, false);
  assert.equal(validateEvidence({ ...evidence, sourceUrl: "http://nowgoal.net/match/123" }).ok, false);
});

test("market parser supports only clear whole and half goal lines", () => {
  assert.deepEqual(parseGoalMarket("Over 2.5"), { side: "over", line: 2.5 });
  assert.deepEqual(parseGoalMarket("Under 3"), { side: "under", line: 3 });
  assert.equal(parseGoalMarket("Over 2.25"), null);
  assert.equal(parseGoalMarket("Over 2.5 corners"), null);
  assert.equal(parseGoalMarket("Asian Over 2.75"), null);
});

test("goal market grading covers Over, Under and integer push", () => {
  assert.equal(gradeGoalMarket(3, "Over 2.5"), "won");
  assert.equal(gradeGoalMarket(1, "Over 2.5"), "lost");
  assert.equal(gradeGoalMarket(2, "Over 2"), "push");
  assert.equal(gradeGoalMarket(1, "Under 2.5"), "won");
  assert.equal(gradeGoalMarket(3, "Under 2.5"), "lost");
});

test("first-half alert uses half-time score, not full-time score", () => {
  const result = resolveAlertSettlement({
    home: "Alpha FC", away: "Beta SC", periodAtSignal: "first_half", market: "Over 0.5"
  }, evidence, "2026-11-19T05:00:00Z");
  assert.equal(result.ok, true);
  assert.equal(result.settlement.outcome, "won");
  assert.equal(result.settlement.evaluationScore, "1-0");
});

test("second-half alert uses full-time score", () => {
  const result = resolveAlertSettlement({
    home: "Alpha FC", away: "Beta SC", periodAtSignal: "second_half", market: "Over 2.5"
  }, evidence);
  assert.equal(result.ok, true);
  assert.equal(result.settlement.evaluationScore, "3-1");
});

test("missing half-time score remains unresolved for first-half signals", () => {
  assert.equal(resolveAlertSettlement({
    home: "Alpha FC", away: "Beta SC", periodAtSignal: "first_half", market: "Over 0.5"
  }, { ...evidence, homeHtScore: null }).reason, "required_period_score_missing");
});

test("mismatched teams and unsupported Asian quarter lines fail closed", () => {
  assert.equal(resolveAlertSettlement({
    home: "Beta SC", away: "Alpha FC", periodAtSignal: "second_half", market: "Over 2.5"
  }, evidence).reason, "fixture_identity_mismatch");
  assert.equal(resolveAlertSettlement({
    home: "Alpha FC", away: "Beta SC", periodAtSignal: "second_half", market: "Over 2.25"
  }, evidence).reason, "unsupported_market");
});

test("HI-style goal-after-signal uses only the period end score", () => {
  const result = resolveGoalAfterSignal({
    home: "Alpha FC", away: "Beta SC", periodAtSignal: "first_half",
    scoreAtSignal: { home: 0, away: 0 }
  }, evidence);
  assert.equal(result.ok, true);
  assert.equal(result.settlement.outcome, "confirmed");
  assert.equal(result.settlement.goalsAfterSignal, 1);
});

test("pending classification distinguishes terminal and unresolved records", () => {
  assert.equal(isPendingRecord({ betOutcome: "won" }, "alert"), false);
  assert.equal(isPendingRecord({ betOutcome: "pending" }, "alert"), true);
  assert.equal(isPendingRecord({ outcome: "confirmed" }, "activity"), false);
});

