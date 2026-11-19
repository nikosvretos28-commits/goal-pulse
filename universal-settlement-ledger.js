"use strict";

const STATUSES = new Set(["pending", "disputed", "verified", "finalized", "reversed"]);
const TERMINAL = new Set(["finalized", "reversed"]);
const ACTIONS = new Set(["evidence_attached", "disputed", "verified", "finalized", "reversed"]);

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function validateLedgerEvent(input = {}) {
  const settlementId = clean(input.settlementId, 180);
  const sourceCategory = clean(input.sourceCategory, 40).toLowerCase();
  const sourceRecordId = clean(input.sourceRecordId, 180);
  const eventId = clean(input.eventId, 180);
  const action = clean(input.action, 40).toLowerCase();
  const actor = clean(input.actor, 120);
  const reason = clean(input.reason, 1000);
  const idempotencyKey = clean(input.idempotencyKey, 180) || null;
  if (!settlementId || !sourceRecordId || !eventId || !actor ||
      !["ai_alert", "vip_alert", "hi_activity", "pressure_hunter", "power_games", "power_ranking"].includes(sourceCategory) ||
      !ACTIONS.has(action)) return { ok: false, reason: "invalid_ledger_event" };
  if (["disputed", "reversed"].includes(action) && !reason) return { ok: false, reason: "reason_required" };
  if (action === "finalized" && input.evaluatorVerified !== true) return { ok: false, reason: "verified_evaluator_result_required" };
  if (action === "verified" && input.evidenceVerified !== true) return { ok: false, reason: "verified_evidence_required" };
  const evidence = input.evidence && typeof input.evidence === "object" && !Array.isArray(input.evidence) ? input.evidence : null;
  const evaluation = input.evaluation && typeof input.evaluation === "object" && !Array.isArray(input.evaluation) ? input.evaluation : null;
  if (action === "evidence_attached" && !evidence) return { ok: false, reason: "evidence_required" };
  if (action === "finalized" && (!evaluation || !["won", "lost", "push", "void", "confirmed", "not_confirmed"].includes(evaluation.outcome))) {
    return { ok: false, reason: "supported_evaluation_required" };
  }
  return { ok: true, event: {
    settlementId, sourceCategory, sourceRecordId, eventId, action, actor, reason: reason || null,
    evidence, evaluation, idempotencyKey,
    status: action === "disputed" ? "disputed" : action === "finalized" ? "finalized" :
      action === "reversed" ? "reversed" : action === "verified" ? "verified" : "pending"
  }};
}

function validateLedgerTransition(currentStatus, nextEvent) {
  const current = STATUSES.has(String(currentStatus || "")) ? String(currentStatus) : "pending";
  const action = String(nextEvent?.action || "");
  if (!ACTIONS.has(action)) return { ok: false, reason: "unsupported_action" };
  if (TERMINAL.has(current)) return { ok: false, reason: "terminal_record_requires_new_reversal_event" };
  const allowed = {
    pending: new Set(["evidence_attached", "disputed", "verified"]),
    disputed: new Set(["evidence_attached", "verified"]),
    verified: new Set(["disputed", "finalized"])
  };
  if (!allowed[current]?.has(action)) return { ok: false, reason: "invalid_status_transition" };
  if (action === "finalized" && current !== "verified") return { ok: false, reason: "verification_required_before_finalization" };
  return { ok: true, status: nextEvent.status };
}

function reduceLedgerEvents(events = []) {
  const ordered = [...events].sort((a, b) => {
    const left = Date.parse(a.created_at || a.createdAt || 0) || 0;
    const right = Date.parse(b.created_at || b.createdAt || 0) || 0;
    return left - right;
  });
  const state = new Map();
  for (const event of ordered) {
    const id = clean(event.settlement_id || event.settlementId, 180);
    if (!id) continue;
    const prior = state.get(id) || { status: "pending", events: [] };
    prior.events.push(event);
    if (STATUSES.has(event.status)) prior.status = event.status;
    state.set(id, prior);
  }
  return [...state.entries()].map(([settlementId, value]) => ({ settlementId, ...value }));
}

module.exports = { STATUSES, validateLedgerEvent, validateLedgerTransition, reduceLedgerEvents };
