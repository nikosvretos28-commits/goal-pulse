#!/usr/bin/env node
"use strict";

// Safe PostgreSQL persistence check for GoalMatrix.
// Requires DATABASE_URL. Writes only sentinel rows inside a transaction and
// rolls the transaction back before exiting. It never reads alert payloads.

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

async function main() {
  const client = await pool.connect();
  const report = {
    connected: false,
    schema: {},
    rowCounts: {},
    transactionalWriteChecks: {},
    rollbackCompleted: false
  };

  try {
    await client.query("SELECT 1");
    report.connected = true;

    const tables = [
      "alert_history",
      "high_activity_history",
      "protocol_analyst_reports",
      "live_stat_snapshots",
      "push_subscriptions"
    ];

    for (const table of tables) {
      const result = await client.query(
        "SELECT to_regclass($1) AS table_name",
        ["public." + table]
      );
      report.schema[table] = Boolean(result.rows[0].table_name);
    }

    for (const table of ["alert_history", "high_activity_history"]) {
      if (report.schema[table]) {
        const result = await client.query(
          "SELECT COUNT(*)::bigint AS count FROM " + table
        );
        report.rowCounts[table] = String(result.rows[0].count);
      }
    }

    const missing = Object.entries(report.schema)
      .filter(([, exists]) => !exists)
      .map(([name]) => name);
    if (missing.length) {
      report.error = "Missing expected tables: " + missing.join(", ");
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = 1;
      return;
    }

    const suffix = crypto.randomUUID();
    await client.query("BEGIN");
    try {
      const alertId = "storage-check-" + suffix;
      await client.query(
        "INSERT INTO alert_history(alert_id,event_id,level,created_at,payload,updated_at) VALUES($1,$2,'AI',NOW(),$3::jsonb,NOW())",
        [alertId, alertId, JSON.stringify({ source: "storage-check", testOnly: true })]
      );
      const alertRead = await client.query(
        "SELECT 1 FROM alert_history WHERE alert_id=$1",
        [alertId]
      );
      report.transactionalWriteChecks.alert_history =
        alertRead.rowCount === 1;

      const observationId = "storage-check-" + suffix;
      await client.query(
        "INSERT INTO high_activity_history(observation_id,event_id,created_at,payload,updated_at) VALUES($1,$2,NOW(),$3::jsonb,NOW())",
        [observationId, observationId, JSON.stringify({ source: "storage-check", testOnly: true })]
      );
      const hiRead = await client.query(
        "SELECT 1 FROM high_activity_history WHERE observation_id=$1",
        [observationId]
      );
      report.transactionalWriteChecks.high_activity_history =
        hiRead.rowCount === 1;

      await client.query("ROLLBACK");
      report.rollbackCompleted = true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }

    const passed =
      report.connected &&
      Object.values(report.schema).every(Boolean) &&
      Object.values(report.transactionalWriteChecks).every(Boolean) &&
      report.rollbackCompleted;

    report.passed = passed;
    console.log(JSON.stringify(report, null, 2));
    if (!passed) process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(async error => {
  console.error("Storage check failed:", error.message);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
