"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildEliteTeamReport, normalizeRecord, minuteBand } = require("./elite-team-analysts");

test("only explicitly verified wins and losses enter analyst comparisons", () => {
  const report = buildEliteTeamReport([
    { alertId: "w", verifiedScore: true, outcome: "won", minute: 62, triggerIds: ["sot_recent"], statsAtSignal: { onTarget: 0, shots: 99 }, league: "L1" },
    { alertId: "l", verifiedScore: true, outcome: "lost", minute: 80, triggerIds: ["sot_recent"], statsAtSignal: { totalOnTarget: 3 }, league: "L1" },
    { alertId: "p", verifiedScore: false, outcome: "won", minute: 55, triggerIds: ["sot_recent"] },
    { alertId: "x", verifiedScore: true, outcome: "pending" }
  ]);
  assert.equal(report.coverage.suppliedRecords, 4);
  assert.equal(report.coverage.verifiedWinLoss, 2);
  assert.equal(report.outcomeSummary.wins, 1);
  assert.equal(report.outcomeSummary.losses, 1);
  assert.equal(report.analysts.triggerPerformance.byTrigger.sot_recent.alerts, 2);
  assert.equal(report.analysts.matchForensics.records.length, 2);
  assert.equal(report.analysts.sotDataIntegrity.fields.includes("shots"), false);
});

test("zero SOT is valid and generic shots never become SOT", () => {
  const r = normalizeRecord({ verifiedScore: true, outcome: "won", statsAtSignal: { onTarget: 0, shots: 14, shotsOffTarget: 8 } });
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
  const report = buildEliteTeamReport([{ verifiedScore: true, outcome: "won", statsAtSignal: {} }]);
  assert.equal(report.analysts.calibrationStrategy.status, "unavailable");
  assert.equal(report.analysts.providerLatency.status, "unavailable");
  assert.equal(report.analysts.chiefAnalyst.recommendations.length, 0);
});

test("recommendations require at least ten attributed examples", () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ verifiedScore: true, outcome: i % 2 ? "lost" : "won", triggerIds: ["t"] }));
  assert.equal(buildEliteTeamReport(rows).analysts.chiefAnalyst.recommendations.length, 0);
  rows.push({ verifiedScore: true, outcome: "won", triggerIds: ["t"] });
  assert.equal(buildEliteTeamReport(rows).analysts.chiefAnalyst.recommendations.length, 1);
});
