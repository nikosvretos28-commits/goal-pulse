"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCloudAlertRuntime } = require("./cloud-alert-runtime");

test("Cloud Alert push path is locked by default before touching database or push delivery", async () => {
  const runtime = createCloudAlertRuntime({
    getPool() { throw new Error("database must not be accessed while activation is locked"); },
    async sendPush() { throw new Error("push delivery must never be called while activation is locked"); }
  });
  const result = await runtime.processCandidate({
    matchId: "fixture-1", period: "1H", triggers: ["EARLY_1H"],
    minute: 30, home: "Home", away: "Away", homeSot: 3, awaySot: 2,
    scoreHome: 0, scoreAway: 0
  });
  assert.deepEqual(result, { ok: true, pushed: false, reason: "cloud_alert_activation_locked" });
});

test("Cloud Alert TEST Push is a delivery-only route and does not invoke candidate or settlement processing", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  const routeStart = server.indexOf('url.pathname === "/api/cloud-alert/test-push"');
  const routeEnd = server.indexOf('url.pathname === "/api/push/test"', routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const route = server.slice(routeStart, routeEnd);
  assert.ok(route.includes("pushRequestAllowed(req, res)"));
  assert.ok(route.includes("sendPushToSubscribers("));
  assert.ok(route.includes('channel: "cloud-alert"'));
  assert.ok(!route.includes("processCandidate"));
  assert.ok(!route.includes("recordShadowCandidate"));
  assert.ok(!route.includes("cloudAlertSettlement"));
  assert.ok(!route.includes("INSERT INTO"));
});

test("production server gates Cloud Alert push behind an explicit environment switch", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  const scanner = fs.readFileSync(path.join(__dirname, "cloud-alert-scanner.js"), "utf8");
  assert.ok(server.includes('CLOUD_ALERT_PUSH_ENABLED = process.env.CLOUD_ALERT_PUSH_ENABLED === "true"'));
  assert.ok(server.includes("pushEnabled: CLOUD_ALERT_PUSH_ENABLED"));
  assert.ok(scanner.includes("runtime.processCandidate(candidate)"));
  assert.ok(scanner.includes("runtime.recordShadowCandidate(candidate)"));
});
