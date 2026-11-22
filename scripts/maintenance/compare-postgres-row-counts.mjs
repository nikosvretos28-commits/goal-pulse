#!/usr/bin/env node
"use strict";

// Read-only comparison of public base-table row counts between two PostgreSQL databases.
// Required env: SOURCE_DATABASE_URL, TARGET_DATABASE_URL
// Optional env: SOURCE_CA_FILE, TARGET_CA_FILE (PEM CA certificate paths)
// Never prints connection strings or credentials.

const fs = require("node:fs");
const { Pool } = require("pg");

function makePool(prefix) {
  const connectionString = process.env[`${prefix}_DATABASE_URL`];
  if (!connectionString) throw new Error(`${prefix}_DATABASE_URL is required`);
  const caPath = process.env[`${prefix}_CA_FILE`];
  const ssl = caPath
    ? { ca: fs.readFileSync(caPath, "utf8"), rejectUnauthorized: true }
    : undefined;
  return new Pool({ connectionString, ssl, max: 1, connectionTimeoutMillis: 10000, query_timeout: 30000 });
}

async function getCounts(pool) {
  const { rows } = await pool.query(
    `SELECT table_schema, table_name
       FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name`
  );
  const counts = new Map();
  for (const row of rows) {
    const schema = row.table_schema.replace(/"/g, '""');
    const table = row.table_name.replace(/"/g, '""');
    const result = await pool.query(`SELECT COUNT(*)::text AS count FROM "${schema}"."${table}"`);
    counts.set(`${row.table_schema}.${row.table_name}`, result.rows[0].count);
  }
  return counts;
}

async function main() {
  const source = makePool("SOURCE");
  const target = makePool("TARGET");
  try {
    const [a, b] = await Promise.all([getCounts(source), getCounts(target)]);
    const names = [...new Set([...a.keys(), ...b.keys()])].sort();
    let differences = 0;
    console.log("table\tsource_rows\ttarget_rows\tresult");
    for (const name of names) {
      const left = a.get(name) ?? "MISSING";
      const right = b.get(name) ?? "MISSING";
      const same = left === right;
      if (!same) differences++;
      console.log(`${name}\t${left}\t${right}\t${same ? "MATCH" : "DIFF"}`);
    }
    console.log(`\nTables checked: ${names.length}; differences: ${differences}`);
    if (differences) process.exitCode = 2;
  } finally {
    await Promise.allSettled([source.end(), target.end()]);
  }
}

main().catch((error) => {
  // Deliberately omit error details because some driver errors can include connection metadata.
  console.error("Comparison failed. Check connectivity, credentials, and optional CA files locally.");
  process.exitCode = 1;
});
