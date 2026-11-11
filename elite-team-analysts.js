"use strict";

// Phase 3: deterministic, report-only analysts. This module has no database,
// network, scheduler, notification, settlement, or live-protocol dependencies.

const SOT_FIELDS = Object.freeze(["onTarget", "onTarget10m", "totalOnTarget"]);
const MIN_COMPARISON_SAMPLE = 10;

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function uniqueStrings(value) {
  return Array.isArray(value) ? [...new Set(value.map(v => String(v).trim()).filter(Boolean))] : [];
}

function minuteBand(minute) {
  if (!Number.isInteger(minute)) return "unknown";
  if (minute < 46) return "first_half_or_unknown";
  if (minute <= 59) return "46-59";
  if (minute <= 74) return "60-74";
  if (minute <= 88) return "75-88";
  return "89+";
}

function normalizeRecord(record) {
  const stats = record && record.statsAtSignal && typeof record.statsAtSignal === "object" ? record.statsAtSignal : {};
  const outcome = String(record?.outcome || record?.betOutcome || "").toLowerCase();
  const verified = record?.verifiedScore === true && ["won", "lost"].includes(outcome);
  const minute = finite(record?.minute);
  const sot = Object.fromEntries(SOT_FIELDS.map(key => [key, finite(stats[key])]));
  const xg = { xG: finite(stats.xG), xGDelta: finite(stats.xGDelta) };
  return {
    alertId: record?.alertId ?? null,
    eventId: record?.eventId ?? null,
    createdAt: record?.createdAt ?? null,
    teams: Array.isArray(record?.teams) ? record.teams.slice(0, 2) : [],
    league: record?.league || null,
    minute: Number.isInteger(minute) ? minute : null,
    period: record?.period || "unknown",
    outcome,
    verified,
    triggerIds: uniqueStrings(record?.triggerIds),
    sot,
    xg,
    score: record?.finalScore || null,
    scoreScope: record?.scoreScope || null,
    settlementProvider: record?.settlementProvider || null
  };
}

function buildEliteTeamReport(inputRecords, options = {}) {
  const records = Array.isArray(inputRecords) ? inputRecords.map(normalizeRecord) : [];
  const eligible = records.filter(r => r.verified);
  const wins = eligible.filter(r => r.outcome === "won").length;
  const losses = eligible.length - wins;
  const coverage = {
    suppliedRecords: records.length,
    verifiedWinLoss: eligible.length,
    excludedUnverifiedOrNonWinLoss: records.length - eligible.length,
    withAnySignalSot: eligible.filter(r => SOT_FIELDS.some(k => r.sot[k] !== null)).length,
    withAnySignalXg: eligible.filter(r => Object.values(r.xg).some(v => v !== null)).length,
    withTriggerAttribution: eligible.filter(r => r.triggerIds.length > 0).length,
    withMinute: eligible.filter(r => r.minute !== null).length,
    withLeague: eligible.filter(r => Boolean(r.league)).length
  };

  const byTrigger = {};
  const byTiming = {};
  const byLeague = {};
  const forensic = eligible.map(r => {
    const triggerLabel = r.triggerIds.length ? r.triggerIds.join(" + ") : "unattributed";
    for (const trigger of r.triggerIds.length ? r.triggerIds : ["unattributed"]) {
      const b = byTrigger[trigger] ||= { alerts: 0, wins: 0, losses: 0, withSot: 0 };
      b.alerts++;
      if (r.outcome === "won") b.wins++; else b.losses++;
      if (SOT_FIELDS.some(k => r.sot[k] !== null)) b.withSot++;
    }
    const band = minuteBand(r.minute);
    const t = byTiming[band] ||= { alerts: 0, wins: 0, losses: 0 };
    t.alerts++;
    if (r.outcome === "won") t.wins++; else t.losses++;
    const league = r.league || "unknown";
    const l = byLeague[league] ||= { alerts: 0, wins: 0, losses: 0 };
    l.alerts++;
    if (r.outcome === "won") l.wins++; else l.losses++;
    return {
      alertId: r.alertId, eventId: r.eventId, teams: r.teams, league: r.league,
      minute: r.minute, timingBand: band, period: r.period,
      triggerIds: r.triggerIds, triggerAttribution: triggerLabel,
      signalSot: r.sot, signalXg: r.xg, outcome: r.outcome,
      score: r.score, scoreScope: r.scoreScope,
      evidenceLimitations: [
        "Only the retained signal-time SOT/xG fields are shown.",
        "No minute-by-minute post-signal timeline is inferred from final score."
      ]
    };
  });

  const recommendations = [];
  for (const [trigger, bucket] of Object.entries(byTrigger)) {
    if (bucket.alerts >= MIN_COMPARISON_SAMPLE) {
      recommendations.push({
        area: "trigger_review", key: trigger, sample: bucket.alerts,
        observedWinRatePct: Math.round(bucket.wins / bucket.alerts * 1000) / 10,
        recommendation: "Review in an offline validation cohort; do not change live thresholds from this report.",
        confidence: "descriptive_only"
      });
    }
  }

  const noProbability = "Unavailable: retained records do not include a calibrated prediction probability.";
  return {
    ok: true,
    mode: "offline_report_only",
    generatedAt: options.generatedAt || new Date().toISOString(),
    reportingWindow: options.reportingWindow || null,
    coverage,
    outcomeSummary: {
      verifiedWinLoss: eligible.length, wins, losses,
      observedWinRatePct: eligible.length ? Math.round(wins / eligible.length * 1000) / 10 : null
    },
    analysts: {
      sotDataIntegrity: {
        status: "partial",
        note: "Checks presence of explicit SOT fields only. Raw provider provenance, freshness and team-level snapshot reconciliation are not supplied to this engine.",
        fields: SOT_FIELDS
      },
      triggerPerformance: { status: "available_with_attribution_limits", byTrigger },
      timingMomentum: {
        status: "timing_only_no_timeline",
        byTiming,
        note: "Minute bands are descriptive; momentum and post-signal sequences require timestamped snapshots."
      },
      leagueIntelligence: {
        status: "descriptive_only",
        byLeague,
        note: "No league ranking or quality claim is made from small or unadjusted samples."
      },
      teamIntelligence: {
        status: "unavailable",
        note: "Historical team form, opponent strength and home/away splits are not present in this input."
      },
      matchForensics: {
        status: "available_for_verified_win_loss",
        reviewed: forensic.length,
        records: forensic
      },
      calibrationStrategy: {
        status: "unavailable",
        probabilityCalibration: noProbability,
        note: "Heuristic win rate is not a probability forecast; no Brier score or log loss is fabricated."
      },
      providerLatency: {
        status: "unavailable",
        note: "Comparable provider event timestamps and GoalMatrix retrieval timestamps are not present in this input."
      },
      chiefAnalyst: {
        status: "compiled",
        summary: eligible.length
          ? `Reviewed ${eligible.length} verified win/loss records: ${wins} wins and ${losses} losses. Findings are descriptive, not causal.`
          : "No eligible verified win/loss records were supplied; no performance conclusion is possible.",
        recommendations,
        safety: "No live protocol changes, alerts, settlements, database writes, or notifications are performed."
      }
    }
  };
}

module.exports = { SOT_FIELDS, MIN_COMPARISON_SAMPLE, finite, normalizeRecord, minuteBand, buildEliteTeamReport };
