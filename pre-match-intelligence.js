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
  return numerator != null && Number.isFinite(Number(numerator)) && Number(denominator) > 0
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
  if (!direct && !reverse) return { available: false, sample: 0 };
  const item = direct || reverse;
  if (Number(item.matches || 0) < 1) return { available: false, sample: 0 };
  const matches = Number(item.matches || 0);
  const goalsFor = Number(reverse && !direct ? item.goalsAgainst || 0 : item.goalsFor || 0);
  const goalsAgainst = Number(reverse && !direct ? item.goalsFor || 0 : item.goalsAgainst || 0);
  const wins = Number(reverse && !direct ? item.losses || 0 : item.wins || 0);
  const losses = Number(reverse && !direct ? item.wins || 0 : item.losses || 0);
  return {
    available: true,
    sample: matches,
    wins,
    draws: Number(item.draws || 0),
    losses,
    goalsFor,
    goalsAgainst,
    goalsForAvg: finiteRate(goalsFor, matches),
    goalsAgainstAvg: finiteRate(goalsAgainst, matches),
    avgTotalGoals: finiteRate(goalsFor + goalsAgainst, matches),
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
      sample: homeOverall.sample,
      seasonSample: Number(homeProfile?.matches || 0),
      homeSample: Number(homeAway?.matches || 0),
      goalsForAvg: homeOverall.goalsForAvg,
      goalsAgainstAvg: homeOverall.goalsAgainstAvg,
      cleanSheetRate: homeOverall.cleanSheetRate,
      failedToScoreRate: homeOverall.failedToScoreRate,
      overRates: homeOverall.overRates,
      leagueOverRates: homeProfile?.leagueOverRates || {},
      metricSource: homeOverall.source
    },
    away: {
      team: String(awayName || ""),
      sample: awayOverall.sample,
      seasonSample: Number(awayProfile?.matches || 0),
      awaySample: Number(awayAway?.matches || 0),
      goalsForAvg: awayOverall.goalsForAvg,
      goalsAgainstAvg: awayOverall.goalsAgainstAvg,
      cleanSheetRate: awayOverall.cleanSheetRate,
      failedToScoreRate: awayOverall.failedToScoreRate,
      overRates: awayOverall.overRates,
      leagueOverRates: awayProfile?.leagueOverRates || {},
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


function scorePreMatchMatchupContext(context) {
  const reasons = [];
  let raw = 0;
  const add = (condition, points, label) => {
    if (condition) { raw += points; reasons.push(label); }
  };
  const expectedTotal = Number(context?.expectedGoals?.total);
  if (context?.expectedGoals?.total != null && Number.isFinite(expectedTotal)) {
    add(expectedTotal >= 3.25, 0.75, "Season expected goals high (+0.75)");
    add(expectedTotal >= 2.75 && expectedTotal < 3.25, 0.5, "Season expected goals positive (+0.5)");
    add(expectedTotal <= 1.75, -0.75, "Season expected goals low (-0.75)");
    add(expectedTotal > 1.75 && expectedTotal <= 2.1, -0.5, "Season expected goals cautious (-0.5)");
  }
  const home = context?.home || {};
  const away = context?.away || {};
  const usableOver25 = [home, away].filter(team => Number(team.sample || 0) >= 5 && team.overRates?.["2.5"] != null);
  if (usableOver25.length) {
    const rate = usableOver25.reduce((sum, team) => sum + Number(team.overRates["2.5"]), 0) / usableOver25.length;
    add(rate >= 0.65, 0.4, "Season Over 2.5 frequency strong (+0.4)");
    add(rate <= 0.35, -0.4, "Season Over 2.5 frequency low (-0.4)");
  }
  const usableOver35 = [home, away].filter(team => Number(team.sample || 0) >= 5 && team.overRates?.["3.5"] != null);
  if (usableOver35.length) {
    const rate = usableOver35.reduce((sum, team) => sum + Number(team.overRates["3.5"]), 0) / usableOver35.length;
    add(rate >= 0.55, 0.3, "Season Over 3.5 frequency strong (+0.3)");
    add(rate <= 0.2, -0.3, "Season Over 3.5 frequency low (-0.3)");
  }
  const defensiveRates = [home.cleanSheetRate, away.cleanSheetRate].filter(value => value != null && Number.isFinite(Number(value)));
  if (defensiveRates.length === 2) {
    const rate = defensiveRates.reduce((sum, value) => sum + Number(value), 0) / 2;
    add(rate >= 0.45, -0.35, "Both teams' clean-sheet rates strong (-0.35)");
    add(rate <= 0.15, 0.25, "Both teams' clean-sheet rates low (+0.25)");
  }
  const failedRates = [home.failedToScoreRate, away.failedToScoreRate].filter(value => value != null && Number.isFinite(Number(value)));
  if (failedRates.length === 2) {
    const rate = failedRates.reduce((sum, value) => sum + Number(value), 0) / 2;
    add(rate >= 0.35, -0.35, "Both teams' failed-to-score rates high (-0.35)");
    add(rate <= 0.1, 0.2, "Both teams' failed-to-score rates low (+0.2)");
  }
  const h2h = context?.headToHead;
  if (h2h?.available && Number(h2h.sample) >= 3 && h2h.avgTotalGoals != null) {
    add(Number(h2h.avgTotalGoals) >= 3, 0.3, "Head-to-head goal average high (+0.3)");
    add(Number(h2h.avgTotalGoals) <= 1.5, -0.3, "Head-to-head goal average low (-0.3)");
  }
  const score = Math.max(-1.5, Math.min(1.5, Number(raw.toFixed(2))));
  return { score, rawScore: Number(raw.toFixed(2)), reasons, cap: 1.5 };
}

module.exports = { normalizeTeamKey, seasonBoundsForLeague, buildPreMatchMatchupContext, scorePreMatchMatchupContext };
