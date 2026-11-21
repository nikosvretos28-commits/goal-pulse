"use strict";

// Independent GOALMATRIX LIVE INTELLIGENCE analysis layer.
// Provider adapters must normalize values into this shape before calling this module.
// Missing/stale coverage is never converted to zero. This module does not share
// activation state, thresholds, or delivery paths with AI/VIP/HI/Matrix/Cloud alerts.

const METRICS = Object.freeze([
  "shotsOnTarget", "xg", "psxg", "bigChances", "boxEntries",
  "dangerousAttacks", "finalThirdEntries", "progressivePasses",
  "keyPasses", "matchMomentum", "defensivePressures", "pressureRecoveries",
  "score", "minute", "numericalAdvantage"
]);

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function readMetric(input, sourceFallback = null) {
  if (!input || typeof input !== "object" || input.available !== true) {
    return { status: "unavailable", value: null, source: input?.source || sourceFallback || null, updatedAt: input?.updatedAt || null };
  }
  const value = finiteNonNegative(input.value);
  if (value === null) {
    return { status: "unavailable", value: null, source: input.source || sourceFallback || null, updatedAt: input.updatedAt || null };
  }
  const stale = input.stale === true;
  return {
    status: stale ? "pending" : "available",
    value: stale ? null : value,
    observedValue: value,
    source: input.source || sourceFallback || null,
    updatedAt: input.updatedAt || null
  };
}

function readTeamWindow(team, source) {
  const result = {};
  for (const metric of METRICS) result[metric] = readMetric(team?.[metric], source);
  return result;
}

function compareMetric(home, away) {
  if (home.status !== "available" || away.status !== "available") {
    return { status: home.status === "pending" || away.status === "pending" ? "pending" : "unavailable", leader: null, home: home.value, away: away.value, difference: null };
  }
  const difference = home.value - away.value;
  return { status: "available", leader: difference > 0 ? "home" : difference < 0 ? "away" : "level", home: home.value, away: away.value, difference };
}

function deriveMomentum(comparisons) {
  const signals = ["boxEntries", "shotsOnTarget", "xg"].map(metric => comparisons[metric]);
  if (signals.some(signal => signal.status !== "available")) return { status: "unavailable", leader: null, label: "Αναμένεται ενημέρωση" };
  const leaders = signals.map(signal => signal.leader);
  if (leaders.every(leader => leader === "home")) return { status: "available", leader: "home", label: "Επιθετικό πάνω χέρι: γηπεδούχοι" };
  if (leaders.every(leader => leader === "away")) return { status: "available", leader: "away", label: "Επιθετικό πάνω χέρι: φιλοξενούμενοι" };
  return { status: "neutral", leader: null, label: "Ουδέτερη εικόνα — οι δείκτες διαφωνούν ή είναι ισόπαλοι" };
}

function summarizeWindow(window, source) {
  const teams = {
    home: readTeamWindow(window?.home, source),
    away: readTeamWindow(window?.away, source)
  };
  const comparisons = {};
  for (const metric of METRICS) comparisons[metric] = compareMetric(teams.home[metric], teams.away[metric]);
  const xgDifference = comparisons.xg.status === "available" ? comparisons.xg.difference : null;
  const momentum = deriveMomentum(comparisons);
  const matchSot = teams.home.shotsOnTarget.status === "available" && teams.away.shotsOnTarget.status === "available"
    ? teams.home.shotsOnTarget.value + teams.away.shotsOnTarget.value : null;
  return { teams, comparisons, xgDifference, matchSot, momentum };
}

