"use strict";

const SOT_SIGNAL_FIELDS = Object.freeze(["onTarget", "onTarget10m", "totalOnTarget"]);
const XG_SIGNAL_FIELDS = Object.freeze(["xG", "xGDelta"]);

function hasFiniteValue(value) {
  if (value === null || value === undefined || value === "") return false;
  return Number.isFinite(Number(value));
}

function summarizeEliteDataAudit(rows, options = {}) {
  const windowDays = Number(options.windowDays) || 180;
  const records = Array.isArray(rows) ? rows : [];
  const summary = {
    windowDays,
    scannedAlerts: records.length,
    signalStats: {
      statsAtSignalPresent: 0,
      sot: Object.fromEntries(SOT_SIGNAL_FIELDS.map(field => [field, 0])),
      anySotField: 0,
      xg: Object.fromEntries(XG_SIGNAL_FIELDS.map(field => [field, 0])),
      anyXgField: 0
    },
    snapshots: {
      alertsWithSnapshots: 0,
      alertsWithSotSnapshots: 0,
      alertsWithoutSnapshots: 0,
      snapshotRowsInWindow: 0,
      sotSnapshotRowsInWindow: 0,
      snapshotsBeforeSignal: 0,
      sotSnapshotsBeforeSignal: 0,
      alertsWithSotSnapshotBeforeSignal: 0
    },
    byTrigger: {},
    sampleMissingData: []
  };

  const normalized = records.map(row => {
    const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
    const stats = payload.statsAtSignal && typeof payload.statsAtSignal === "object" ? payload.statsAtSignal : {};
    const hasSot = SOT_SIGNAL_FIELDS.some(field => hasFiniteValue(stats[field]));
    const hasXg = XG_SIGNAL_FIELDS.some(field => hasFiniteValue(stats[field]));
    const snapshotRows = Math.max(0, Number(row.snapshot_rows) || 0);
    const sotSnapshotRows = Math.max(0, Number(row.sot_snapshot_rows) || 0);
    const snapshotsBefore = Math.max(0, Number(row.snapshots_before_signal) || 0);
    const sotSnapshotsBefore = Math.max(0, Number(row.sot_snapshots_before_signal) || 0);
    return { row, payload, stats, hasSot, hasXg, snapshotRows, sotSnapshotRows, snapshotsBefore, sotSnapshotsBefore };
  });

  for (const item of normalized) {
    const { payload, stats, hasSot, hasXg } = item;
    if (payload.statsAtSignal && typeof payload.statsAtSignal === "object") summary.signalStats.statsAtSignalPresent++;
    for (const field of SOT_SIGNAL_FIELDS) if (hasFiniteValue(stats[field])) summary.signalStats.sot[field]++;
    for (const field of XG_SIGNAL_FIELDS) if (hasFiniteValue(stats[field])) summary.signalStats.xg[field]++;
    if (hasSot) summary.signalStats.anySotField++;
    if (hasXg) summary.signalStats.anyXgField++;

    summary.snapshots.snapshotRowsInWindow += item.snapshotRows;
    summary.snapshots.sotSnapshotRowsInWindow += item.sotSnapshotRows;
    summary.snapshots.snapshotsBeforeSignal += item.snapshotsBefore;
    summary.snapshots.sotSnapshotsBeforeSignal += item.sotSnapshotsBefore;
    if (item.snapshotRows > 0) summary.snapshots.alertsWithSnapshots++;
    else summary.snapshots.alertsWithoutSnapshots++;
    if (item.sotSnapshotRows > 0) summary.snapshots.alertsWithSotSnapshots++;
    if (item.sotSnapshotsBefore > 0) summary.snapshots.alertsWithSotSnapshotBeforeSignal++;

    const triggers = Array.isArray(payload.triggerIds) ? [...new Set(payload.triggerIds.map(String).filter(Boolean))] : [];
    for (const triggerId of triggers) {
      const bucket = summary.byTrigger[triggerId] ||= { alerts: 0, withSignalSot: 0, withSignalXg: 0, withSnapshots: 0, withSotSnapshots: 0 };
      bucket.alerts++;
      if (hasSot) bucket.withSignalSot++;
      if (hasXg) bucket.withSignalXg++;
      if (item.snapshotRows > 0) bucket.withSnapshots++;
      if (item.sotSnapshotRows > 0) bucket.withSotSnapshots++;
    }
  }

  const missing = normalized.filter(item => !item.hasSot || item.snapshotRows === 0 || item.sotSnapshotRows === 0);
  summary.sampleMissingData = missing.slice(0, 50).map(item => ({
    alertId: item.row.alert_id || null,
    eventId: item.row.event_id || null,
    createdAt: item.row.created_at || null,
    teams: [item.payload.homeTeam || item.payload.home || null, item.payload.awayTeam || item.payload.away || null],
    league: item.payload.league || null,
    minute: item.payload.minuteNumber ?? item.payload.minute ?? null,
    periodAtSignal: item.payload.periodAtSignal || null,
    triggerIds: Array.isArray(item.payload.triggerIds) ? [...new Set(item.payload.triggerIds.map(String))] : [],
    signalSot: Object.fromEntries(SOT_SIGNAL_FIELDS.map(field => [field, hasFiniteValue(item.stats[field]) ? Number(item.stats[field]) : null])),
    signalXg: Object.fromEntries(XG_SIGNAL_FIELDS.map(field => [field, hasFiniteValue(item.stats[field]) ? Number(item.stats[field]) : null])),
    snapshotRows: item.snapshotRows,
    sotSnapshotRows: item.sotSnapshotRows,
    snapshotsBeforeSignal: item.snapshotsBefore,
    sotSnapshotsBeforeSignal: item.sotSnapshotsBefore
  }));

  return {
    ok: true,
    readOnly: true,
    generatedAt: options.generatedAt || new Date().toISOString(),
    windowDays,
    scannedAlerts: summary.scannedAlerts,
    signalStats: summary.signalStats,
    snapshots: summary.snapshots,
    byTrigger: summary.byTrigger,
    sampleMissingData: summary.sampleMissingData,
    sampleLimit: 50,
    snapshotWindowMinutes: { beforeSignal: 15, afterSignal: 2 },
    notes: [
      "SOT coverage uses only explicit onTarget, onTarget10m and totalOnTarget fields; generic shots and off-target fields are never read.",
      "Snapshot matching uses the same event_id and a time window from 15 minutes before to 2 minutes after alert creation.",
      "xG coverage is measured only from statsAtSignal; the live_stat_snapshots table does not store xG.",
      "This report reads stored data only. It does not fetch provider history, settle alerts, or change protocols."
    ]
  };
}

module.exports = { SOT_SIGNAL_FIELDS, XG_SIGNAL_FIELDS, hasFiniteValue, summarizeEliteDataAudit };
