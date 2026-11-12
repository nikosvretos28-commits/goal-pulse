"use strict";

function readFiniteNonNegative(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return Math.max(0, number);
  }
  return null;
}

function teamSot(team) {
  return readFiniteNonNegative(team?.shotsOnTarget, team?.shots_on_target, team?.shots_on_goal, team?.shotsOnGoal, team?.onTargetShots);
}
function teamDangerousAttacks(team) {
  return readFiniteNonNegative(team?.dangerousAttacks, team?.dangerous_attacks, team?.dangerousAttack);
}
function teamAttacks(team) {
  return readFiniteNonNegative(team?.attacks, team?.totalAttacks, team?.total_attacks);
}
function teamXg(team) {
  return readFiniteNonNegative(team?.xG, team?.xg, team?.expectedGoals);
}

function totalForTwoTeams(teams, getter) {
  if (!Array.isArray(teams) || teams.length !== 2) return null;
  const values = teams.map(getter);
  return values.every(value => value !== null) ? values[0] + values[1] : null;
}

function windowTotal(window, getter, minMinutes, maxMinutes) {
  const age = Number(window?.sampleMinutes);
  if (!window?.available || !Array.isArray(window.teams) || window.teams.length < 2 ||
      !Number.isFinite(age) || age < minMinutes || age > maxMinutes) return null;
  const values = window.teams.slice(0, 2).map(getter);
  return values.every(value => value !== null) ? values[0] + values[1] : null;
}

// Keep this formula byte-for-byte aligned with renderAllLivePowerRanking() in index.html.
function calculatePowerRankingScore({ teams, trend } = {}) {
  const totalSot = totalForTwoTeams(teams, teamSot);
  const totalXg = totalForTwoTeams(teams, teamXg);
  const sot5 = windowTotal(trend?.window5m, teamSot, 4.5, 8);
  const sot10 = windowTotal(trend?.window10m, teamSot, 8, 13);
  const dangerous10 = windowTotal(trend?.window10m, teamDangerousAttacks, 8, 13);
  const attacks10 = windowTotal(trend?.window10m, teamAttacks, 8, 13);
  const score = Math.round(
    Math.min(25, (totalSot || 0) * 2.5) +
    Math.min(15, (sot5 || 0) * 5) +
    Math.min(10, (sot10 || 0) * 2) +
    Math.min(24, (totalXg || 0) * 6) +
    Math.min(15, (dangerous10 || 0)) +
    Math.min(10, (attacks10 || 0) * 0.25)
  );
  return Math.max(0, Math.min(100, score));
}

function isPowerRankingMinuteEligible(minute, status = "") {
  if (!Number.isInteger(minute)) return false;
  const period = String(status || "").trim().toLowerCase();
  if (/\b(?:finished|full[\s_-]*time|ended|complete|completed|ft|aet|ht|half[\s_-]*time|halftime|interval)\b/.test(period) ||
      /ολοκληρώθηκε|τελικό\s*σφύριγμα|λήξη\s*αγώνα|ανάπαυλα/.test(period)) return false;
  const explicitlyFirstHalf = /\b(?:1h|1st[\s_-]*half|first[\s_-]*half|first_half)\b/.test(period) ||
    /1ο\s*ημίχρονο|πρώτο\s*ημίχρονο/.test(period);
  const explicitlySecondHalf = /\b(?:2h|2nd[\s_-]*half|second[\s_-]*half|second_half)\b/.test(period) ||
    /2ο\s*ημίχρονο|δεύτερο\s*ημίχρονο/.test(period);
  if (minute >= 1 && minute <= 34) return !explicitlySecondHalf;
  if (minute >= 46 && minute <= 84) return !explicitlyFirstHalf;
  return false;
}
const AUTONOMOUS_POWER_RANKING_THRESHOLD = 65;

function shouldEmitAutonomousPowerRankingAlert({ score, eligible } = {}) {
  const numericScore = Number(score);
  // The autonomous trigger depends on the live Power Ranking score and its
  // minute/period eligibility only. Match scoreboard goals are not a trigger gate.
  return eligible === true && Number.isFinite(numericScore) &&
    numericScore > AUTONOMOUS_POWER_RANKING_THRESHOLD;
}

module.exports = {
  calculatePowerRankingScore,
  isPowerRankingMinuteEligible,
  AUTONOMOUS_POWER_RANKING_THRESHOLD,
  shouldEmitAutonomousPowerRankingAlert
};
