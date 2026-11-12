"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFiveBotDailyReport, normalizeRecord, dayKey } = require("./elite-five-bots");

const row = (overrides = {}) => ({
  alert_id: "a1", event_id: "fx1", created_at: "2026-11-11T15:00:00.000Z",
  payload: {
    homeTeam: "Alpha", awayTeam: "Beta", league: "League A",
    minuteNumber: 65, periodAtSignal: "second_half",
    betOutcome: "won", betSettlementProvider: "provider",
    betSettlementFixtureId: "fixture-1", betScoreScope: "full_time",
    betFinalScore: "2-1", statsAtSignal: { onTarget: 4, xG: 1.2 }
  }, ...overrides
});

test("daily report separates verified, pending and unverified outcomes", () => {
  const report = buildFiveBotDailyReport({
    date: "2026-11-11",
    alerts: [row(), row({ alert_id: "a2", payload: { ...row().payload, betOutcome: "lost", betSettlementProvider: null } })]
  });
  assert.equal(report.summary.alerts, 2);
  assert.equal(report.summary.verifiedWins, 1);
  assert.equal(report.summary.unverifiedSettlements, 1);
  assert.equal(report.bots.length, 5);
});

test("SOT analyst never reads generic shots or off-target values", () => {
  const r = normalizeRecord({ ...row(), payload: { ...row().payload, statsAtSignal: { shots: 18, shotsOffTarget: 7 } } });
  assert.equal(r.statsAtSignal.onTarget, null);
  assert.equal(r.statsAtSignal.totalOnTarget, null);
});

test("HI Activity and AI/VIP are combined only for shared daily report and labelled separately", () => {
  const report = buildFiveBotDailyReport({
    date: "2026-11-11",
    alerts: [row()],
    hiActivity: [{ observation_id: "h1", event_id: "fx2", created_at: "2026-11-11T16:00:00Z", payload: { homeTeam: "Gamma", awayTeam: "Delta" } }]
  });
  assert.equal(report.sourceCoverage.hiActivityRecordsLoaded, 1);
  assert.equal(report.bots[0].summary.alerts, 2);
  assert.equal(report.bots[1].rule.includes("generic shots"), true);
});

test("goal minutes are reported only when present in stored payload", () => {
  const withGoals = row({ payload: { ...row().payload, goalMinutes: [12, "45+2", 78] } });
  const report = buildFiveBotDailyReport({ date: "2026-11-11", alerts: [withGoals] });
  assert.deepEqual(report.bots[2].goalMinutes, [12, 45, 78]);
  const empty = buildFiveBotDailyReport({ date: "2026-11-11", alerts: [row()] });
  assert.equal(empty.bots[2].goalMinutes.length, 0);
});

test("date grouping uses Greece local calendar date", () => {
  assert.equal(dayKey("2026-11-11T22:30:00.000Z"), "2026-11-12");
});
