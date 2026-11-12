"use strict";

// Autonomous Pressure Hunter. Deliberately isolated from every other alert protocol.
// It evaluates two consecutive 8-minute windows within the same half.
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function liveMinuteEligible(minute, status = "") {
  const m = Number(minute);
  if (!Number.isFinite(m) || m < 1 || m > 130) return false;
  const s = String(status).trim().toLowerCase();
  return !/finished|full.?time|ended|completed|\\bft\\b|\\baet\\b|\\bht\\b|half.?time|halftime|interval|postponed|cancelled|abandoned|ολοκληρώθηκε|ανάπαυλα/.test(s);
}

function sum(values) {
  return values.every(value => value !== null) ? values.reduce((a, b) => a + b, 0) : null;
}

function readEightMinuteWindow(window) {
  const sampleMinutes = Number(window?.sampleMinutes);
  if (window?.available !== true || !Number.isFinite(sampleMinutes) ||
      sampleMinutes < 6.5 || sampleMinutes > 9.5 ||
      !Array.isArray(window.teams) || window.teams.length !== 2) return null;

  const teams = window.teams.map(team => ({
    totalShots: numberOrNull(team?.totalShots),
    shotsOnTarget: numberOrNull(team?.shotsOnTarget),
    shotsOffTarget: numberOrNull(team?.shotsOffTarget)
  }));
  if (teams.some(team => team.totalShots === null || team.shotsOnTarget === null)) return null;
  return { teams, sampleMinutes };
}

function evaluatePressureHunter({ minute, status, teams, windows } = {}) {
  const rejected = reason => ({ eligible: false, triggered: false, level: null, score: 0, reason, evidence: null });
  if (!liveMinuteEligible(minute, status)) return rejected("match_not_live");
  if (!Array.isArray(teams) || teams.length !== 2) return rejected("two_teams_required");

  const first = readEightMinuteWindow(windows?.firstEightMinutes);
  const second = readEightMinuteWindow(windows?.secondEightMinutes);
  if (!first || !second) return rejected("two_valid_consecutive_8m_windows_required");

  const firstWindowShots = sum(first.teams.map(team => team.totalShots));
  const firstWindowSot = sum(first.teams.map(team => team.shotsOnTarget));
  const secondWindowShots = sum(second.teams.map(team => team.totalShots));
  if (firstWindowShots === null || firstWindowSot === null || secondWindowShots === null) {
    return rejected("hunter_shot_counts_unavailable");
  }

  // First 8-minute window must qualify fully. The alert fires on the first
  // observed shot in the immediately following 8-minute window.
  const firstWindowQualified = firstWindowShots >= 4 && firstWindowSot >= 2;
  const firstShotInSecondWindow = secondWindowShots >= 1;
  const triggered = firstWindowQualified && firstShotInSecondWindow;
  const score = Math.min(10, firstWindowShots * 0.5 + firstWindowSot);
  return {
    eligible: true,
    triggered,
    level: triggered ? "DUAL_PRESSURE" : null,
    score: Math.round(score * 10) / 10,
    reason: triggered ? "continuous_shot_flow_first_shot" : !firstWindowQualified ? "first_8m_thresholds_not_met" : "waiting_for_first_shot_in_second_8m",
    evidence: {
      firstEightMinutes: {
        totalShots: firstWindowShots,
        shotsOnTarget: firstWindowSot,
        home: first.teams[0],
        away: first.teams[1]
      },
      secondEightMinutes: {
        totalShotsAtSignal: secondWindowShots,
        shotsOnTarget: sum(second.teams.map(team => team.shotsOnTarget)),
        home: second.teams[0],
        away: second.teams[1],
        activation: "first_shot"
      }
    }
  };
}

module.exports = { evaluatePressureHunter, liveMinuteEligible };
