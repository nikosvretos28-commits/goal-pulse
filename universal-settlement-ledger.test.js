"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateLedgerEvent, validateLedgerTransition, reduceLedgerEvents } = require("./universal-settlement-ledger");

const base = {
  settlementId: "settle-1", sourceCategory: "ai_alert", sourceRecordId: "alert-1",
  eventId: "fixture-1", actor: "admin", action: "evidence_attached",
  evidence: { provider: "nowgoal", fixtureId: "fixture-1" }, idempotencyKey: "settle-1:evidence-1"
};

test("ledger event requires linked source identity and evidence", () => {
  assert.equal(validateLedgerEvent(base).ok, true);
  assert.equal(validateLedgerEvent({ ...base, sourceRecordId: "" }).ok, false);
  assert.equal(validateLedgerEvent({ ...base, evidence: null }).ok, false);
  assert.equal(validateLedgerEvent({ ...base, sourceCategory: "power_games" }).ok, true);
  assert.equal(validateLedgerEvent({ ...base, sourceCategory: "power_ranking" }).ok, true);
});

test("dispute and reversal require an explicit reason", () => {
  assert.equal(validateLedgerEvent({ ...base, action: "disputed" }).reason, "reason_required");
  assert.equal(validateLedgerEvent({ ...base, action: "reversed" }).reason, "reason_required");
});

test("verification and finalization require explicit server-side checks", () => {
  assert.equal(validateLedgerEvent({ ...base, action: "verified" }).reason, "verified_evidence_required");
  assert.equal(validateLedgerEvent({ ...base, action: "finalized", evaluation: { outcome: "won" } }).reason, "verified_evaluator_result_required");
  assert.equal(validateLedgerEvent({
    ...base, action: "finalized", evaluatorVerified: true, evaluation: { outcome: "won" }
  }).ok, true);
});

test("only verified records may be finalized and reversals are append-only", () => {
  assert.equal(validateLedgerTransition("pending", { action: "finalized" }).reason, "invalid_status_transition");
  assert.equal(validateLedgerTransition("verified", { action: "finalized" }).ok, true);
  assert.equal(validateLedgerTransition("finalized", { action: "disputed" }).reason, "invalid_status_transition");
  assert.equal(validateLedgerTransition("finalized", { action: "reversed", status: "reversed" }).ok, true);
  assert.equal(validateLedgerTransition("reversed", { action: "reversed", status: "reversed" }).reason, "reversed_record_is_terminal");
});

test("disputed records can receive new evidence and be verified", () => {
  assert.equal(validateLedgerTransition("disputed", { action: "evidence_attached" }).ok, true);
  assert.equal(validateLedgerTransition("disputed", { action: "verified" }).ok, true);
  assert.equal(validateLedgerTransition("disputed", { action: "finalized" }).ok, false);
});

test("ledger reduction preserves every appended event and current status", () => {
  const result = reduceLedgerEvents([
    { settlement_id: "s1", status: "verified", created_at: "2026-11-19T05:02:00Z" },
    { settlement_id: "s1", status: "pending", created_at: "2026-11-19T05:01:00Z" },
    { settlement_id: "s2", status: "disputed", created_at: "2026-11-19T05:03:00Z" }
  ]);
  assert.equal(result.find(x => x.settlementId === "s1").status, "verified");
  assert.equal(result.find(x => x.settlementId === "s1").events.length, 2);
  assert.equal(result.find(x => x.settlementId === "s2").status, "disputed");
});