function classifyPressure(last5, last10) {
  const entries5 = last5.comparisons.boxEntries;
  const sot5 = last5.comparisons.shotsOnTarget;
  const xg5 = last5.comparisons.xg;
  if ([entries5, sot5, xg5].some(x => x.status !== "available")) {
    return { status: "insufficient_data", label: "Αναμένεται ενημέρωση", team: null };
  }
  const entryLeader = entries5.leader;
  if (entryLeader === "level" || entryLeader === null) {
    return { status: "balanced_or_unclear", label: "Δεν προκύπτει σαφής υπεροχή", team: null };
  }
  const sameTeamSot = sot5.leader === entryLeader && sot5.home !== sot5.away;
  const sameTeamXg = xg5.leader === entryLeader && xg5.home !== xg5.away;
  if (sot5.leader === "level" && xg5.leader !== entryLeader) {
    return { status: "mixed", label: "Η πίεση δεν μεταφράζεται καθαρά σε ευκαιρίες", team: null };
  }
  if (sot5.leader !== entryLeader && xg5.leader !== entryLeader) {
    return { status: "mixed", label: "Οι δείκτες ευκαιριών δείχνουν διαφορετική εικόνα", team: null };
  }
  if (sot5.leader === "level" && xg5.leader === "level") {
    return { status: "box_entry_pressure_without_sot_or_xg_edge", label: "Περισσότερες είσοδοι στην περιοχή χωρίς υπεροχή σε SOT ή xG", team: entryLeader };
  }
  const stableMetrics = ["boxEntries", "shotsOnTarget", "xg"];
  const stable10 = stableMetrics.every(metric => last10.comparisons[metric].status === "available" &&
    last10.comparisons[metric].leader === entryLeader);
  if (sameTeamSot && sameTeamXg && stable10) {
    return { status: "sustained_attacking_superiority", label: "Σταθερή επιθετική υπεροχή στο τελευταίο 10λεπτο", team: entryLeader };
  }
  return { status: "pressure_with_some_chances", label: "Επιθετική πίεση με ενδείξεις δημιουργίας ευκαιριών", team: entryLeader };
}

function buildGameState(input) {
  const scoreHome = finiteNonNegative(input?.score?.home);
  const scoreAway = finiteNonNegative(input?.score?.away);
  const minute = finiteNonNegative(input?.minute);
  const period = input?.period || null;
  const redCardsHome = finiteNonNegative(input?.redCards?.home);
  const redCardsAway = finiteNonNegative(input?.redCards?.away);
  const complete = scoreHome !== null && scoreAway !== null;
  return {
    status: complete ? "available" : "unavailable",
    score: complete ? { home: scoreHome, away: scoreAway } : null,
    minute,
    period,
    leader: !complete ? null : scoreHome > scoreAway ? "home" : scoreAway > scoreHome ? "away" : "level",
    numericalAdvantage: redCardsHome !== null && redCardsAway !== null
      ? (redCardsHome > redCardsAway ? "away" : redCardsAway > redCardsHome ? "home" : "level")
      : null,
    redCards: { home: redCardsHome, away: redCardsAway }
  };
}

function describeGameStateChanges(events, windowStartSeconds = null) {
  if (!Array.isArray(events)) return [];
  return events
    .filter(event => event && ["goal", "red_card", "score_correction"].includes(event.type) &&
      event.timestampSeconds !== null && event.timestampSeconds !== undefined &&
      Number.isFinite(Number(event.timestampSeconds)) &&
      (windowStartSeconds === null || Number(event.timestampSeconds) >= windowStartSeconds))
    .sort((a, b) => Number(a.timestampSeconds) - Number(b.timestampSeconds))
    .map(event => ({
      type: event.type,
      team: event.team === "home" || event.team === "away" ? event.team : null,
      timestampSeconds: Number(event.timestampSeconds),
      minute: event.minute ?? null,
      confirmed: event.confirmed === true,
      description: event.confirmed === true ? (event.description || event.type) : "Αναμένεται επιβεβαίωση"
    }));
}


