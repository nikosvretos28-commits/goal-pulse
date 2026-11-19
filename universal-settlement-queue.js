"use strict";

const TERMINAL_ALERT = new Set(["won", "lost", "push", "void"]);
const TERMINAL_ACTIVITY = new Set(["won", "lost", "push", "void", "confirmed", "not_confirmed"]);
const TERMINAL_HUNTER = new Set(["confirmed", "not_confirmed", "won", "lost", "push", "void"]);

function isPending(value, terminal) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized || normalized === "pending" || normalized === "εκκρεμεί" || normalized === "εκκρεμει") return true;
  if (terminal.has(normalized)) return false;
  // Older HI/Pressure records use human-readable Greek labels rather than enum values.
  if (/επιβεβαιώθηκε|επιβεβαιωθηκε|δεν επιβεβαιώθηκε|δεν επιβεβαιωθηκε|κερδισμένο|κερδισμενο|χαμένο|χαμενο|επιστροφή|επιστροφη|void|cancelled|canceled/.test(normalized)) return false;
  return true;
}

function buildUniversalSettlementQueue(input = {}, limit = 1000) {
  const records = [];
  const push = (category, id, eventId, createdAt, payload, pending) => {
    if (!pending || !payload || typeof payload !== "object") return;
    records.push({
      category, id: String(id || ""), eventId: String(eventId || ""),
      createdAt: createdAt ?? payload.createdAt ?? null, payload
    });
  };

  for (const row of Array.isArray(input.alerts) ? input.alerts : []) {
    const payload = row.payload || {};
    const source = String(payload.source || "").toLowerCase();
    const alertType = String(payload.alertType || "").toLowerCase();
    const triggerIds = Array.isArray(payload.triggerIds) ? payload.triggerIds.map(value => String(value).toLowerCase()) : [];
    const isPowerGames = source === "manual-power-games";
    const isPowerRanking = source === "manual-power-ranking" ||
      alertType.startsWith("power_ranking_") || alertType === "power_ranking_signal" ||
      triggerIds.some(value => value.startsWith("power_ranking_"));
    const isManualHiActivity = source === "manual-high-activity";
    const category = isPowerGames ? "POWER_GAMES" : isPowerRanking ? "POWER_RANKING" :
      isManualHiActivity ? "HI_ACTIVITY" :
      String(row.level || payload.level || "AI").toUpperCase() === "VIP" ? "VIP_ALERT" : "AI_ALERT";
    push(
      category, row.alert_id || payload.alertId, row.event_id || payload.eventId, row.created_at || payload.createdAt,
      payload, isPending(payload.betOutcome ?? payload.outcomeStatus ?? payload.settlementStatus ?? payload.outcome ?? payload.status, TERMINAL_ALERT)
    );
  }
  for (const row of Array.isArray(input.hiActivity) ? input.hiActivity : []) {
    const payload = row.payload || {};
    const status = payload.outcomeStatus || payload.outcome || payload.settlementStatus || payload.status;
    push("HI_ACTIVITY", row.observation_id || payload.observationId, row.event_id || payload.eventId,
      row.created_at || payload.createdAt, payload, isPending(status, TERMINAL_ACTIVITY));
  }
  for (const row of Array.isArray(input.pressureHunter) ? input.pressureHunter : []) {
    const payload = row.payload || {};
    const status = payload.outcomeStatus || payload.outcome || payload.settlementStatus || payload.status;
    push("PRESSURE_HUNTER", row.alert_id || payload.alertId, row.event_id || payload.eventId,
      row.created_at || payload.createdAt, payload, isPending(status, TERMINAL_HUNTER));
  }

  records.sort((a, b) => {
    const left = Date.parse(a.createdAt || 0) || Number(a.createdAt) || 0;
    const right = Date.parse(b.createdAt || 0) || Number(b.createdAt) || 0;
    return right - left || a.category.localeCompare(b.category) || a.id.localeCompare(b.id);
  });
  const safeLimit = Math.max(1, Math.min(5000, Math.trunc(Number(limit) || 1000)));
  return {
    totalPending: records.length,
    returned: Math.min(records.length, safeLimit),
    truncated: records.length > safeLimit,
    counts: records.reduce((acc, item) => {
      acc[item.category] = (acc[item.category] || 0) + 1;
      return acc;
    }, {}),
    records: records.slice(0, safeLimit)
  };
}

module.exports = { buildUniversalSettlementQueue };
