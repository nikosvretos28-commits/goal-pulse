"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeStatArenaMatch } = require("./statarena-live-stats");

const teams = [
  { id: 10, name: "Home FC", meta: { location: "home" } },
  { id: 20, name: "Away SC", meta: { location: "away" } }
];

test("normalizes StatArena SOT by home and away participant", () => {
  const result = normalizeStatArenaMatch({
    participants: teams,
    statistics: [
      { participant_id: 10, type: { name: "Shots On Target" }, data: { value: 5 } },
      { participant_id: 20, type: { name: "Shots On Target" }, data: { value: 3 } },
      { participant_id: 10, type: { name: "Shots Total" }, data: { value: 9 } }
    ]
  });
  assert.equal(result.values.home.shotsOnTarget, 5);
  assert.equal(result.values.away.shotsOnTarget, 3);
  assert.equal(result.values.home.totalShots, 9);
});

test("normalizes paired home/away statistic rows", () => {
  const result = normalizeStatArenaMatch({
    participants: teams,
    statistics: [
      { type: { name: "Shots On Target" }, data: { home: 5, away: 3 } },
      { name: "Corners", home: { value: 4 }, away: { value: 2 } }
    ]
  });
  assert.equal(result.values.home.shotsOnTarget, 5);
  assert.equal(result.values.away.shotsOnTarget, 3);
  assert.equal(result.values.home.corners, 4);
  assert.equal(result.values.away.corners, 2);
});

test("normalizes statistics grouped by side", () => {
  const result = normalizeStatArenaMatch({
    participants: teams,
    statistics: {
      home: [{ name: "Shots On Target", data: { value: 5 } }],
      away: [{ name: "Shots On Target", data: { value: 3 } }]
    }
  });
  assert.equal(result.values.home.shotsOnTarget, 5);
  assert.equal(result.values.away.shotsOnTarget, 3);
});

test("does not invent a side when participant identity is missing", () => {
  const result = normalizeStatArenaMatch({
    participants: teams,
    statistics: [
      { type: { name: "Shots On Target" }, data: { value: 5 } }
    ]
  });
  assert.deepEqual(result.values, { home: {}, away: {} });
});
