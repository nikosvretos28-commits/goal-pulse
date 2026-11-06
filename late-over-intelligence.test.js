const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateLateOverHistory } = require("./late-over-intelligence");

function profile(teamName, matches, rate, leagueRate = 0.55, line = "4.5") {
  return { teamName, matches, overRates: { [line]: rate }, leagueOverRates: { [line]: leagueRate } };
}

test("one team qualifies at 65%+ with enough sample and above league average", () => {
  const result = evaluateLateOverHistory({
    line: 4.5,
    homeProfile: profile("Home", 24, 0.70, 0.55),
    awayProfile: profile("Away", 24, 0.52, 0.55)
  });
  assert.equal(result.eligible, true);
  assert.equal(result.home.qualifies, true);
});

test("rejects when both teams are below 65%", () => {
  const result = evaluateLateOverHistory({
    line: 5.5,
    homeProfile: profile("Home", 30, 0.60, 0.50, "5.5"),
    awayProfile: profile("Away", 28, 0.62, 0.51, "5.5")
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "both-teams-below-65-percent");
});

test("rejects insufficient sample", () => {
  const result = evaluateLateOverHistory({
    line: 6.5,
    homeProfile: profile("Home", 14, 0.80, 0.50, "6.5"),
    awayProfile: profile("Away", 22, 0.60, 0.50, "6.5")
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "insufficient-sample");
});

test("rejects rate below league average", () => {
  const result = evaluateLateOverHistory({
    line: 3.5,
    homeProfile: profile("Home", 22, 0.68, 0.72, "3.5"),
    awayProfile: profile("Away", 22, 0.64, 0.60, "3.5")
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "below-league-average");
});

test("uses exact line and rejects unsupported lines", () => {
  const result = evaluateLateOverHistory({
    line: 5.5,
    homeProfile: profile("Home", 24, 0.70, 0.50, "4.5"),
    awayProfile: profile("Away", 24, 0.60, 0.50, "5.5")
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "missing-exact-line-rate");
  assert.equal(evaluateLateOverHistory({ line: 7.5 }).reason, "unsupported-line");
});
