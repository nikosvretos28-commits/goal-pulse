"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateSettlementInput, gradeSignalSettlement
} = require("./cloud-alert-settlement");

test("requires settlement identity and source metadata", () => {
  const result = validateSettlementInput({});
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("signalId_required"));
  assert.ok(result.errors.includes("provider_required"));
  assert.ok(result.errors.includes("fixtureId_required"));
  assert.ok(result.errors.includes("source_required"));
});

test("validates verified HT/FT scores and records explicit metadata", () => {
  const result = validateSettlementInput({
    signalId: "sig-1", targetPeriod: "HT", state: "settled_verified",
    provider: "ESPN", fixtureId: "fixture-123", source: "official scoreboard",
    settledAt: "2026-11-20T07:00:00Z", scoreHome: 2, scoreAway: 1
  });
  assert.equal(result.valid, true);
  assert.equal(result.value.targetPeriod, "HT");
});

test("requires a reason for unverifiable or disputed records", () => {
  for (const state of ["unverifiable", "disputed"]) {
    const result = validateSettlementInput({
      signalId: "sig-1", targetPeriod: "HT", state, provider: "ESPN",
      fixtureId: "fixture-123", source: "official scoreboard",
      settledAt: "2026-11-20T07:00:00Z"
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes("reason_required_for_nonverified_state"));
  }
});

test("grades over signal-time total goals plus 0.5 using HT score", () => {
  const signal = { period: "1H", scoreHome: 1, scoreAway: 0 };
  const win = gradeSignalSettlement(signal, "HT", 2, 0);
  assert.equal(win.valid, true);
  assert.equal(win.overLine, 1.5);
  assert.equal(win.outcome, "win");
  const loss = gradeSignalSettlement(signal, "HT", 1, 0);
  assert.equal(loss.outcome, "loss");
});

test("a second-half signal cannot be graded at HT", () => {
  const result = gradeSignalSettlement({ period: "2H", scoreHome: 0, scoreAway: 0 }, "HT", 1, 0);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "second_half_signal_cannot_settle_at_half_time");
});

test("does not invent a missing signal-time score", () => {
  const result = gradeSignalSettlement({ period: "1H", scoreHome: null, scoreAway: null }, "FT", 2, 1);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signal_time_score_missing");
});

function settlementPool(signal) {
  const inserted = [];
  const pool = {
    async query(sql) {
      if (sql.includes("SELECT signal_id,match_id,period,payload FROM cloud_alert_signals")) {
        return { rows: [signal] };
      }
      if (sql.includes("SELECT state FROM cloud_alert_settlement_events")) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return {
        async query(sql, params = []) {
          if (sql.includes("SELECT period,payload FROM cloud_alert_signals")) {
            return { rows: [{ period: signal.period, payload: signal.payload }] };
          }
          if (sql.includes("SELECT event_id,state FROM cloud_alert_settlement_events")) return { rows: [] };
          if (sql.includes("INSERT INTO cloud_alert_settlement_events")) {
            inserted.push({ signalId: params[1], targetPeriod: params[2], state: params[3],
              scoreHome: params[8], scoreAway: params[9], reason: params[14] });
          }
          return { rows: [], rowCount: 1 };
        },
        release() {}
      };
    }
  };
  return { pool, inserted };
}

test("scoreboard reconciler captures HT only from an explicit halftime fixture state", async () => {
  const signal = { signal_id: "sig-ht", match_id: "fixture-ht", period: "1H",
    payload: { period: "1H", scoreHome: 0, scoreAway: 0 } };
  const { pool, inserted } = settlementPool(signal);
  const { createCloudAlertSettlement } = require("./cloud-alert-settlement");
  const service = createCloudAlertSettlement({ getPool: () => pool });
  const result = await service.reconcileScoreboard({ feeds: [{ code: "esp.1", events: [{
    id: "fixture-ht", _goalMatrixSource: "ESPN",
    status: { type: { state: "in", name: "Halftime" }, displayClock: "Halftime" },
    competitions: [{ competitors: [
      { homeAway: "home", score: "1" }, { homeAway: "away", score: "0" }
    ] }]
  }] }] }, () => Date.parse("2026-11-20T07:00:00Z"));
  assert.equal(result.verified, 1);
  assert.deepEqual(inserted.map(row => [row.targetPeriod, row.state, row.scoreHome, row.scoreAway]),
    [["HT", "settled_verified", 1, 0]]);
});

