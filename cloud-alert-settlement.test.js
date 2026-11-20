"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateSettlementInput, gradeSignalSettlement
} = require("./cloud-alert-settlement");

test("requires settlement identity and source metadata", () => {
  const result = validateSettlementInput({});
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("signalId_required"));
  assert.ok(result.errors.includes("provider_required"));
  assert.ok(result.errors.includes("fixtureId_required"));
  assert.ok(result.errors.includes("source_required"));
});

test("validates verified HT/FT scores and records explicit metadata", () => {
  const result = validateSettlementInput({
    signalId: "sig-1", targetPeriod: "HT", state: "settled_verified",
    provider: "ESPN", fixtureId: "fixture-123", source: "official scoreboard",
    settledAt: "2026-11-20T07:00:00Z", scoreHome: 2, scoreAway: 1
  });
  assert.equal(result.valid, true);
  assert.equal(result.value.targetPeriod, "HT");
});

test("requires a reason for unverifiable or disputed records", () => {
  for (const state of ["unverifiable", "disputed"]) {
    const result = validateSettlementInput({
      signalId: "sig-1", targetPeriod: "HT", state, provider: "ESPN",
      fixtureId: "fixture-123", source: "official scoreboard",
      settledAt: "2026-11-20T07:00:00Z"
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes("reason_required_for_nonverified_state"));
  }
});

test("grades over signal-time total goals plus 0.5 using HT score", () => {
  const signal = { period: "1H", scoreHome: 1, scoreAway: 0 };
  const win = gradeSignalSettlement(signal, "HT", 2, 0);
  assert.equal(win.valid, true);
  assert.equal(win.overLine, 1.5);
  assert.equal(win.outcome, "win");
  const loss = gradeSignalSettlement(signal, "HT", 1, 0);
  assert.equal(loss.outcome, "loss");
});

test("a second-half signal cannot be graded at HT", () => {
  const result = gradeSignalSettlement({ period: "2H", scoreHome: 0, scoreAway: 0 }, "HT", 1, 0);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "second_half_signal_cannot_settle_at_half_time");
});

test("does not invent a missing signal-time score", () => {
  const result = gradeSignalSettlement({ period: "1H", scoreHome: null, scoreAway: null }, "FT", 2, 1);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signal_time_score_missing");
});
