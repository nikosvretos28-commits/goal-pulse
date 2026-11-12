const test = require("node:test");
const assert = require("node:assert/strict");
const { addRollingTrends } = require("./rolling-trend-history");

function match(sotHome, sotAway = 0) {
  return {
    eventId: "friendly-rb-leipzig",
    teams: [
      { team: "RB Leipzig", shotsOnTarget: sotHome, corners: 1, attacks: 10, dangerousAttacks: 4 },
      { team: "FK Mlada Boleslav", shotsOnTarget: sotAway, corners: 0, attacks: 5, dangerousAttacks: 2 }
    ]
  };
}

test("HI rolling windows build independently from AI/VIP history", () => {
  const aiVipHistory = new Map();
  const hiHistory = new Map();

  addRollingTrends([match(2)], aiVipHistory, 0);
  addRollingTrends([match(0)], hiHistory, 0);

  const afterSixMinutes = match(5, 1);
  addRollingTrends([afterSixMinutes], hiHistory, 6 * 60 * 1000);

  assert.equal(afterSixMinutes.trend.window5m.available, true);
  assert.equal(afterSixMinutes.trend.window5m.teams[0].shotsOnTarget, 5);
  assert.equal(afterSixMinutes.trend.window5m.teams[1].shotsOnTarget, 1);
  assert.equal(afterSixMinutes.trend.window10m.available, false);

  const afterElevenMinutes = match(7, 2);
  addRollingTrends([afterElevenMinutes], hiHistory, 11 * 60 * 1000);
  assert.equal(afterElevenMinutes.trend.window10m.available, true);
  assert.equal(afterElevenMinutes.trend.window10m.teams[0].shotsOnTarget, 7);
  assert.equal(afterElevenMinutes.trend.window10m.teams[1].shotsOnTarget, 2);

  // Updating HI history must not append to or overwrite the AI/VIP store.
  assert.equal(aiVipHistory.get("friendly-rb-leipzig").length, 1);
  assert.equal(hiHistory.get("friendly-rb-leipzig").length, 3);
});

test("missing SOT remains unknown and is never converted to zero", () => {
  const history = new Map();
  addRollingTrends([match(null, 1)], history, 0);
  const current = match(null, 2);
  addRollingTrends([current], history, 6 * 60 * 1000);

  assert.equal(current.trend.window5m.available, true);
  assert.equal(current.trend.window5m.teams[0].shotsOnTarget, null);
  assert.equal(current.trend.window5m.teams[1].shotsOnTarget, 1);
});