function buildShotDerivedWindow(events, { nowSeconds, durationSeconds = null, coverage = {} } = {}) {
  const empty = () => ({
    available: coverage.available === true,
    home: { shotsOnTarget: null, xg: null, psxg: null, bigChances: null },
    away: { shotsOnTarget: null, xg: null, psxg: null, bigChances: null }
  });
  const result = empty();
  if (coverage.available !== true || !Number.isFinite(Number(nowSeconds)) || !Array.isArray(events)) return result;
  const start = durationSeconds === null ? -Infinity : Number(nowSeconds) - Number(durationSeconds);
  const relevant = events.filter(event => event && event.timestampSeconds !== null && event.timestampSeconds !== undefined && Number.isFinite(Number(event.timestampSeconds)) &&
    Number(event.timestampSeconds) <= Number(nowSeconds) && Number(event.timestampSeconds) >= start &&
    (event.team === "home" || event.team === "away") && event.type === "shot");
  for (const side of ["home", "away"]) {
    const shots = relevant.filter(event => event.team === side);
    const onTarget = shots.filter(event => event.onTarget === true);
    const xgValues = shots.map(event => finiteNonNegative(event.xg));
    const psxgValues = onTarget.map(event => finiteNonNegative(event.psxg));
    result[side] = {
      shotsOnTarget: onTarget.length,
      xg: xgValues.every(value => value !== null) ? xgValues.reduce((sum, value) => sum + value, 0) : null,
      psxg: psxgValues.every(value => value !== null) ? psxgValues.reduce((sum, value) => sum + value, 0) : null,
      bigChances: null
    };
  }
  return result;
}


function normalizePitchApiShotEvents(shotPeriods, { homeTeamId, awayTeamId, source = "PitchAPI" } = {}) {
  const periods = Array.isArray(shotPeriods) ? shotPeriods : [];
  const allPeriods = periods.filter(period => !period?.period || String(period.period).trim().toLowerCase() === "all");
  const selected = allPeriods.length ? allPeriods : periods;
  const rows = selected.flatMap(period => Array.isArray(period?.shots) ? period.shots : []);
  const idToSide = new Map();
  if (homeTeamId != null) idToSide.set(String(homeTeamId), "home");
  if (awayTeamId != null) idToSide.set(String(awayTeamId), "away");
  return rows.flatMap((shot, index) => {
    const team = idToSide.get(String(shot?.team_id ?? ""));
    if (!team) return [];
    const minute = finiteNonNegative(shot.minute);
    const addedMinute = finiteNonNegative(shot.minute_added);
    const xg = finiteNonNegative(shot.expected_goals);
    const psxg = finiteNonNegative(shot.expected_goals_on_target);
    return [{
      id: shot.id != null ? String(shot.id) : String(index),
      type: "shot",
      team,
      onTarget: shot?.is_on_target === true,
      minute: minute === null ? null : Math.floor(minute),
      minuteAdded: addedMinute === null ? null : Math.floor(addedMinute),
      xg,
      psxg,
      source,
      timePrecision: "match-minute",
      timestampSeconds: null
    }];
  });
}

function summarizeShotEventTotals(events) {
  const result = {
    home: { shotsOnTarget: null, xg: null, psxg: null, bigChances: null },
    away: { shotsOnTarget: null, xg: null, psxg: null, bigChances: null }
  };
  if (!Array.isArray(events) || events.length === 0) return result;
  for (const side of ["home", "away"]) {
    const shots = events.filter(event => event?.team === side && event?.type === "shot");
    const onTarget = shots.filter(event => event.onTarget === true);
    result[side].shotsOnTarget = onTarget.length;
    const xg = shots.map(event => finiteNonNegative(event.xg));
    const psxg = onTarget.map(event => finiteNonNegative(event.psxg));
    result[side].xg = xg.every(value => value !== null) ? xg.reduce((sum, value) => sum + value, 0) : null;
    result[side].psxg = psxg.every(value => value !== null) ? psxg.reduce((sum, value) => sum + value, 0) : null;
  }
  return result;
}

