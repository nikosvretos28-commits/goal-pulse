"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeTeamKey, seasonBoundsForLeague, buildPreMatchMatchupContext } = require("./pre-match-intelligence");

test("European season keeps July in the season that began the previous August", () => {
  const july = seasonBoundsForLeague("eng.1", new Date("2026-07-15T12:00:00.000Z"));
  const august = seasonBoundsForLeague("eng.1", new Date("2026-08-01T00:00:00.000Z"));
  assert.equal(july.seasonKey, "2025/2026");
  assert.equal(august.seasonKey, "2026/2027");
});

test("calendar-year leagues retain calendar season keys", () => {
  const result = seasonBoundsForLeague("bra.1", new Date("2026-07-15T12:00:00.000Z"));
  assert.equal(result.seasonKey, "2026");
  assert.equal(result.start, "20260101");
});

test("team normalization handles accents and punctuation", () => {
  assert.equal(normalizeTeamKey("Atlético-Madrid"), "atletico madrid");
});

test("matchup context combines attack, defence, clean sheets and exact Over rates", () => {
  const home = {
    teamName: "Home FC", matches: 20, goalsForAvg: 1.8, goalsAgainstAvg: 0.9,
    cleanSheetRate: 0.4, failedToScoreRate: 0.1, overRates: { "2.5": 0.6 },
    homeAway: { home: { matches: 10, goalsForAvg: 2.1, goalsAgainstAvg: 0.7, cleanSheetRate: 0.5, failedToScoreRate: 0.1, overRates: { "2.5": 0.7 } } },
    opponents: { "away fc": { matches: 2, wins: 1, draws: 1, losses: 0, goalsFor: 3, goalsAgainst: 1, overRates: { "2.5": 0.5 } } }
  };
  const away = {
    teamName: "Away FC", matches: 18, goalsForAvg: 1.2, goalsAgainstAvg: 1.5,
    cleanSheetRate: 0.2, failedToScoreRate: 0.25, overRates: { "2.5": 0.55 },
    homeAway: { away: { matches: 9, goalsForAvg: 1.0, goalsAgainstAvg: 1.7, cleanSheetRate: 0.1, failedToScoreRate: 0.3, overRates: { "2.5": 0.6 } } }
  };
  const context = buildPreMatchMatchupContext(home, away, "Home FC", "Away FC");
  assert.equal(context.home.goalsForAvg, 2.1);
  assert.equal(context.away.goalsAgainstAvg, 1.7);
  assert.equal(context.home.cleanSheetRate, 0.5);
  assert.equal(context.expectedGoals.home, 1.9);
  assert.equal(context.expectedGoals.away, 0.85);
  assert.equal(context.expectedGoals.total, 2.75);
  assert.equal(context.headToHead.available, true);
  assert.equal(context.headToHead.sample, 2);
  assert.equal(context.headToHead.wins, 1);
});


test("head-to-head fallback reverses the away team's record into home-team perspective", () => {
  const away = {
    matches: 18,
    opponents: {
      "home fc": { matches: 3, wins: 2, draws: 0, losses: 1, goalsFor: 5, goalsAgainst: 3 }
    }
  };
  const context = buildPreMatchMatchupContext(null, away, "Home FC", "Away FC");
  assert.equal(context.headToHead.wins, 1);
  assert.equal(context.headToHead.losses, 2);
  assert.equal(context.headToHead.goalsFor, 3);
  assert.equal(context.headToHead.goalsAgainst, 5);
});

test("insufficient team history stays unknown instead of becoming zero", () => {
  const context = buildPreMatchMatchupContext({ matches: 2 }, { matches: 4 }, "Home", "Away");
  assert.equal(context.home.cleanSheetRate, null);
  assert.equal(context.away.goalsForAvg, null);
  assert.equal(context.expectedGoals.total, null);
  assert.equal(context.headToHead.available, false);
});
