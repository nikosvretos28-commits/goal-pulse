"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createLiveIntelligenceRuntime } = require("./live-intelligence-runtime");

function match(overrides = {}) {
  return {
    eventId: "fixture-123",
    home: "Real",
    away: "Barcelona",
    league: "La Liga",
    country: "Spain",
    minute: 68,
    score: { home: 0, away: 0 },
    analysis: { independent: true, gameState: { redCards: { home: 0, away: 0 } }, windows: {} },
    ...overrides
  };
}

test("independent scanner seeds current state and sends one frozen push after a verified score change", async () => {
  let current = match();
  const deliveries = [];
  const runtime = createLiveIntelligenceRuntime({
    getMatches: async () => [current],
    sendPush: async payload => { deliveries.push(payload); return { sent: 1, failed: 0, configured: true }; }
  });
  const first = await runtime.scan();
  assert.equal(first.ok, true);
  assert.equal(first.results[0].seeded, true);
  assert.equal(deliveries.length, 0);

  current = match({ minute: 69, score: { home: 1, away: 0 } });
  const second = await runtime.scan();
  assert.equal(second.results[0].deliveryStatus, "delivered");
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].body, /1-0 · 69′ · La Liga · Spain/);
  assert.match(deliveries[0].body, /Real – Barcelona/);

  const third = await runtime.scan();
  assert.equal(third.results[0].observed, true);
  assert.equal(deliveries.length, 1);
  const history = await runtime.listHistory();
  assert.equal(history.persistent, false);
  assert.equal(history.records.length, 1);
  assert.equal(history.records[0].delivery_status, "delivered");
});

test("independent scanner detects a red-card change and keeps alert history separate", async () => {
  let current = match();
  const deliveries = [];
  const runtime = createLiveIntelligenceRuntime({
    getMatches: async () => [current],
    sendPush: async payload => { deliveries.push(payload); return { sent: 1, failed: 0, configured: true }; }
  });
  await runtime.scan();
  current = match({ minute: 74, analysis: { independent: true, gameState: { redCards: { home: 0, away: 1 } }, windows: {} } });
  const result = await runtime.scan();
  assert.equal(result.results[0].deliveryStatus, "delivered");
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].body, /Αλλαγή αριθμητικών ισορροπιών/);
});

test("missing identity or incomplete match snapshot never sends an alert", async () => {
  let current = match();
  const deliveries = [];
  const runtime = createLiveIntelligenceRuntime({
    getMatches: async () => [current],
    sendPush: async payload => { deliveries.push(payload); return { sent: 1, failed: 0, configured: true }; }
  });
  await runtime.scan();
  current = match({ score: { home: 1, away: 0 }, country: "" });
  const result = await runtime.scan();
  assert.equal(result.results[0].reason, "incomplete_match_snapshot");
  assert.equal(deliveries.length, 0);
});

test("unconfigured push is recorded once and does not retry or duplicate", async () => {
  let current = match();
  let attempts = 0;
  const runtime = createLiveIntelligenceRuntime({
    getMatches: async () => [current],
    sendPush: async () => { attempts++; return { sent: 0, failed: 0, configured: false }; }
  });
  await runtime.scan();
  current = match({ score: { home: 1, away: 0 } });
  await runtime.scan();
  await runtime.scan();
  assert.equal(attempts, 1);
  const history = await runtime.listHistory();
  assert.equal(history.records[0].delivery_status, "not_configured");
});

test("pending delivery is retried on the next independent scan without a duplicate alert record", async () => {
  let current = match();
  let attempts = 0;
  const runtime = createLiveIntelligenceRuntime({
    getMatches: async () => [current],
    sendPush: async () => {
      attempts++;
      return attempts === 1
        ? { sent: 0, failed: 1, configured: true }
        : { sent: 1, failed: 0, configured: true };
    }
  });
  await runtime.scan();
  current = match({ score: { home: 1, away: 0 } });
  const first = await runtime.scan();
  assert.equal(first.results[0].deliveryStatus, "pending");
  await runtime.scan();
  assert.equal(attempts, 2);
  const history = await runtime.listHistory();
  assert.equal(history.records.length, 1);
  assert.equal(history.records[0].delivery_status, "delivered");
  assert.equal(history.records[0].attempts, 2);
});

test("records simultaneous goal and red-card changes as separate deduplicated alerts", async () => {
  let current = match();
  const deliveries = [];
  const runtime = createLiveIntelligenceRuntime({
    getMatches: async () => [current],
    sendPush: async payload => { deliveries.push(payload); return { sent: 1, failed: 0, configured: true }; }
  });
  await runtime.scan();
  current = match({
    minute: 75,
    score: { home: 1, away: 0 },
    analysis: { independent: true, gameState: { redCards: { home: 0, away: 1 } }, windows: {} }
  });
  const result = await runtime.scan();
  assert.equal(result.results[0].events.length, 2);
  assert.equal(deliveries.length, 2);
  const history = await runtime.listHistory();
  assert.equal(history.records.length, 2);
});
