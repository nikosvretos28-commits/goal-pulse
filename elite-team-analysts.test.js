"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildEliteTeamReport, normalizeRecord, minuteBand } = require("./elite-team-analysts");

const verified = (overrides = {}) => ({
  verifiedScore: true, settlementProvider: "trusted-provider",
  scoreScope: "full_time", finalScore: "2-1",
  period: "second_half", minute: 62, ...overrides
});

test("only explicitly verified wins and losses enter analyst comparisons", () => {
  const report = buildEliteTeamReport([
    { ...verified(), alertId: "w", outcome: "won", triggerIds: ["sot_recent"], statsAtSignal: { onTarget: 0, shots: 99 }, league: "L1" },
    { ...verified({ minute: 80 }), alertId: "l", outcome: "lost", triggerIds: ["sot_recent"], statsAtSignal: { totalOnTarget: 3 }, league: "L1" },
    { ...verified({ verifiedScore: false, minute: 55 }), alertId: "p", outcome: "won", triggerIds: ["sot_recent"] },
    { ...verified(), alertId: "x", outcome: "pending" }
  ]);
  assert.equal(report.coverage.suppliedRecords, 4);
  assert.equal(report.coverage.verifiedWinLoss, 2);
  assert.equal(report.outcomeSummary.wins, 1);
  assert.equal(report.outcomeSummary.losses, 1);
  assert.equal(report.analysts.triggerPerformance.byTrigger.sot_recent.alerts, 2);
  assert.equal(report.analysts.matchForensics.records.length, 2);
  assert.equal(report.analysts.sotDataIntegrity.fields.includes("shots"), false);
});

test("Power Ranking alerts are excluded from Elite AI comparisons", () => {
  const report = buildEliteTeamReport([
    { ...verified(), outcome: "won", alertId: "regular", triggerIds: ["sot_recent"] },
    { ...verified(), outcome: "won", alertId: "pr-type", alertType: "power_ranking_signal", triggerIds: ["sot_recent"] },
    { ...verified(), outcome: "lost", alertId: "pr-trigger", triggerIds: ["power_ranking_autonomous_65"] }
  ]);
  assert.equal(report.coverage.suppliedRecords, 3);
  assert.equal(report.coverage.verifiedWinLoss, 1);
  assert.equal(report.outcomeSummary.wins, 1);
  assert.deepEqual(Object.keys(report.analysts.triggerPerformance.byTrigger), ["sot_recent"]);
});

test("zero SOT is valid and generic shots never become SOT", () => {
  const r = normalizeRecord({ ...verified(), outcome: "won", statsAtSignal: { onTarget: 0, shots: 14, shotsOffTarget: 8 } });
  assert.equal(r.sot.onTarget, 0);
  assert.equal(r.sot.totalOnTarget, null);
});

test("timing bands are deterministic and missing minutes remain unknown", () => {
  assert.equal(minuteBand(46), "46-59");
  assert.equal(minuteBand(74), "60-74");
  assert.equal(minuteBand(88), "75-88");
  assert.equal(minuteBand(null), "unknown");
});

test("calibration and provider latency are not fabricated", () => {
  const report = buildEliteTeamReport([{ ...verified(), outcome: "won", statsAtSignal: {} }]);
  assert.equal(report.analysts.calibrationStrategy.status, "unavailable");
  assert.equal(report.analysts.providerLatency.status, "unavailable");
  assert.equal(report.analysts.chiefAnalyst.recommendations.length, 0);
});

test("recommendations require at least ten attributed examples", () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ ...verified(), outcome: i % 2 ? "lost" : "won", triggerIds: ["t"] }));
  assert.equal(buildEliteTeamReport(rows).analysts.chiefAnalyst.recommendations.length, 0);
  rows.push({ ...verified(), outcome: "won", triggerIds: ["t"] });
  assert.equal(buildEliteTeamReport(rows).analysts.chiefAnalyst.recommendations.length, 1);
});

test("score shape alone is not a verified settlement", () => {
  const report = buildEliteTeamReport([{
    verifiedScore: true, outcome: "won", period: "second_half", minute: 62,
    finalScore: "2-1", scoreScope: "full_time", triggerIds: ["t"]
  }]);
  assert.equal(report.outcomeSummary.verifiedWinLoss, 0);
});

test("only second-half records in the established 46-88 window are eligible", () => {
  const outsideWindow = [
    verified({ minute: 45 }), verified({ minute: 89 }),
    verified({ period: "first_half", minute: 40 })
  ].map((r, i) => ({ ...r, alertId: String(i), outcome: "won" }));
  assert.equal(buildEliteTeamReport(outsideWindow).outcomeSummary.verifiedWinLoss, 0);
});