test("scoreboard reconciler marks missed HT unverifiable and grades FT independently", async () => {
  const signal = { signal_id: "sig-ft", match_id: "fixture-ft", period: "1H",
    payload: { period: "1H", scoreHome: 0, scoreAway: 0 } };
  const { pool, inserted } = settlementPool(signal);
  const { createCloudAlertSettlement } = require("./cloud-alert-settlement");
  const service = createCloudAlertSettlement({ getPool: () => pool });
  const result = await service.reconcileScoreboard({ feeds: [{ code: "esp.1", events: [{
    id: "fixture-ft", _goalMatrixSource: "ESPN",
    status: { type: { state: "post", completed: true, name: "Full Time" }, displayClock: "FT" },
    competitions: [{ competitors: [
      { homeAway: "home", score: "2" }, { homeAway: "away", score: "1" }
    ] }]
  }] }] }, () => Date.parse("2026-11-20T08:00:00Z"));
  assert.equal(result.verified, 1);
  assert.equal(result.unverifiable, 1);
  assert.deepEqual(inserted.map(row => [row.targetPeriod, row.state]),
    [["HT", "unverifiable"], ["FT", "settled_verified"]]);
});

test("settlement ledger schema protects UPDATE, DELETE and TRUNCATE", async () => {
  let ddl = "";
  const pool = { async query(sql) { ddl = sql; return { rows: [], rowCount: 0 }; } };
  const { createCloudAlertSettlement } = require("./cloud-alert-settlement");
  const service = createCloudAlertSettlement({ getPool: () => pool });
  assert.equal(await service.ensureSchema(), true);
  assert.match(ddl, /RETURNS trigger LANGUAGE plpgsql AS \$\$/);
  assert.match(ddl, /BEFORE UPDATE OR DELETE ON cloud_alert_settlement_events/);
  assert.match(ddl, /BEFORE TRUNCATE ON cloud_alert_settlement_events/);
});

test("conflicting same-state score correction cannot be silently treated as a duplicate", async () => {
  const signal = { period: "1H", payload: { period: "1H", scoreHome: 1, scoreAway: 0 } };
  const events = [];
  let ddl = "";
  const pool = {
    async query(sql) { ddl = sql; return { rows: [], rowCount: 0 }; },
    async connect() {
      return {
        async query(sql, params = []) {
          if (sql === "SELECT period,payload FROM cloud_alert_signals WHERE signal_id=$1 FOR UPDATE") {
            return { rows: [signal] };
          }
          if (sql.includes("SELECT event_id,state,provider,fixture_id,source,score_home,score_away,reason")) {
            return { rows: events.length ? [events[events.length - 1]] : [] };
          }
          if (sql.includes("INSERT INTO cloud_alert_settlement_events")) {
            const event = {
              event_id: params[0], signal_id: params[1], target_period: params[2],
              state: params[3], provider: params[4], fixture_id: params[5], source: params[6],
              score_home: params[8], score_away: params[9], reason: params[14],
              previous_event_id: params[15]
            };
            events.push(event);
          }
          return { rows: [], rowCount: 1 };
        },
        release() {}
      };
    }
  };
  const { createCloudAlertSettlement } = require("./cloud-alert-settlement");
  const service = createCloudAlertSettlement({ getPool: () => pool });
  const base = { signalId: "sig-correction", targetPeriod: "FT", provider: "ESPN",
    fixtureId: "fixture-1", source: "scoreboard", settledAt: "2026-11-20T08:00:00Z" };
  const first = await service.appendEvent({ ...base, state: "settled_verified", scoreHome: 2, scoreAway: 0 });
  assert.equal(first.ok, true);
  const duplicate = await service.appendEvent({ ...base, state: "settled_verified", scoreHome: 2, scoreAway: 0 });
  assert.equal(duplicate.duplicate, true);
  const conflict = await service.appendEvent({ ...base, state: "settled_verified", scoreHome: 1, scoreAway: 0 });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "same_state_conflicting_payload_requires_dispute");
  const disputed = await service.appendEvent({ ...base, state: "disputed", reason: "provider score correction detected" });
  assert.equal(disputed.ok, true);
  const corrected = await service.appendEvent({ ...base, state: "settled_verified", scoreHome: 1, scoreAway: 0 });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.previousEventId, disputed.eventId);
});
