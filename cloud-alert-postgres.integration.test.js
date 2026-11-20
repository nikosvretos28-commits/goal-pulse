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

  const sampleMinute = Math.floor(Date.now() / 60000) * 60000;
  const baselineAt = new Date(sampleMinute - 6.5 * 60000).toISOString();
  await pool.query(
    `INSERT INTO cloud_alert_sot_snapshots(match_id,period,sampled_at,home_sot,away_sot)
     VALUES($1,'1H',$2,2,1)`,
    ["r6-valid-" + suffix, baselineAt]
  );
  const r6 = await runtime.recordSnapshot({
    matchId: "r6-valid-" + suffix, period: "1H", homeSot: 3, awaySot: 2
  });
  assert.equal(r6.valid, true);
  assert.equal(r6.value, 2);

  await pool.query(
    `INSERT INTO cloud_alert_sot_snapshots(match_id,period,sampled_at,home_sot,away_sot)
     VALUES($1,'1H',$2,5,4)`,
    ["r6-regression-" + suffix, baselineAt]
  );
  const regression = await runtime.recordSnapshot({
    matchId: "r6-regression-" + suffix, period: "1H", homeSot: 4, awaySot: 4
  });
  assert.equal(regression.valid, false);
  assert.equal(regression.reason, "cumulative_sot_regression");

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
  assert.equal(history.signals[0].recent_sot6, 1);
  assert.equal(history.signals[0].recent_sot10, 2);

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

  const pushCalls = [];
  const pushRuntime = createCloudAlertRuntime({
    getPool: () => pool, pushEnabled: true,
    async sendPush(payload) { pushCalls.push(payload); return { sent: 1, failed: 0, configured: true }; }
  });
  const pushCandidate = {
    matchId: "push-fixture-" + suffix, fixtureId: "push-fixture-" + suffix,
    league: "Integration League", period: "1H", triggers: ["EARLY_1H"],
    minute: 25, home: "Home", away: "Away", homeSot: 3, awaySot: 2,
    recentSot6: 1, recentSot10: 2, scoreHome: 0, scoreAway: 0,
    metrics: { total: 5, sot90: 18, balance: 0.4 }
  };
  const initialPush = await pushRuntime.processCandidate(pushCandidate);
  assert.equal(initialPush.pushed, true);
  assert.equal(initialPush.kind, "initial");
  assert.equal(initialPush.slot, 1);
  const duplicatePush = await pushRuntime.processCandidate(pushCandidate);
  assert.equal(duplicatePush.pushed, false);
  const reAlert = await pushRuntime.processCandidate({
    ...pushCandidate, minute: 26, scoreHome: 1
  });
  assert.equal(reAlert.pushed, true);
  assert.equal(reAlert.kind, "re_alert");
  assert.equal(reAlert.slot, 2);
  const overLimit = await pushRuntime.processCandidate({
    ...pushCandidate, minute: 27, scoreHome: 2
  });
  assert.equal(overLimit.reason, "half_push_limit_reached");
  assert.equal(pushCalls.length, 2);

  const retryFixture = "push-retry-" + suffix;
  const retryCandidate = { ...pushCandidate, matchId: retryFixture, fixtureId: retryFixture };
  const failedRuntime = createCloudAlertRuntime({
    getPool: () => pool, pushEnabled: true,
    async sendPush() { return { sent: 0, failed: 0, configured: true }; }
  });
  const failedAttempt = await failedRuntime.processCandidate(retryCandidate);
  assert.equal(failedAttempt.pushed, false);
  assert.equal(failedAttempt.reason, "no_active_push_subscriber");
  const retryRuntime = createCloudAlertRuntime({
    getPool: () => pool, pushEnabled: true,
    async sendPush() { return { sent: 1, failed: 0, configured: true }; }
  });
  const retried = await retryRuntime.processCandidate(retryCandidate);
  assert.equal(retried.pushed, true);
  const attempts = await pool.query(
    "SELECT attempt_count,status FROM cloud_alert_pushes WHERE match_id=$1 ORDER BY attempt_count ASC",
    [retryFixture]
  );
  assert.deepEqual(attempts.rows.map(row => [row.attempt_count, row.status]), [[1, "failed"], [2, "accepted"]]);

  const unknownFixture = "push-unknown-" + suffix;
  const unknownCandidate = { ...pushCandidate, matchId: unknownFixture, fixtureId: unknownFixture };
  const unknownRuntime = createCloudAlertRuntime({
    getPool: () => pool, pushEnabled: true,
    async sendPush() { throw new Error("simulated timeout after request handoff"); }
  });
  const unknown = await unknownRuntime.processCandidate(unknownCandidate);
  assert.equal(unknown.reason, "delivery_unknown_manual_review");
  let unexpectedDeliveryCalls = 0;
  const blockedRuntime = createCloudAlertRuntime({
    getPool: () => pool, pushEnabled: true,
    async sendPush() { unexpectedDeliveryCalls++; return { sent: 1, failed: 0, configured: true }; }
  });
  const blocked = await blockedRuntime.processCandidate({ ...unknownCandidate, minute: 26, scoreHome: 1 });
  assert.equal(blocked.reason, "delivery_unknown_manual_review");
  assert.equal(unexpectedDeliveryCalls, 0);
});
