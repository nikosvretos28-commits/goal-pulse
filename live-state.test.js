"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isLiveEvent, normalizeStatus } = require("./live-state");

test("normalizes provider status codes, spaces and hyphens", () => {
  assert.equal(normalizeStatus(" STATUS_IN_PROGRESS "), "in_progress");
  assert.equal(normalizeStatus("In Progress"), "in_progress");
  assert.equal(normalizeStatus("First-Half"), "first_half");
});

test("recognizes common live football states and aliases", () => {
  for (const state of [
    "in", "IN", "live", "playing", "inplay", "in_play", "in_progress",
    "STATUS_IN_PROGRESS", "1H", "2H", "1st Half", "2nd Half",
    "HT", "Halftime", "Half Time", "ET", "Extra Time", "BT", "Break Time", "P",
    "pen", "pens", "penalties", "penalty_shootout", "shootout"
  ]) {
    assert.equal(isLiveEvent({ status: { type: { state } } }), true, state);
  }
});

test("recognizes live status in any competition when event status is stale", () => {
  assert.equal(isLiveEvent({
    status: { type: { state: "pre" } },
    competitions: [
      { status: { type: { state: "post" } } },
      { status: { type: { state: "2H" } } }
    ]
  }), true);
});

test("recognizes provider human-readable status labels", () => {
  for (const description of [
    "In Progress", "Live", "Playing", "First Half", "Second Half",
    "Halftime", "Extra Time", "Penalty Shootout"
  ]) {
    assert.equal(isLiveEvent({ status: { type: { state: "unknown", description } } }), true, description);
  }
});

test("does not classify scheduled, postponed, suspended or finished events as live", () => {
  for (const state of [
    "pre", "scheduled", "not_started", "post", "finished", "final",
    "full_time", "FT", "AET", "cancelled", "postponed", "suspended", "delayed"
  ]) {
    assert.equal(isLiveEvent({ status: { type: { state } } }), false, state);
  }
  assert.equal(isLiveEvent({ status: { type: { state: "pre", description: "Scheduled" } } }), false);
  assert.equal(isLiveEvent({ status: { type: { state: "post", description: "Full Time" } } }), false);
});

test("does not infer live state from a clock or unrelated text", () => {
  assert.equal(isLiveEvent({ status: { displayClock: "45:00", type: { state: "pre" } } }), false);
  assert.equal(isLiveEvent({ status: { type: { state: "unknown", description: "Live coverage starts soon" } } }), false);
  assert.equal(isLiveEvent(null), false);
});
