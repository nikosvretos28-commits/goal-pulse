"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { createCloudAlertRuntime } = require("./cloud-alert-runtime");
const { createCloudAlertSettlement } = require("./cloud-alert-settlement");

const databaseUrl = process.env.CLOUD_ALERT_TEST_DATABASE_URL;

test("Cloud Alert settlement schema, audit chain and append-only guards work on PostgreSQL", {
  skip: !databaseUrl
}, async t => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const runtime = createCloudAlertRuntime({ getPool: () => pool, pushEnabled: false });
  const settlement = createCloudAlertSettlement({
    getPool: () => pool,
    ensureSignalSchema: () => runtime.ensureSchema()
  });
  const suffix = crypto.randomUUID();
  const signalId = "pg-test-" + suffix;
  const fixtureId = "fixture-" + suffix;

  t.after(async () => {
    await pool.query("DROP TABLE IF EXISTS cloud_alert_settlement_events CASCADE");
    await pool.query("DROP FUNCTION IF EXISTS cloud_alert_reject_settlement_mutation() CASCADE");
    await pool.query("DROP TABLE IF EXISTS cloud_alert_pushes CASCADE");
    await pool.query("DROP TABLE IF EXISTS cloud_alert_push_state CASCADE");
    await pool.query("DROP TABLE IF EXISTS cloud_alert_sot_snapshots CASCADE");
    await pool.query("DROP TABLE IF EXISTS cloud_alert_signals CASCADE");
    await pool.end();
  });

  assert.equal(await runtime.ensureSchema(), true);
  assert.equal(await settlement.ensureSchema(), true);
  await pool.query(
    `INSERT INTO cloud_alert_signals
      (signal_id,match_id,period,trigger_ids,minute,home,away,home_sot,away_sot,
       recent_sot10,score_home,score_away,status,payload)
     VALUES($1,$2,'1H','["EARLY_1H"]'::jsonb,20,'Home','Away',3,2,1,0,0,
       'shadow_qualified',$3::jsonb)`,
    [signalId, fixtureId, JSON.stringify({ period: "1H", scoreHome: 0, scoreAway: 0 })]
  );

  const base = {
    signalId, targetPeriod: "HT", provider: "ESPN", fixtureId,
    source: "GitHub PostgreSQL integration test",
    settledAt: "2026-11-20T08:00:00Z"
  };
  const first = await settlement.appendEvent({
    ...base, state: "settled_verified", scoreHome: 1, scoreAway: 0
  });
  assert.equal(first.ok, true);
  assert.equal(first.grade.overLine, 0.5);
  assert.equal(first.grade.outcome, "win");

  const duplicate = await settlement.appendEvent({
    ...base, state: "settled_verified", scoreHome: 1, scoreAway: 0
  });
  assert.equal(duplicate.duplicate, true);

  await assert.rejects(
    pool.query("UPDATE cloud_alert_settlement_events SET reason='tampered' WHERE event_id=$1", [first.eventId]),
    /append-only/
  );
  await assert.rejects(pool.query("TRUNCATE cloud_alert_settlement_events"), /append-only/);

  const disputed = await settlement.appendEvent({
    ...base, state: "disputed", reason: "provider correction under review"
  });
  assert.equal(disputed.ok, true);
  const corrected = await settlement.appendEvent({
    ...base, state: "settled_verified", scoreHome: 0, scoreAway: 0
  });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.previousEventId, disputed.eventId);

  const integrity = await settlement.integrity(100);
  assert.equal(integrity.persistent, true);
  assert.equal(integrity.ok, true);
  assert.equal(integrity.issues.length, 0);
});
