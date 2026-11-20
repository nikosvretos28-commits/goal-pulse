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
