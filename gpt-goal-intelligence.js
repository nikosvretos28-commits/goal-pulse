"use strict";

// GPT Goal Intelligence: independent SOT-only live goal-threat evaluator.
// No clock-window eligibility cutoff: any live minute from 1 through extra time is eligible.
function count(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
function liveEligible(minute, status = "") {
  const m = Number(minute);
  if (!Number.isFinite(m) || m < 1 || m > 130) return false;
  const s = String(status).trim().toLowerCase();
  return !/finished|full.?time|ended|completed|\\bft\\b|\\bpen\\b|shoot.?out|postponed|cancelled|abandoned|ολοκληρώθηκε/.test(s);
}
function readWindow(window, expectedMin, expectedMax) {
  if (!window || window.available !== true) return null;
  const age = Number(window.sampleMinutes);
  if (!Number.isFinite(age) || age < expectedMin || age > expectedMax ||
      !Array.isArray(window.teams) || window.teams.length !== 2) return null;
  const values = window.teams.map(team => count(team?.shotsOnTarget));
  return values.some(v => v === null) ? null : values;
}
function evaluateGptGoalIntelligence({ minute, status, teams, window5m, window10m, preScanContext } = {}) {
  const reject = reason => ({ eligible: false, triggered: false, level: null, score: 0, reason, triggers: [], evidence: null });
  if (!liveEligible(minute, status)) return reject("match_not_live_or_minute_out_of_range");
  if (!Array.isArray(teams) || teams.length !== 2) return reject("two_teams_required");
  const cumulative = teams.map(t => count(t?.shotsOnTarget));
  if (cumulative.some(v => v === null)) return reject("complete_cumulative_sot_required");
  const w5 = readWindow(window5m, 4, 7);
  const w10 = readWindow(window10m, 8, 12);
  const total = cumulative[0] + cumulative[1];
  const total5 = w5 ? w5[0] + w5[1] : null;
  const total10 = w10 ? w10[0] + w10[1] : null;
  const triggers = [];
  if (total5 !== null && total5 >= 3) triggers.push({ id: "EXPLOSIVE_5M", points: 4, detail: total5 + " SOT / ~5m" });
  if (total10 !== null && total10 >= 4) triggers.push({ id: "SUSTAINED_PRESSURE_10M", points: 3, detail: total10 + " SOT / ~10m" });
  if (total10 !== null && cumulative.some(v => v >= 6) && Math.max(...w10) >= 2) {
    triggers.push({ id: "TEAM_DOMINANCE_10M", points: 3, detail: "6+ cumulative SOT and 2+ recent SOT by one side" });
  }
  if (total10 !== null && cumulative.every(v => v >= 4) && w10.every(v => v >= 1) && total10 >= 2) {
    triggers.push({ id: "TWO_SIDED_THREAT", points: 3, detail: "both sides have 4+ cumulative SOT and recent threat" });
  }
  if (total5 !== null && total10 !== null && total5 >= 2 && total10 >= 4) {
    triggers.push({ id: "CONTINUOUS_THREAT", points: 2, detail: "SOT activity sustained across short and medium windows" });
  }
  const points = triggers.reduce((sum, item) => sum + item.points, 0);
  const score = Math.min(10, points + (total >= 8 ? 1 : 0) + (total >= 12 ? 1 : 0));
  const triggered = triggers.length > 0 && score >= 4;
  const level = !triggered ? null : score >= 8 ? "ELITE" : score >= 6 ? "STRONG" : "ACTIVE";
  return {
    eligible: true, triggered, level, score,
    reason: triggered ? triggers.map(t => t.id).join("+") : "no_sot_trigger_met",
    triggers: triggers.map(t => t.id),
    evidence: { cumulativeSot: { home: cumulative[0], away: cumulative[1], total },
      rolling5m: w5 ? { home: w5[0], away: w5[1], total: total5 } : null,
      rolling10m: w10 ? { home: w10[0], away: w10[1], total: total10 } : null },
    // Pre-Scan is attached as auditable context only; it never changes trigger gates or score.
    preScanContext: preScanContext && typeof preScanContext === "object" ? preScanContext : null
  };
}
module.exports = { evaluateGptGoalIntelligence, liveEligible };
