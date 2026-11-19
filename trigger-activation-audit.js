"use strict";

const CATEGORIES = new Set(["ai", "vip", "hi_activity", "pressure_hunter", "power_games", "power_ranking", "other"]);
const PERIODS = new Set(["first_half", "second_half", "extra_time", "unknown"]);
const STAT_KEYS = new Set(["sot", "homeSot", "awaySot", "sotLast5", "sotLast10", "homeSotLast5", "awaySotLast5", "homeSotLast10", "awaySotLast10", "xg", "homeXg", "awayXg", "minute", "score", "homeScore", "awayScore", "period"]);

function clean(value, max = 240) { return String(value ?? "").trim().slice(0, max); }
function validMinute(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 150 ? n : null;
}
function sanitizeSnapshot(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!STAT_KEYS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) output[key] = value;
    else if (typeof value === "string" || typeof value === "boolean") output[key] = String(value).slice(0, 80);
  }
  return Object.keys(output).length ? output : null;
}
function validateTriggerAudit(input = {}) {
  const category = clean(input.category, 40).toLowerCase();
  const eventId = clean(input.eventId, 180);
  const triggerId = clean(input.triggerId, 120);
  const triggerName = clean(input.triggerName, 180);
  const protocolId = clean(input.protocolId, 120);
  const minute = validMinute(input.minute);
  const period = clean(input.period, 30).toLowerCase();
  const evidenceRef = clean(input.evidenceRef, 1000);
  const evidenceType = clean(input.evidenceType, 40).toLowerCase();
  const snapshot = sanitizeSnapshot(input.snapshot);
  const sourceRecordId = clean(input.sourceRecordId, 180) || null;
  const alertId = clean(input.alertId, 180) || null;
  const actor = clean(input.actor, 120) || "admin";
  if (!CATEGORIES.has(category) || !eventId || !triggerId || !triggerName || !protocolId ||
      minute === null || !PERIODS.has(period) || !snapshot || !evidenceRef ||
      !["log", "trace", "screenshot", "provider_record", "user_supplied"].includes(evidenceType)) {
    return { ok: false, reason: "incomplete_trigger_audit" };
  }
  if (category === "ai" || category === "vip" || category === "hi_activity" || category === "pressure_hunter" || category === "power_games" || category === "power_ranking") {
    if (!sourceRecordId && !alertId) return { ok: false, reason: "missing_history_link" };
  }
  return { ok: true, entry: {
    eventId, category, sourceRecordId, alertId, triggerId, triggerName, protocolId,
    minute, period, snapshot, evidenceType, evidenceRef,
    entryMode: "manual_reconstruction", verificationStatus: "evidence_attached",
    actor, notes: clean(input.notes, 1000) || null,
    idempotencyKey: clean(input.idempotencyKey, 180) || null
  }};
}
function buildTriggerAuditReversal(originalId, input = {}) {
  const targetId = clean(originalId, 180);
  const reason = clean(input.reason, 1000);
  const actor = clean(input.actor, 120) || "admin";
  if (!targetId || !reason) return { ok: false, reason: "missing_reversal_target_or_reason" };
  return { ok: true, entry: { action: "reversal", reversesAuditId: targetId, reason, actor, entryMode: "manual_reversal" } };
}
module.exports = { CATEGORIES, PERIODS, validateTriggerAudit, buildTriggerAuditReversal, sanitizeSnapshot };
