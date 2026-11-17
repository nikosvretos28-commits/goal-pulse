"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeLiveMinute } = require("./live-minute");

test("normalizes regular provider clocks", () => {
  assert.equal(normalizeLiveMinute("67:32"), "67′");
  assert.equal(normalizeLiveMinute("68'"), "68′");
  assert.equal(normalizeLiveMinute("68"), "68′");
});

test("preserves stoppage-time base minute and added time", () => {
  assert.equal(normalizeLiveMinute("45+2'"), "45+2′");
  assert.equal(normalizeLiveMinute("90 + 5′"), "90+5′");
});

test("uses the first explicit clock when earlier status fields are labels", () => {
  assert.equal(normalizeLiveMinute("2nd Half", "73'"), "73′");
  assert.equal(normalizeLiveMinute("HT", "45+1'"), "45+1′");
});

test("does not invent a minute from status labels", () => {
  assert.equal(normalizeLiveMinute("HT", "2nd Half", "LIVE"), null);
});
