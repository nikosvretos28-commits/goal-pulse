#!/usr/bin/env node
"use strict";

// Read-only schema discovery plus rollback-only synthetic write checks.
// Requires DATABASE_URL. Never changes alert rules or keeps test rows.

const { Pool } = require("pg");
const crypto = require("node:crypto");

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) {
  console.error("Missing DATABASE_URL. No connection was attempted.");
  process.exit(2);
}

const pool = new Pool({
  connectionString,
  ssl: /localhost|127\.0\.0\.1/.test(connectionString)
    ? false
    : { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 8000,
  idleTimeoutMillis: 1000
});

const requiredOnStartup = ["alert_history", "live_stat_snapshots"];
const optionalTables = [
  "high_activity_history",
  "protocol_analyst_reports",
  "push_subscriptions",
  "pre_match_season_profiles"
];
const expectedTables = [...requiredOnStartup, ...optionalTables];

async function main() {
  const report = {
    connected: false,
    schema: {},
    missingRequiredTables: [],
    missingOptionalTables: [],
    rowCounts: {},
    transactionalWriteChecks: {},
    rollbackCompleted: false,
    schemaReady: false,
    passed: false,
    status: "not_connected"
  };

  let client;
  try {
    client = await pool.connect();
    await client.query("SELECT 1");
    report.connected = true;

    for (const table of expectedTables) {
      const result = await client.query(
        "SELECT to_regclass($1) AS table_name",
        ["public." + table]
      );
      report.schema[table] = Boolean(result.rows[0].table_name);
    }

    report.missingRequiredTables = requiredOnStartup.filter(
      table => !report.schema[table]
    );
    report.missingOptionalTables = optionalTables.filter(
      table => !report.schema[table]
    );
    report.schemaReady =
      report.missingRequiredTables.length === 0 &&
      report.missingOptionalTables.length === 0;

    for (const table of ["alert_history", "high_activity_history"]) {
      if (report.schema[table]) {
        const result = await client.query(
          "SELECT COUNT(*)::bigint AS count FROM public." + table
        );
        report.rowCounts[table] = String(result.rows[0].count);
      }
    }

    // A fresh database has no schema yet. The app's existing ensure*Db()
    // functions create tables as their normal startup/routes require them.
    // This diagnostic never creates application tables.
    if (report.missingRequiredTables.length) {
      report.status = "connected_schema_pending";
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    const suffix = crypto.randomUUID();
    await client.query("BEGIN");
    try {
      const alertId = "storage-check-" + suffix;
      await client.query(
        "INSERT INTO public.alert_history(alert_id,event_id,level,created_at,payload,updated_at) VALUES($1,$2,'AI',NOW(),$3::jsonb,NOW())",
        [alertId, alertId, JSON.stringify({ source: "storage-check", testOnly: true })]
      );
      const alertRead = await client.query(
        "SELECT 1 FROM public.alert_history WHERE alert_id=$1",
        [alertId]
      );
      report.transactionalWriteChecks.alert_history =
        alertRead.rowCount === 1;

      const snapshot = await client.query(
        "INSERT INTO public.live_stat_snapshots(event_id,match_date,team_name,shots_on_target) VALUES($1,$2,$3,$4) RETURNING id",
        ["storage-check-" + suffix, new Date().toISOString().slice(0, 10), "Storage diagnostic", 1]
      );
      const snapshotRead = await client.query(
        "SELECT 1 FROM public.live_stat_snapshots WHERE id=$1",
        [snapshot.rows[0].id]
      );
      report.transactionalWriteChecks.live_stat_snapshots =
        snapshotRead.rowCount === 1;

      if (report.schema.high_activity_history) {
        const observationId = "storage-check-" + suffix;
        await client.query(
          "INSERT INTO public.high_activity_history(observation_id,event_id,created_at,payload,updated_at) VALUES($1,$2,NOW(),$3::jsonb,NOW())",
          [observationId, observationId, JSON.stringify({ source: "storage-check", testOnly: true })]
        );
        const hiRead = await client.query(
          "SELECT 1 FROM public.high_activity_history WHERE observation_id=$1",
          [observationId]
        );
        report.transactionalWriteChecks.high_activity_history =
          hiRead.rowCount === 1;
      }

      await client.query("ROLLBACK");
      report.rollbackCompleted = true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }

    report.passed =
      report.connected &&
      report.transactionalWriteChecks.alert_history === true &&
      report.transactionalWriteChecks.live_stat_snapshots === true &&
      (!report.schema.high_activity_history ||
        report.transactionalWriteChecks.high_activity_history === true) &&
      report.rollbackCompleted;
    report.status = report.passed
      ? (report.schemaReady ? "ready" : "core_ready_optional_schema_pending")
      : "check_failed";
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

main().catch(async error => {
  console.error("Storage check failed:", error.message);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
