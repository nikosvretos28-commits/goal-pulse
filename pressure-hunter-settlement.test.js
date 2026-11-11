"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { settlePressureHunterRecord } = require("./pressure-hunter-settlement");

const record = {
  alertId: "hunter:fixture:DUAL_PRESSURE",
  home: "Home FC",
  away: "Away FC",
  scoreAtSignal: { home: 1, away: 0 },
  outcome: "εκκρεμεί"
};
const finished = {
  status: "post",
  statusText: "Full Time",
  homeScore: 2,
  awayScore: 0,
  settlementProvider: "ESPN",
  settlementFixtureId: "fixture",
  settlementFixtureDate: "2026-11-11"
};

test("confirms when at least one goal is scored after the signal", () => {
  const settled = settlePressureHunterRecord(record, finished, 123);
  assert.equal(settled.outcomeStatus, "confirmed");
  assert.equal(settled.goalsAfterSignal, 1);
  assert.equal(settled.finalScore, "2-0");
  assert.equal(settled.settledAt, 123);
});

test("does not confirm when no further goal is scored", () => {
  const settled = settlePressureHunterRecord(record, { ...finished, homeScore: 1 }, 123);
  assert.equal(settled.outcomeStatus, "not_confirmed");
  assert.equal(settled.goalsAfterSignal, 0);
});

test("leaves record pending without a signal-time score", () => {
  assert.equal(settlePressureHunterRecord({ ...record, scoreAtSignal: null }, finished), null);
});

test("leaves record pending without verified provider fixture identity", () => {
  assert.equal(settlePressureHunterRecord(record, { ...finished, settlementFixtureId: "" }), null);
});

test("leaves record pending while fixture is not finished", () => {
  assert.equal(settlePressureHunterRecord(record, { ...finished, status: "in" }), null);
});

test("leaves record pending if final score total is lower than signal score", () => {
  assert.equal(settlePressureHunterRecord({ ...record, scoreAtSignal: { home: 2, away: 1 } }, finished), null);
});
