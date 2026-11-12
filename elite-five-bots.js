"use strict";

const STAT_FIELDS = Object.freeze([
  "onTarget", "onTarget10m", "totalOnTarget", "xG", "xGDelta",
  "shotsOnTargetInsideBox", "bigChances", "corners", "attacks", "dangerousAttacks"
]);

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function dayKey(value, timeZone = "Europe/Athens") {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value;
  return part("year") + "-" + part("month") + "-" + part("day");
}
function normalizeRecord(row, source = "AI/VIP") {
  const p = row?.payload && typeof row.payload === "object" ? row.payload : {};
  const stats = p.statsAtSignal && typeof p.statsAtSignal === "object" ? p.statsAtSignal : {};
  const outcome = String(p.betOutcome || p.outcome || "pending").toLowerCase();
  const scoreScope = p.betScoreScope || p.scoreScope || null;
  const finalScore = p.betFinalScore || p.finalScore || null;
  const verified = ["won", "lost"].includes(outcome) &&
    Boolean(p.betSettlementProvider || p.settlementProvider) &&
    Boolean(p.betSettlementFixtureId || p.settlementFixtureId) &&
    ["first_half", "full_time"].includes(String(scoreScope || "")) &&
    /^\d+[-:]\d+$/.test(String(finalScore || "")) &&
    (scoreScope !== "first_half" || (Boolean(p.betHalfTimeScore || p.halfTimeScore) &&
      String(p.betHalfTimeScore || p.halfTimeScore) === String(finalScore)));
  const minuteValue = p.minuteNumber ?? p.minute;
  const minuteMatch = String(minuteValue ?? "").match(/[0-9]{1,3}/);
  const minute = minuteMatch ? Number(minuteMatch[0]) : null;
  const teams = [
    p.homeTeam || p.home || p.teams?.[0] || null,
    p.awayTeam || p.away || p.teams?.[1] || null
  ];
  const statsAtSignal = Object.fromEntries(STAT_FIELDS.map(key => [key, numberOrNull(stats[key])]));
  const goals = Array.isArray(p.goals) ? p.goals : Array.isArray(p.goalEvents) ? p.goalEvents : [];
  const goalMinutes = [
    ...(Array.isArray(p.goalMinutes) ? p.goalMinutes : []),
    ...goals.map(goal => goal?.minute ?? goal?.time?.elapsed ?? goal?.time ?? null)
  ].map(value => {
    const match = String(value ?? "").match(/[0-9]{1,3}/);
    return match ? Number(match[0]) : null;
  }).filter(Number.isInteger);
  return {
    alertId: row.alert_id || row.observation_id || p.alertId || null,
    eventId: String(row.event_id || p.eventId || p.fixtureId || ""),
    createdAt: row.created_at || p.createdAt || null,
    source,
    level: p.level || (source === "HI Activity" ? "HI" : "AI"),
    alertType: p.alertType || null,
    teams,
    league: p.league || p.competition || "Άγνωστη διοργάνωση",
    minute,
    period: p.periodAtSignal || p.period || "unknown",
    outcome,
    verified,
    finalScore,
    scoreScope,
    settlementProvider: p.betSettlementProvider || p.settlementProvider || null,
    triggerIds: Array.isArray(p.triggerIds) ? [...new Set(p.triggerIds.map(String))] : [],
    statsAtSignal,
    goalMinutes
  };
}
function summarize(rows) {
  const wins = rows.filter(row => row.verified && row.outcome === "won").length;
  const losses = rows.filter(row => row.verified && row.outcome === "lost").length;
  const pending = rows.filter(row => !["won", "lost", "push", "void"].includes(row.outcome)).length;
  const unverified = rows.filter(row => ["won", "lost"].includes(row.outcome) && !row.verified).length;
  const settled = wins + losses;
  return {
    alerts: rows.length, verifiedWins: wins, verifiedLosses: losses,
    verifiedSettled: settled,
    verifiedWinRatePct: settled ? Math.round(wins / settled * 1000) / 10 : null,
    pending, unverifiedSettlements: unverified,
    pushes: rows.filter(row => row.outcome === "push").length,
    voids: rows.filter(row => row.outcome === "void").length
  };
}
function groupedOutcomes(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(keyFn(row) || "Άγνωστο");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([name, group]) => ({ name, ...summarize(group) }))
    .sort((a, b) => b.alerts - a.alerts || a.name.localeCompare(b.name));
}
function buildFiveBotDailyReport(input = {}) {
  const date = String(input.date || "");
  const alerts = (Array.isArray(input.alerts) ? input.alerts : []).map(row => normalizeRecord(row, "AI/VIP"));
  const hiActivity = (Array.isArray(input.hiActivity) ? input.hiActivity : []).map(row => normalizeRecord(row, "HI Activity"));
  const records = [...alerts, ...hiActivity].filter(row => dayKey(row.createdAt) === date);
  const snapshots = Array.isArray(input.snapshots) ? input.snapshots : [];
  const snapshotsByEvent = new Map();
  for (const snapshot of snapshots) {
    const key = String(snapshot.event_id || "");
    if (!key) continue;
    if (!snapshotsByEvent.has(key)) snapshotsByEvent.set(key, []);
    snapshotsByEvent.get(key).push(snapshot);
  }
  const withSnapshots = records.filter(row => (snapshotsByEvent.get(row.eventId) || []).length > 0);
  const statCoverage = Object.fromEntries(STAT_FIELDS.map(field => [
    field, records.filter(row => row.statsAtSignal[field] !== null).length
  ]));
  const bot1 = {
    name: "Statistics & Match Data",
    summary: summarize(records),
    availableAtSignal: statCoverage,
    recordsWithAnySignalStats: records.filter(row => Object.values(row.statsAtSignal).some(value => value !== null)).length
  };
  const sotRows = records.filter(row => row.statsAtSignal.onTarget !== null ||
    row.statsAtSignal.onTarget10m !== null || row.statsAtSignal.totalOnTarget !== null);
  const xgRows = records.filter(row => row.statsAtSignal.xG !== null || row.statsAtSignal.xGDelta !== null);
  const snapshotSot = snapshots.filter(row => numberOrNull(row.shots_on_target) !== null);
  const bot2 = {
    name: "SOT & xG Intelligence",
    recordsWithExplicitSot: sotRows.length,
    recordsWithExplicitXg: xgRows.length,
    snapshotRows: snapshots.length,
    snapshotRowsWithSot: snapshotSot.length,
    sotSnapshotsByTeam: groupedOutcomes(snapshotSot.map(row => ({
      ...row, outcome: "pending", verified: false
    })), row => row.team_name).map(row => ({ team: row.name, snapshots: row.alerts })),
    rule: "Only explicit Shots on Target fields and shots_on_target snapshots are counted; generic shots and off-target are excluded."
  };
  const bot3 = {
    name: "Alert Timing & Goal Sequence",
    byMinuteBand: groupedOutcomes(records, row => row.minute === null ? "unknown"
      : row.minute < 46 ? "1st half" : row.minute <= 59 ? "46–59"
      : row.minute <= 74 ? "60–74" : row.minute <= 88 ? "75–88" : "89+"),
    recordsWithGoalMinutes: records.filter(row => row.goalMinutes.length > 0).length,
    goalMinutes: records.flatMap(row => row.goalMinutes).sort((a, b) => a - b),
    note: "Goal minutes are shown only when retained in the stored record; no goal timeline is inferred from final score."
  };
  const bot4 = {
    name: "League & Team Intelligence",
    byLeague: groupedOutcomes(records, row => row.league),
    byTeam: groupedOutcomes(records.flatMap(row => row.teams.filter(Boolean).map(team => ({
      ...row, team
    }))), row => row.team),
    note: "Win rates use only settlements with explicit provider, fixture, score scope and final score."
  };
  const bot5 = {
    name: "Failures, Risks & Data Integrity",
    totalRecords: records.length,
    verifiedSettlements: records.filter(row => row.verified).length,
    unverifiedSettlements: records.filter(row => ["won", "lost"].includes(row.outcome) && !row.verified).length,
    pending: records.filter(row => !["won", "lost", "push", "void"].includes(row.outcome)).length,
    missingEventId: records.filter(row => !row.eventId).length,
    missingLeague: records.filter(row => !row.league || row.league === "Άγνωστη διοργάνωση").length,
    missingSot: records.filter(row => row.statsAtSignal.onTarget === null && row.statsAtSignal.onTarget10m === null && row.statsAtSignal.totalOnTarget === null).length,
    missingSnapshots: records.filter(row => !(snapshotsByEvent.get(row.eventId) || []).length).length,
    recordsWithSnapshots: withSnapshots.length,
    risks: [
      "Unverified and pending settlements are kept separate from wins/losses.",
      "Missing snapshots or missing statistics are reported as coverage gaps, not zero values."
    ]
  };
  return {
    ok: true,
    reportType: "elite_five_bot_daily",
    date,
    timezone: "Europe/Athens",
    generatedAt: input.generatedAt || new Date().toISOString(),
    sourceCoverage: {
      aiVipRecordsLoaded: alerts.length,
      hiActivityRecordsLoaded: hiActivity.length,
      snapshotsLoaded: snapshots.length,
      recordsForReportDate: records.length
    },
    summary: summarize(records),
    bots: [bot1, bot2, bot3, bot4, bot5, {
      name: "Head Chief Analyst",
      role: "Chief coordinator & final decision",
      status: "compiled",
      summary: records.length
        ? "Συντονίζει και συνθέτει τα πέντε πορίσματα. Κάθε συμπέρασμα βασίζεται αποκλειστικά στα αποθηκευμένα και επαληθεύσιμα στοιχεία."
        : "Δεν βρέθηκαν αποθηκευμένες εγγραφές για την ημερομηνία αναφοράς· δεν εξάγεται συμπέρασμα από κενό δείγμα.",
      recommendations: [],
      safety: "Read-only. Δεν αλλάζει AI/VIP/HI Activity, SOT, Power Ranking, triggers, settlements ή live scanner."
    }],
    chiefAnalyst: {
      status: "compiled",
      summary: records.length
        ? "Ο Head Chief ολοκλήρωσε τη σύνθεση των πέντε specialist reports."
        : "Κενό δείγμα: δεν εξάγεται συμπέρασμα.",
      recommendations: [],
      safety: "Η ομάδα είναι read-only. Δεν αλλάζει AI/VIP/HI Activity, SOT, Power Ranking, triggers, settlements ή live scanner."
    }
  };
}
module.exports = { STAT_FIELDS, dayKey, normalizeRecord, summarize, buildFiveBotDailyReport };
