"use strict";

// Autonomous Pressure Hunter. Deliberately has no imports from, or writes to,
// AI Alerts, VIP Alerts, Hi Activity, Power Games, or their history stores.

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function readTeamStat(team, ...keys) {
  for (const key of keys) {
    const n = numberOrNull(team?.[key]);
    if (n !== null) return n;
  }
  return null;
}

function readWindow(window, minSample, maxSample) {
  const sampleMinutes = Number(window?.sampleMinutes);
  if (window?.available !== true || !Number.isFinite(sampleMinutes) ||
      sampleMinutes < minSample || sampleMinutes > maxSample ||
      !Array.isArray(window.teams) || window.teams.length !== 2) return null;

  const teams = window.teams.map(team => ({
    sot: readTeamStat(team, "shotsOnTarget", "shots_on_target", "sot"),
    shotsInBox: readTeamStat(team, "shotsInBox", "shots_in_box", "shotsInsideBox"),
    bigChances: readTeamStat(team, "bigChances", "big_chances")
  }));
  if (teams.some(team => team.sot === null)) return null;
  return { teams, sampleMinutes };
}

function liveMinuteEligible(minute, status = "") {
  const m = Number(minute);
  if (!Number.isFinite(m) || m < 1 || m > 130) return false;
  const s = String(status).trim().toLowerCase();
  return !/finished|full.?time|ended|completed|\bft\b|\baet\b|\bht\b|half.?time|halftime|interval|postponed|cancelled|abandoned|ολοκληρώθηκε|ανάπαυλα/.test(s);
}

function sum(values) {
  return values.every(value => value !== null) ? values.reduce((a, b) => a + b, 0) : null;
}

function evaluatePressureHunter({ minute, status, teams, windows } = {}) {
  const rejected = reason => ({ eligible: false, triggered: false, level: null, score: 0, reason, evidence: null });
  if (!liveMinuteEligible(minute, status)) return rejected("match_not_live");
  if (!Array.isArray(teams) || teams.length !== 2) return rejected("two_teams_required");

  const cumulativeSot = teams.map(team => readTeamStat(team, "shotsOnTarget", "shots_on_target", "sot"));
  if (cumulativeSot.some(value => value === null)) return rejected("cumulative_sot_unavailable");

  const five = readWindow(windows?.last5m, 4.5, 8);
  const ten = readWindow(windows?.last10m, 8, 13);
  if (!five || !ten) return rejected("valid_5m_and_10m_windows_required");

  const totalSot = sum(cumulativeSot);
  const basic = ten.teams.every(team => team.sot >= 2) &&
    five.teams.every(team => team.sot >= 1) && totalSot >= 4;
  const extreme = ten.teams.every(team => team.sot >= 3) &&
    five.teams.every(team => team.sot >= 2) && totalSot >= 8;

  // Supporting metrics increase the score only. They never trigger an alert.
  const boxTotal = sum(ten.teams.map(team => team.shotsInBox));
  const bigChanceTotal = sum(ten.teams.map(team => team.bigChances));
  const sot5Total = sum(five.teams.map(team => team.sot));
  const sot10Total = sum(ten.teams.map(team => team.sot));
  const score = Math.min(15,
    Math.min(6, sot5Total * 0.75) +
    Math.min(5, sot10Total * 0.5) +
    Math.min(2, (boxTotal ?? 0) * 0.5) +
    Math.min(2, (bigChanceTotal ?? 0) * 1)
  );

  return {
    eligible: true,
    triggered: basic,
    level: extreme ? "EXTREME" : basic ? "DUAL_PRESSURE" : null,
    score: Math.round(score * 10) / 10,
    reason: extreme ? "extreme_dual_team_pressure" : basic ? "dual_team_pressure" : "thresholds_not_met",
    evidence: {
      cumulativeSot: { home: cumulativeSot[0], away: cumulativeSot[1], total: totalSot },
      last5mSot: { home: five.teams[0].sot, away: five.teams[1].sot },
      last10mSot: { home: ten.teams[0].sot, away: ten.teams[1].sot },
      last10mShotsInBox: boxTotal,
      last10mBigChances: bigChanceTotal
    }
  };
}

module.exports = { evaluatePressureHunter, liveMinuteEligible };
