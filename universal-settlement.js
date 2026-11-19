"use strict";

const TERMINAL = new Set(["won", "lost", "push", "void"]);
const PROVIDERS = new Set(["sofascore", "nowgoal", "sportscore", "espn", "pitch", "user_supplied"]);

function clean(value, max = 240) {
  return String(value ?? "").trim().slice(0, max);
}
function score(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : null;
}
function isTerminal(value) {
  return TERMINAL.has(String(value || "").trim().toLowerCase());
}
function normalizeProvider(value) {
  const provider = clean(value, 40).toLowerCase();
  return PROVIDERS.has(provider) ? provider : null;
}
function validateEvidence(input = {}) {
  const provider = normalizeProvider(input.provider);
  const fixtureId = clean(input.fixtureId, 160);
  const home = clean(input.home, 160);
  const away = clean(input.away, 160);
  const date = clean(input.date, 10);
  const league = clean(input.league, 160);
  const sourceUrl = clean(input.sourceUrl, 1000);
  const finished = input.finished === true;
  const homeScore = score(input.homeScore);
  const awayScore = score(input.awayScore);
  const homeHtScore = score(input.homeHtScore);
  const awayHtScore = score(input.awayHtScore);
  if (!provider || !fixtureId || !home || !away || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !finished ||
      homeScore === null || awayScore === null) return { ok: false, reason: "incomplete_fixture_evidence" };
  if (provider !== "user_supplied" && !sourceUrl) return { ok: false, reason: "missing_source_url" };
  if (sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) return { ok: false, reason: "invalid_source_url" };
    } catch { return { ok: false, reason: "invalid_source_url" }; }
  }
  return { ok: true, evidence: {
    provider, fixtureId, home, away, date, league: league || null, sourceUrl: sourceUrl || null,
    finished, homeScore, awayScore, homeHtScore, awayHtScore,
    capturedAt: clean(input.capturedAt, 40) || new Date().toISOString()
  }};
}
function evaluationPeriod(record = {}) {
  const period = clean(record.periodAtSignal, 30).toLowerCase();
  if (period === "first_half" || period === "1h" || period === "first") return "first_half";
  if (period === "second_half" || period === "2h" || period === "second") return "full_time";
  return null;
}
function parseGoalMarket(market) {
  const text = clean(market, 160).toLowerCase();
  if (/corner|κόρνερ|cards?|κάρτες|shots?|σουτ/.test(text)) return null;
  const match = text.match(/\b(over|under)\s*(\d+(?:[.,]\d+)?)/i);
  if (!match) return null;
  const line = Number(match[2].replace(",", "."));
  // Quarter-goal Asian lines need split-stake grading and remain manual-review only.
  if (!Number.isFinite(line) || line < 0 || Math.round(line * 2) !== line * 2) return null;
  return { side: match[1].toLowerCase(), line };
}
function gradeGoalMarket(total, market) {
  const parsed = parseGoalMarket(market);
  if (!parsed || !Number.isInteger(total) || total < 0) return null;
  if (total === parsed.line && Number.isInteger(parsed.line)) return "push";
  const overWins = total > parsed.line;
  return (parsed.side === "over" ? overWins : !overWins) ? "won" : "lost";
}
function resolveAlertSettlement(record = {}, evidenceInput = {}, settledAt = new Date().toISOString()) {
  const checked = validateEvidence(evidenceInput);
  if (!checked.ok) return checked;
  const evidence = checked.evidence;
  const home = clean(record.home || record.homeTeam || record.homeTeamName, 160);
  const away = clean(record.away || record.awayTeam || record.awayTeamName, 160);
  if (!home || !away || home.toLowerCase() !== evidence.home.toLowerCase() || away.toLowerCase() !== evidence.away.toLowerCase()) {
    return { ok: false, reason: "fixture_identity_mismatch" };
  }
  const scope = evaluationPeriod(record);
  if (!scope) return { ok: false, reason: "unknown_signal_period" };
  const total = scope === "first_half"
    ? evidence.homeHtScore === null || evidence.awayHtScore === null ? null : evidence.homeHtScore + evidence.awayHtScore
    : evidence.homeScore + evidence.awayScore;
  if (total === null) return { ok: false, reason: "required_period_score_missing" };
  const outcome = gradeGoalMarket(total, record.market);
  if (!outcome) return { ok: false, reason: "unsupported_market" };
  return { ok: true, settlement: {
    outcome, evaluationPeriod: scope, evaluationScore: scope === "first_half"
      ? evidence.homeHtScore + "-" + evidence.awayHtScore
      : evidence.homeScore + "-" + evidence.awayScore,
    finalScore: evidence.homeScore + "-" + evidence.awayScore,
    settledAt, settlementMethod: "verified_manual",
    settlementEvidence: evidence
  }};
}
function resolveGoalAfterSignal(record = {}, evidenceInput = {}, settledAt = new Date().toISOString()) {
  const checked = validateEvidence(evidenceInput);
  if (!checked.ok) return checked;
  const evidence = checked.evidence;
  const home = clean(record.home || record.homeTeam || record.homeTeamName, 160);
  const away = clean(record.away || record.awayTeam || record.awayTeamName, 160);
  if (!home || !away || home.toLowerCase() !== evidence.home.toLowerCase() || away.toLowerCase() !== evidence.away.toLowerCase()) {
    return { ok: false, reason: "fixture_identity_mismatch" };
  }
  const scope = evaluationPeriod(record);
  if (!scope) return { ok: false, reason: "unknown_signal_period" };
  const signalHome = score(record.scoreAtSignal?.home);
  const signalAway = score(record.scoreAtSignal?.away);
  const endHome = scope === "first_half" ? evidence.homeHtScore : evidence.homeScore;
  const endAway = scope === "first_half" ? evidence.awayHtScore : evidence.awayScore;
  if (signalHome === null || signalAway === null || endHome === null || endAway === null) {
    return { ok: false, reason: "required_signal_or_period_score_missing" };
  }
  const goalsAfterSignal = endHome + endAway - signalHome - signalAway;
  if (goalsAfterSignal < 0) return { ok: false, reason: "score_regression" };
  return { ok: true, settlement: {
    outcome: goalsAfterSignal > 0 ? "confirmed" : "not_confirmed",
    goalsAfterSignal, evaluationPeriod: scope,
    evaluationScore: endHome + "-" + endAway,
    finalScore: evidence.homeScore + "-" + evidence.awayScore,
    settledAt, settlementMethod: "verified_manual",
    settlementEvidence: evidence
  }};
}
function isPendingRecord(record = {}, category = "alert") {
  const outcome = category === "alert" ? record.betOutcome : record.outcome;
  return !isTerminal(outcome) && !["confirmed", "not_confirmed"].includes(String(outcome || "").toLowerCase());
}

module.exports = {
  TERMINAL, score, isTerminal, normalizeProvider, validateEvidence, evaluationPeriod,
  parseGoalMarket, gradeGoalMarket, resolveAlertSettlement, resolveGoalAfterSignal, isPendingRecord
};
