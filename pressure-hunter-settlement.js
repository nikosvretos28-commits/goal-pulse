"use strict";

// Full-time settlement for the autonomous Pressure Hunter history.
// The signal is confirmed only if the match total increases after the signal snapshot.
function finiteScore(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function settlePressureHunterRecord(record = {}, fixture = {}, settledAt = Date.now()) {
  const result = fixture.result || fixture;
  const signalHome = finiteScore(record.scoreAtSignal?.home);
  const signalAway = finiteScore(record.scoreAtSignal?.away);
  const finalHome = finiteScore(result.homeScore);
  const finalAway = finiteScore(result.awayScore);
  const minute = finiteScore(record.minuteNumber);
  const period = String(record.periodAtSignal || (minute !== null && minute <= 45 ? "first_half" : minute !== null && minute > 45 ? "second_half" : "")).toLowerCase();
  const firstHalf = period === "first_half" || period === "1h" || period === "first";
  const targetHome = firstHalf ? finiteScore(result.halfTimeHomeScore) : finalHome;
  const targetAway = firstHalf ? finiteScore(result.halfTimeAwayScore) : finalAway;
  const provider = String(result.settlementProvider || "").trim();
  const fixtureId = String(result.settlementFixtureId || "").trim();
  const status = String(result.status || "").trim().toLowerCase();
  const statusText = String(result.statusText || "").trim().toLowerCase();
  const finished = status === "post" || status === "finished" || (!status && /finished|full.?time|ended|final|\bft\b/.test(statusText));

  // Fail closed: no inferred baseline, no unverified score, no ambiguous live result.
  if (signalHome === null || signalAway === null || finalHome === null || finalAway === null ||
      targetHome === null || targetAway === null || (!firstHalf && period !== "second_half" && period !== "2h" && period !== "second") ||
      !provider || !fixtureId || !finished) return null;

  const goalsAfterSignal = (targetHome + targetAway) - (signalHome + signalAway);
  // A lower final total indicates a score correction or mismatched data; do not grade it.
  if (goalsAfterSignal < 0) return null;

  const confirmed = goalsAfterSignal > 0;
  return {
    ...record,
    outcome: confirmed
      ? "Επιβεβαιώθηκε · μπήκε γκολ μετά το σήμα"
      : "Δεν επιβεβαιώθηκε · δεν μπήκε γκολ μετά το σήμα",
    outcomeStatus: confirmed ? "confirmed" : "not_confirmed",
    goalsAfterSignal,
    finalScore: finalHome + "-" + finalAway,
    evaluationPeriod: firstHalf ? "first_half" : "second_half",
    evaluationScore: targetHome + "-" + targetAway,
    settlementRule: firstHalf ? "goal_after_signal_until_half_time" : "goal_after_signal_until_full_time",
    settlementProvider: provider,
    settlementFixtureId: fixtureId,
    settlementFixtureDate: result.settlementFixtureDate || null,
    settlementLeague: result.settlementLeague || record.league || null,
    settledAt
  };
}

module.exports = { settlePressureHunterRecord };
