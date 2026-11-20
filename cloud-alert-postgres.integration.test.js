"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createCloudAlertRuntime } = require("./cloud-alert-runtime");
const { createCloudAlertSettlement } = require("./cloud-alert-settlement");

const databaseUrl = process.env.CLOUD_ALERT_TEST_DATABASE_URL;

test("Cloud Alert settlement schema, audit chain and append-only guards work on PostgreSQL", {
  skip: !databaseUrl
}, async t => {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const runtime = createCloudAlertRuntime({ getPool: () => pool, pushEnabled: false });
  const settlement = createCloudAlertSettlement({
    getPool: () => pool,
    ensureSignalSchema: () => runtime.ensureSchema()
  });
  const suffix = crypto.randomUUID();
  let signalId = "pg-test-" + suffix;
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
  const recorded = await runtime.recordShadowCandidate({
    matchId: fixtureId, fixtureId, league: "Integration League",
    ruleVersion: "cloud-alert-v0.2", period: "1H", triggers: ["EARLY_1H"],
    minute: 20, home: "Home", away: "Away", homeSot: 3, awaySot: 2,
    recentSot6: 1, recentSot10: 2, scoreHome: 0, scoreAway: 0,
    metrics: { total: 5, sot90: 22.5, balance: 0.4 },
    confirmation: "two_monotonic_samples", statsSource: "ESPN"
  });
  assert.equal(recorded.saved, true);
  signalId = recorded.signalId;
  assert.equal(signalId.length, 64);
  const history = await runtime.listHistory(10);
  assert.equal(history.signals[0].fixture_id, fixtureId);
  assert.equal(history.signals[0].league, "Integration League");
  assert.equal(history.signals[0].rule_version, "cloud-alert-v0.2");

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