function buildLiveIntelligenceAnalysis(input = {}) {
  const source = input.source || null;
  const last5 = summarizeWindow(input.windows?.last5, source);
  const last10 = summarizeWindow(input.windows?.last10, source);
  const totals = summarizeWindow(input.totals, source);
  const pressure = classifyPressure(last5, last10);
  const state = buildGameState(input.gameState);
  const changes = describeGameStateChanges(input.events, input.windowStartSeconds);
  return {
    protocol: "GOALMATRIX LIVE INTELLIGENCE",
    independent: true,
    generatedAt: input.generatedAt || null,
    source,
    windows: { last5, last10, totals },
    pressure,
    gameState: state,
    recentGameStateChanges: changes,
    dataPolicy: { zeroMeansCoveredNoEvent: true, missingIsNeverZero: true },
    alertDelivery: "not_configured"
  };
}


function cleanLabel(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 100) : "";
}

function selectLiveIntelligenceTrigger(analysis) {
  if (!analysis || analysis.independent !== true) return null;
  const changes = Array.isArray(analysis.recentGameStateChanges) ? analysis.recentGameStateChanges : [];
  const confirmedShift = changes.find(event => event.confirmed === true && (event.type === "goal" || event.type === "red_card"));
  if (confirmedShift) {
    return {
      type: "game_state_shift",
      label: confirmedShift.type === "goal" ? "Αλλαγή εικόνας μετά από γκολ" : "Αλλαγή αριθμητικών ισορροπιών μετά από κόκκινη κάρτα",
      event: confirmedShift
    };
  }
  const pressure = analysis.pressure || {};
  if (pressure.status === "sustained_attacking_superiority") {
    return { type: pressure.status, label: pressure.label, team: pressure.team || null };
  }
  if (pressure.status === "box_entry_pressure_without_sot_or_xg_edge" ||
      pressure.status === "pressure_with_some_chances") {
    return { type: pressure.status, label: pressure.label, team: pressure.team || null };
  }
  return null;
}

function buildLiveIntelligencePushPayload({ analysis, match, triggeredAt = new Date().toISOString() } = {}) {
  const trigger = selectLiveIntelligenceTrigger(analysis);
  if (!trigger) return { ok: false, reason: "no_verified_trigger" };
  const home = cleanLabel(match?.home);
  const away = cleanLabel(match?.away);
  const league = cleanLabel(match?.league);
  const country = cleanLabel(match?.country);
  const minute = finiteNonNegative(match?.minute);
  const scoreHome = finiteNonNegative(match?.score?.home);
  const scoreAway = finiteNonNegative(match?.score?.away);
  if (!home || !away || !league || !country || minute === null ||
      scoreHome === null || scoreAway === null) {
    return { ok: false, reason: "incomplete_match_snapshot" };
  }
  const score = String(scoreHome) + "-" + String(scoreAway);
  const matchName = home + " – " + away;
  const pressureLine = trigger.label;
  const window = analysis.windows?.last10 || analysis.windows?.last5;
  const sot = window?.matchSot;
  const xg = window?.xgDifference;
  const details = [];
  if (Number.isFinite(sot)) details.push("SOT σύνολο: " + sot);
  if (Number.isFinite(xg)) details.push("Διαφορά xG: " + (xg > 0 ? "+" : "") + xg.toFixed(2));
  const body = [
    score + " · " + String(Math.floor(minute)) + "′ · " + league + " · " + country,
    matchName,
    pressureLine,
    details.join(" | ")
  ].filter(Boolean).join("\n");
  return {
    ok: true,
    channel: "live-intelligence",
    title: "GOALMATRIX · LIVE INTELLIGENCE",
    body,
    tag: "goalmatrix-live-intelligence-" + cleanLabel(match?.fixtureId || matchName).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 70),
    url: "/#liveIntelligencePanel",
    triggeredAt,
    snapshot: { score, minute: Math.floor(minute), league, country, home, away },
    trigger
  };
}

module.exports = { METRICS, readMetric, compareMetric, deriveMomentum, buildShotDerivedWindow, normalizePitchApiShotEvents, summarizeShotEventTotals, buildLiveIntelligenceAnalysis, describeGameStateChanges, selectLiveIntelligenceTrigger, buildLiveIntelligencePushPayload };
