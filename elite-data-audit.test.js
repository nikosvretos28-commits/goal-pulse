"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeEliteDataAudit, hasFiniteValue } = require("./elite-data-audit");

test("finite-value check accepts zero and rejects missing or invalid values", () => {
  assert.equal(hasFiniteValue(0), true);
  assert.equal(hasFiniteValue("2"), true);
  assert.equal(hasFiniteValue(null), false);
  assert.equal(hasFiniteValue(""), false);
  assert.equal(hasFiniteValue("not-a-number"), false);
});

test("audit reports explicit SOT and xG coverage without using generic shot fields", () => {
  const report = summarizeEliteDataAudit([
    {
      alert_id: "a1", event_id: "e1", created_at: "2026-11-11T10:00:00Z",
      payload: { triggerIds: ["recent_sot_pressure"], statsAtSignal: { onTarget: 0, onTarget10m: 2, xG: 1.4, shots: 99, shotsOffTarget: 7 } },
      snapshot_rows: 3, sot_snapshot_rows: 2, snapshots_before_signal: 2, sot_snapshots_before_signal: 1, snapshots_after_signal: 1, sot_snapshots_after_signal: 1, snapshot_teams: 2
    },
    {
      alert_id: "a2", event_id: "e2", created_at: "2026-11-11T10:05:00Z",
      payload: { triggerIds: ["recent_sot_pressure", "dual_team_sot"], statsAtSignal: { totalOnTarget: null, xG: null } },
      snapshot_rows: 0, sot_snapshot_rows: 0, snapshots_before_signal: 0, sot_snapshots_before_signal: 0
    }
  ], { windowDays: 30, generatedAt: "2026-11-11T11:00:00Z" });

  assert.equal(report.scannedAlerts, 2);
  assert.equal(report.signalStats.anySotField, 1);
  assert.equal(report.signalStats.sot.onTarget, 1);
  assert.equal(report.signalStats.sot.onTarget10m, 1);
  assert.equal(report.signalStats.anyXgField, 1);
  assert.equal(report.snapshots.alertsWithSnapshots, 1);
  assert.equal(report.snapshots.alertsWithSotSnapshots, 1);
  assert.equal(report.snapshots.alertsWithoutSnapshots, 1);
  assert.equal(report.snapshots.alertsWithSotSnapshotBeforeSignal, 1);
  assert.equal(report.snapshots.snapshotsAfterSignal, 1);
  assert.equal(report.snapshots.sotSnapshotsAfterSignal, 1);
  assert.equal(report.byTrigger.recent_sot_pressure.alerts, 2);
  assert.equal(report.byTrigger.dual_team_sot.withSignalSot, 0);
  assert.equal(report.sampleMissingData.length, 1);
  assert.equal(report.sampleMissingData[0].alertId, "a2");
  assert.equal(report.readOnly, true);
});

test("missing statsAtSignal is not counted as zero SOT", () => {
  const report = summarizeEliteDataAudit([
    { alert_id: "a3", event_id: "e3", payload: { statsAtSignal: null }, snapshot_rows: 1, sot_snapshot_rows: 0 }
  ]);
  assert.equal(report.signalStats.statsAtSignalPresent, 0);
  assert.equal(report.signalStats.anySotField, 0);
  assert.equal(report.snapshots.alertsWithSnapshots, 1);
  assert.equal(report.snapshots.alertsWithSotSnapshots, 0);
});
