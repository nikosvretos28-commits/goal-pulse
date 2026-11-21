"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMatrixAlertTestPushPayload } = require("./matrix-alert-test-push");

test("Matrix Alert test push is clearly labelled and contains no synthetic match", () => {
  const payload = buildMatrixAlertTestPushPayload();
  assert.equal(payload.title, "🧩 GOALMATRIX · MATRIX ALERT TEST");
  assert.match(payload.body, /δοκιμαστική ειδοποίηση/i);
  assert.match(payload.body, /Δεν αντιστοιχεί σε πραγματικό αγώνα ή σήμα/);
  assert.equal(payload.tag, "goalmatrix-matrix-alert-test");
  assert.equal(payload.url, "/");
  assert.equal(payload.matrixAlertTest, true);
  assert.equal("matchContext" in payload, false);
  assert.equal("eventId" in payload, false);
  assert.equal("score" in payload, false);
});

test("Matrix Alert test payload is isolated from other alert channels", () => {
  const payload = buildMatrixAlertTestPushPayload();
  assert.doesNotMatch(payload.title, /CLOUD ALERT|AI ALERT|VIP ALERT/i);
  assert.doesNotMatch(payload.tag, /cloud-alert|synthetic-ai|vip/i);
});
