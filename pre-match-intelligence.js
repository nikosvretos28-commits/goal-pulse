"use strict";

function normalizeTeamKey(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function seasonBoundsForLeague(leagueCode, now = new Date()) {
  const year = now.getUTCFullYear();
  const calendarSeason = ["bra.1", "arg.1", "usa.1", "mex.1", "aus.1", "bra.2", "arg.2", "arg.3"].includes(String(leagueCode || ""));
  if (calendarSeason) {
    return { seasonKey: String(year), start: String(year) + "0101", end: String(year) + "1231" };
  }
  // European split-year seasons run August through July. July still belongs
  // to the season that began the previous August.
  const startYear = now.getUTCMonth() >= 7 ? year : year - 1;
  return {
    seasonKey: String(startYear) + "/" + String(startYear + 1),
    start: String(startYear) + "0801",
    end: String(startYear + 1) + "0731"
  };
}

function finiteRate(numerator, denominator) {
  return Number.isFinite(Number(numerator)) && Number(denominator) > 0
    ? Number((Number(numerator) / Number(denominator)).toFixed(4))
    : null;
}

function profileSide(profile, venue, kind) {
  const overallMatches = Number(profile?.matches || 0);
  const split = profile?.homeAway?.[venue];
  const splitMatches = Number(split?.matches || 0);
  const useSplit = splitMatches >= 5;
  const source = useSplit ? split : overallMatches >= 5 ? profile : null;
  if (!source) return { sample: splitMatches || overallMatches, source: "insufficient-sample", goalsForAvg: null, goalsAgainstAvg: null, cleanSheetRate: null, failedToScoreRate: null, overRates: {} };
  const sample = Number(source.matches || 0);
  const goalsForAvg = source.goalsForAvg != null && Number.isFinite(Number(source.goalsForAvg))
    ? Number(source.goalsForAvg)
    : finiteRate(source.goalsFor, sample);
  const goalsAgainstAvg = source.goalsAgainstAvg != null && Number.isFinite(Number(source.goalsAgainstAvg))
    ? Number(source.goalsAgainstAvg)
    : finiteRate(source.goalsAgainst, sample);
  const cleanSheetRate = source.cleanSheetRate != null && Number.isFinite(Number(source.cleanSheetRate))
    ? Number(source.cleanSheetRate)
    : finiteRate(source.cleanSheets, sample);
  const failedToScoreRate = source.failedToScoreRate != null && Number.isFinite(Number(source.failedToScoreRate))
    ? Number(source.failedToScoreRate)
    : finiteRate(source.failedToScore, sample);
  const overRates = source.overRates || Object.fromEntries(Object.entries(source.over || {}).map(([line, count]) => [line, finiteRate(count, sample)]));
  return { sample, source: useSplit ? venue : "overall-fallback", goalsForAvg, goalsAgainstAvg, cleanSheetRate, failedToScoreRate, overRates };
}

function findHeadToHead(homeProfile, awayProfile, homeName, awayName) {
  const homeKey = normalizeTeamKey(awayName);
  const awayKey = normalizeTeamKey(homeName);
  const direct = homeProfile?.opponents?.[homeKey];
  const reverse = awayProfile?.opponents?.[awayKey];
  const item = direct || reverse;
  if (!item || Number(item.matches || 0) < 1) return { available: false, sample: 0 };
  const matches = Number(item.matches || 0);
  return {
    available: true,
    sample: matches,
    wins: Number(item.wins || 0),
    draws: Number(item.draws || 0),
    losses: Number(item.losses || 0),
    goalsFor: Number(item.goalsFor || 0),
    goalsAgainst: Number(item.goalsAgainst || 0),
    goalsForAvg: finiteRate(item.goalsFor, matches),
    goalsAgainstAvg: finiteRate(item.goalsAgainst, matches),
    avgTotalGoals: finiteRate(Number(item.goalsFor || 0) + Number(item.goalsAgainst || 0), matches),
    overRates: item.overRates || Object.fromEntries(Object.entries(item.over || {}).map(([line, count]) => [line, finiteRate(count, matches)])),
    source: "current-season league results"
  };
}

function buildPreMatchMatchupContext(homeProfile, awayProfile, homeName, awayName) {
  const homeOverall = profileSide(homeProfile, "home", "home");
  const awayOverall = profileSide(awayProfile, "away", "away");
  const homeAway = homeProfile?.homeAway?.home;
  const awayAway = awayProfile?.homeAway?.away;
  const homeAttack = homeOverall.goalsForAvg;
  const awayDefence = awayOverall.goalsAgainstAvg;
  const awayAttack = awayOverall.goalsForAvg;
  const homeDefence = homeOverall.goalsAgainstAvg;
  const expectedHomeGoals = homeAttack != null && awayDefence != null
    ? Number(((homeAttack + awayDefence) / 2).toFixed(2)) : null;
  const expectedAwayGoals = awayAttack != null && homeDefence != null
    ? Number(((awayAttack + homeDefence) / 2).toFixed(2)) : null;
  const headToHead = findHeadToHead(homeProfile, awayProfile, homeName, awayName);
  return {
    source: "ESPN public scoreboard",
    season: homeProfile?.season || awayProfile?.season || null,
    home: {
      team: String(homeName || ""),
      sample: Number(homeProfile?.matches || 0),
      homeSample: Number(homeAway?.matches || 0),
      goalsForAvg: homeOverall.goalsForAvg,
      goalsAgainstAvg: homeOverall.goalsAgainstAvg,
      cleanSheetRate: homeOverall.cleanSheetRate,
      failedToScoreRate: homeOverall.failedToScoreRate,
      overRates: homeOverall.overRates,
      metricSource: homeOverall.source
    },
    away: {
      team: String(awayName || ""),
      sample: Number(awayProfile?.matches || 0),
      awaySample: Number(awayAway?.matches || 0),
      goalsForAvg: awayOverall.goalsForAvg,
      goalsAgainstAvg: awayOverall.goalsAgainstAvg,
      cleanSheetRate: awayOverall.cleanSheetRate,
      failedToScoreRate: awayOverall.failedToScoreRate,
      overRates: awayOverall.overRates,
      metricSource: awayOverall.source
    },
    expectedGoals: {
      home: expectedHomeGoals,
      away: expectedAwayGoals,
      total: expectedHomeGoals != null && expectedAwayGoals != null
        ? Number((expectedHomeGoals + expectedAwayGoals).toFixed(2)) : null,
      method: "simple average of each team's scoring average and opponent goals-conceded average; heuristic, not calibrated"
    },
    headToHead
  };
}

module.exports = { normalizeTeamKey, seasonBoundsForLeague, buildPreMatchMatchupContext };
