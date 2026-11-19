"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateTriggerAudit, buildTriggerAuditReversal } = require("./trigger-activation-audit");

const valid = {
  category: "ai", eventId: "fixture-123", alertId: "alert-123",
  triggerId: "sot_last10", triggerName: "SOT last 10 minutes",
  protocolId: "ai_live", minute: 67, period: "second_half",
  snapshot: { sot: 8, homeSot: 5, awaySot: 3, xg: 2.4, homeXg: 1.5, awayXg: 0.9, ignored: "not stored" },
  evidenceType: "log", evidenceRef: "railway:goal-pulse:line-abc", actor: "admin"
};

test("manual reconstruction requires identity, trigger, minute, period, stats and evidence", () => {
  assert.equal(validateTriggerAudit(valid).ok, true);
  for (const field of ["eventId", "triggerId", "triggerName", "protocolId", "minute", "period", "snapshot", "evidenceRef"]) {
    const input = { ...valid }; delete input[field];
    assert.equal(validateTriggerAudit(input).ok, false, field);
  }
});
test("AI/VIP/HI/Pressure records must link to their existing history or alert", () => {
  assert.equal(validateTriggerAudit({ ...valid, alertId: null }).reason, "missing_history_link");
  assert.equal(validateTriggerAudit({ ...valid, category: "hi_activity", alertId: null, sourceRecordId: "hi-1" }).ok, true);
});
test("snapshot is allowlisted and cannot store arbitrary payload fields", () => {
  const result = validateTriggerAudit(valid);
  assert.deepEqual(result.entry.snapshot, { sot: 8, homeSot: 5, awaySot: 3, xg: 2.4, homeXg: 1.5, awayXg: 0.9 });
  assert.equal(validateTriggerAudit({ ...valid, snapshot: { totalShots: 30 } }).ok, false);
});
test("minute, category, period and evidence type fail closed", () => {
  assert.equal(validateTriggerAudit({ ...valid, minute: 151 }).ok, false);
  assert.equal(validateTriggerAudit({ ...valid, category: "unknown" }).ok, false);
  assert.equal(validateTriggerAudit({ ...valid, period: "third_half" }).ok, false);
  assert.equal(validateTriggerAudit({ ...valid, evidenceType: "guess" }).ok, false);
});
test("reversals append a reasoned event instead of deleting the original", () => {
  assert.deepEqual(buildTriggerAuditReversal("audit-1", { reason: "Wrong fixture", actor: "admin" }), {
    ok: true, entry: { action: "reversal", reversesAuditId: "audit-1", reason: "Wrong fixture", actor: "admin", entryMode: "manual_reversal" }
  });
  assert.equal(buildTriggerAuditReversal("audit-1", {}).ok, false);
});
