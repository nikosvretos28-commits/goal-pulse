"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildUniversalSettlementQueue } = require("./universal-settlement-queue");

test("unifies pending AI, VIP, HI Activity and Pressure Hunter records", () => {
  const result = buildUniversalSettlementQueue({
    alerts: [
      { alert_id: "a1", event_id: "e1", level: "AI", created_at: "2026-11-19T05:00:00Z", payload: { betOutcome: "pending" } },
      { alert_id: "v1", event_id: "e2", level: "VIP", created_at: "2026-11-19T04:00:00Z", payload: { betOutcome: null } },
      { alert_id: "a2", event_id: "e3", level: "AI", payload: { betOutcome: "won" } }
    ],
    hiActivity: [
      { observation_id: "h1", event_id: "e4", created_at: "2026-11-19T03:00:00Z", payload: { outcome: "pending" } },
      { observation_id: "h2", event_id: "e5", payload: { outcome: "confirmed" } }
    ],
    pressureHunter: [
      { alert_id: "p1", event_id: "e6", created_at: "2026-11-19T02:00:00Z", payload: { outcomeStatus: "" } },
      { alert_id: "p2", event_id: "e7", payload: { outcomeStatus: "not_confirmed" } }
    ]
  });
  assert.equal(result.totalPending, 4);
  assert.deepEqual(result.counts, { AI_ALERT: 1, VIP_ALERT: 1, HI_ACTIVITY: 1, PRESSURE_HUNTER: 1 });
  assert.deepEqual(new Set(result.records.map(x => x.id)), new Set(["a1", "v1", "h1", "p1"]));
});

test("queue sorts newest first and reports truncation", () => {
  const result = buildUniversalSettlementQueue({
    alerts: [
      { alert_id: "old", level: "AI", created_at: "2026-11-18T00:00:00Z", payload: {} },
      { alert_id: "new", level: "AI", created_at: "2026-11-19T00:00:00Z", payload: {} }
    ]
  }, 1);
  assert.equal(result.totalPending, 2);
  assert.equal(result.returned, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.records[0].id, "new");
});

test("recognizes legacy Greek settled labels instead of reopening them", () => {
  const result = buildUniversalSettlementQueue({
    hiActivity: [
      { observation_id: "settled-gr", payload: { outcome: "Επιβεβαιώθηκε · μπήκε γκολ μετά το σήμα" } },
      { observation_id: "pending-gr", payload: { outcome: "εκκρεμεί" } }
    ],
    pressureHunter: [
      { alert_id: "hunter-settled", payload: { outcomeStatus: "not_confirmed" } },
      { alert_id: "hunter-pending", payload: { outcome: "εκκρεμεί" } }
    ]
  });
  assert.equal(result.totalPending, 2);
  assert.deepEqual(new Set(result.records.map(x => x.id)), new Set(["pending-gr", "hunter-pending"]));
});


test("separates Power Games and Power Ranking from their shared AI/VIP history stores", () => {
  const result = buildUniversalSettlementQueue({
    alerts: [
      { alert_id: "pg1", event_id: "e1", level: "VIP", payload: { source: "manual-power-games", betOutcome: "pending" } },
      { alert_id: "pr1", event_id: "e2", level: "VIP", payload: { source: "manual-power-ranking", betOutcome: "pending" } },
      { alert_id: "pr2", event_id: "e3", level: "AI", payload: { alertType: "power_ranking_signal", betOutcome: "pending" } },
      { alert_id: "hi1", event_id: "e4", level: "VIP", payload: { source: "manual-high-activity", betOutcome: "pending" } },
      { alert_id: "vip1", event_id: "e5", level: "VIP", payload: { betOutcome: "pending" } }
    ]
  });
  assert.deepEqual(result.counts, {
    POWER_GAMES: 1, POWER_RANKING: 2, HI_ACTIVITY: 1, VIP_ALERT: 1
  });
  assert.equal(result.totalPending, 5);
});
