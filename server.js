const http = require("node:http");
const webpush = require("web-push");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { getPeriodSettlementScore, parseOverLine, gradeOverMarket, canSettleOverWithoutStartScore, normalizeFixtureName, getProviderFixtureId, findUniqueCompletedFixture } = require("./settlement");
const { validateRollingSot, confirmSotSignal, readExactSotStat } = require("./sot-integrity");
const { isAiMinuteEligible, isCumulativeSotMinute, isFirstHalfSotMinute, isFirstHalfEightSotMinute } = require("./ai-minute-window");
const { createLimiter, isHistoryLeagueSupported, fetchCompetitionHistoryWindow } = require("./competition-history");
const { createCompetitionHistoryStore } = require("./competition-history-store");
const { buildPreMatchMatchupContext, seasonBoundsForLeague, seasonEventFilterForLeague, scorePreMatchMatchupContext } = require("./pre-match-intelligence");
const { calculatePowerRankingScore, isPowerRankingMinuteEligible, shouldEmitAutonomousPowerRankingAlert } = require("./power-ranking-trigger");
const { buildIndependentAiTriggers, sotTriggerConfirmationKey } = require("./ai-trigger-isolation");
let Pool = null;
try { ({ Pool } = require("pg")); } catch {}

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const API_BASE = "https://api.pitchapi.dev";
const PRE_MATCH_OVER_LINES = Object.freeze(["0.5","1.5","2.5","3.5","4.5","5.5","6.5"]);

// SportAPI is a strictly supplemental, budget-capped canary for cumulative live stats.
// Free-plan guardrail: one fixture-list request per 10 minutes and at most one
// per-fixture stats request globally every 5 minutes (~432 requests/day at most).
const SPORTAPI_API_KEY = process.env.SPORTAPI_API_KEY || "";
const sportApiDateFixturesCache = new Map();
const sportApiFixtureStatsCache = new Map();
const sportApiIsraelLeagueFixturesCache = new Map();
const SPORTAPI_ISRAEL_LEAGUE_CACHE_MS = 60 * 60 * 1000;
let sportApiLastStatsRequestAt = 0;
const SPORTAPI_FIXTURE_CACHE_MS = 10 * 60 * 1000;
const SPORTAPI_STATS_REFRESH_MS = 5 * 60 * 1000;
const SPORTAPI_STATS_REQUEST_GAP_MS = 5 * 60 * 1000;

// Normalize common football API response envelopes. Several providers wrap the
// fixture array in data.matches/data.fixtures rather than returning data as an array.
function extractFixtureArray(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  const direct = [body.matches, body.fixtures, body.events, body.results, body.items, body.data];
  for (const value of direct) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      for (const key of ["matches", "fixtures", "events", "results", "items", "data"]) {
        if (Array.isArray(value[key])) return value[key];
      }
    }
  }
  return [];
}

const competitionHistoryLimiter = createLimiter(4);

const ESPN_HEADERS = {
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Referer": "https://www.espn.com/soccer/",
  "Origin": "https://www.espn.com"
};

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:nikosvretos28@gmail.com";
const pushSubscriptions = new Map();
const pushRateLimit = new Map();
const PUSH_SCAN_TOKEN = process.env.PUSH_SCAN_TOKEN || require("node:crypto").randomBytes(32).toString("hex");
const POWER_GAMES_ADMIN_PIN = process.env.POWER_GAMES_ADMIN_PIN || "";
// Temporary preview switch. Disabled by default; when enabled, private read-only panels are accessible without PIN.
const GOALMATRIX_PREVIEW_UNLOCK = process.env.GOALMATRIX_PREVIEW_UNLOCK === "true";
const powerGamesAuthAttempts = new Map();
async function authorizePrivateAdminRequest(req) {
  let body;
  try { body = await readJsonBody(req, 4096); }
  catch { return { ok: false, status: 400, error: "Invalid admin request" }; }
  if (GOALMATRIX_PREVIEW_UNLOCK) return { ok: true, body };
  if (!POWER_GAMES_ADMIN_PIN) return { ok: false, status: 503, error: "Private access is not configured" };
  const ip = String(req.socket?.remoteAddress || "unknown").slice(0, 100);
  const now = Date.now();
  const attempt = powerGamesAuthAttempts.get(ip) || { count: 0, since: now, blockedUntil: 0 };
  if (attempt.blockedUntil > now) return { ok: false, status: 429, error: "Too many attempts" };
  if (now - attempt.since > 10 * 60 * 1000) { attempt.count = 0; attempt.since = now; attempt.blockedUntil = 0; }
  if (String(body.pin || "") !== POWER_GAMES_ADMIN_PIN) {
    attempt.count += 1;
    if (attempt.count >= 8) attempt.blockedUntil = now + 10 * 60 * 1000;
    powerGamesAuthAttempts.set(ip, attempt);
    return { ok: false, status: attempt.blockedUntil > now ? 429 : 401, error: "Invalid admin PIN" };
  }
  powerGamesAuthAttempts.delete(ip);
  return { ok: true, body };
}
const pushScanSnapshots = new Map();
// Each SOT-based AI trigger keeps its own two-sample confirmation state.
const pushScanSotConfirmations = new Map();
const pushScanRedCardSince = new Map();
const historicalTeamResultCache = new Map();
const pushScanLastAlert = new Map();
// Existing AI Power Ranking 59+ trigger: keep its deduplication and behavior unchanged.
const pushScanPowerRankingAlerts = new Set();
// Autonomous Power Ranking 65+ has a separate persistent alert ID and in-memory guard.
const pushScanAutonomousPowerRankingAlerts = new Set();
// Bounded temporary history for hosts without PostgreSQL. Lost on process restart.
const volatileAlertHistory = new Map();
const volatileHighActivityHistory = new Map();
const VOLATILE_HISTORY_LIMIT = 5000;
function saveVolatileRecord(store, key, payload, settledFields = []) {
  const id = String(key || "");
  if (!id || !payload || typeof payload !== "object") return;
  const previous = store.get(id);
  const next = { ...payload };
  if (previous) {
    for (const field of ["reason","triggerIds","supportSignalIds","statsAtSignal","odds","bookmaker","oddsVerifiedAt","scoreAtSignal","supportingCriteriaScore","evidenceKinds","points"]) if (next[field] == null && previous[field] != null) next[field] = previous[field];
    for (const field of settledFields) if (previous[field] != null && (next[field] == null || next[field] === "pending" || next[field] === "εκκρεμεί")) next[field] = previous[field];
  }
  store.set(id, next);
  if (store.size > VOLATILE_HISTORY_LIMIT) {
    const oldest = [...store.entries()].sort((a,b) => Number(a[1].createdAt || 0) - Number(b[1].createdAt || 0));
    for (let i=0; i<oldest.length-VOLATILE_HISTORY_LIMIT; i++) store.delete(oldest[i][0]);
  }
}
function volatileHistoryRows(store) { return [...store.values()].sort((a,b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)); }
// Public alert history deliberately excludes proprietary trigger attribution and signal evidence.
function publicAlertPayload(payload) {
  const { reason, triggerIds, supportSignalIds, statsAtSignal, odds, bookmaker, oddsVerifiedAt, scoreAtSignal, supportingCriteriaScore, evidenceKinds, points, ...publicFields } = payload || {};
  return publicFields;
}
let pushDbInit = null;
let alertHistoryDbInit = null;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}
async function ensurePushDb() {
  if (!analyticsPool) return false;
  if (!pushDbInit) pushDbInit = analyticsPool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      subscription JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).then(() => true).catch(error => { pushDbInit = null; console.error("Push subscription database unavailable:", error.message); return false; });
  return pushDbInit;
}
async function ensureAlertHistoryDb() {
  if (!analyticsPool) return false;
  if (!alertHistoryDbInit) alertHistoryDbInit = analyticsPool.query(`
    CREATE TABLE IF NOT EXISTS alert_history (
      alert_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('AI','VIP')),
      created_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS alert_history_created_at_idx ON alert_history(created_at DESC);
    CREATE INDEX IF NOT EXISTS alert_history_event_id_idx ON alert_history(event_id);
  `).then(() => true).catch(error => {
    alertHistoryDbInit = null;
    console.error("Alert history database unavailable:", error.message);
    return false;
  });
  return alertHistoryDbInit;
}

let highActivityHistoryDbInit = null;
async function ensureHighActivityHistoryDb() {
  if (!highActivityHistoryPool) return false;
  if (!highActivityHistoryDbInit) highActivityHistoryDbInit = highActivityHistoryPool.query(`
    CREATE TABLE IF NOT EXISTS high_activity_history (
      observation_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS high_activity_history_created_at_idx ON high_activity_history(created_at DESC);
    CREATE INDEX IF NOT EXISTS high_activity_history_event_id_idx ON high_activity_history(event_id);
  `).then(() => true).catch(error => {
    highActivityHistoryDbInit = null;
    console.error("High Activity history database unavailable:", error.message);
    return false;
  });
  return highActivityHistoryDbInit;
}

let protocolAnalystDbInit = null;
let protocolAnalystRunInFlight = null;

async function ensureProtocolAnalystDb() {
  if (!analyticsPool) return false;
  if (!protocolAnalystDbInit) protocolAnalystDbInit = analyticsPool.query(
    "CREATE TABLE IF NOT EXISTS protocol_analyst_reports (id BIGSERIAL PRIMARY KEY, generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), report JSONB NOT NULL); CREATE INDEX IF NOT EXISTS protocol_analyst_reports_generated_at_idx ON protocol_analyst_reports(generated_at DESC)"
  ).then(() => true).catch(error => {
    protocolAnalystDbInit = null;
    console.error("Protocol analyst database unavailable:", error.message);
    return false;
  });
  return protocolAnalystDbInit;
}

// Deployment verification marker: automatic AI alerts accept verified decimal odds above 1.00, with no 1.60 floor.
async function runProtocolAnalyst() {
  if (protocolAnalystRunInFlight) return protocolAnalystRunInFlight;
  protocolAnalystRunInFlight = (async () => {
    if (!await ensureAlertHistoryDb() || !await ensureProtocolAnalystDb()) return null;
    const result = await analyticsPool.query(
      "SELECT payload, created_at FROM alert_history WHERE payload->>'source'='server-push' AND COALESCE(payload->>'level','AI')='AI' AND payload->>'betOutcome' IN ('won','lost') AND payload->>'betSettlementProvider' IS NOT NULL AND payload->>'betSettlementFixtureId' IS NOT NULL AND payload->>'betScoreScope' IN ('first_half','full_time') AND payload->>'betFinalScore' ~ '^[0-9]+-[0-9]+$' AND (payload->>'betScoreScope' <> 'first_half' OR (NULLIF(payload->>'betHalfTimeScore','') IS NOT NULL AND payload->>'betHalfTimeScore'=payload->>'betFinalScore')) AND created_at > NOW() - INTERVAL '180 days' ORDER BY created_at DESC LIMIT 10000"
    );
    const allRecords = result.rows.map(row => {
      const p = row.payload || {};
      const won = p.betOutcome === "won";
      const minuteCandidate = p.minuteNumber !== null && p.minuteNumber !== undefined && String(p.minuteNumber).trim() !== ""
        ? p.minuteNumber : String(p.minute || "").match(/\d{1,3}/)?.[0];
      const parsedMinute = Number(minuteCandidate);
      const minute = Number.isFinite(parsedMinute) ? parsedMinute : Number(String(minuteCandidate ?? "").match(/\d{1,3}/)?.[0]);
      const odds = p.odds !== null && p.odds !== undefined && p.odds !== "" ? Number(p.odds) : NaN;
      const stats = p.statsAtSignal || {};
      return {
        won, minute: Number.isFinite(minute) ? minute : null,
        phase: p.periodAtSignal || "unknown",
        oddsBand: Number.isFinite(odds) ? (odds < 1.2 ? "1.01–1.19" : odds < 1.4 ? "1.20–1.39" : odds < 1.6 ? "1.40–1.59" : odds < 1.8 ? "1.60–1.79" : odds < 2 ? "1.80–1.99" : "2.00+") : "missing",
        minuteBand: !Number.isFinite(minute) ? "unknown" : (p.periodAtSignal === "first_half" ? (minute < 30 ? "1′–29′" : "30′–40′") : (minute < 60 ? "46′–59′" : minute < 75 ? "60′–74′" : "75′–88′")),
        onTarget: stats.onTarget !== null && stats.onTarget !== undefined && Number.isFinite(Number(stats.onTarget)) ? Number(stats.onTarget) : null,
        onTarget10m: stats.onTarget10m !== null && stats.onTarget10m !== undefined && Number.isFinite(Number(stats.onTarget10m)) ? Number(stats.onTarget10m) : null,
        xGDelta: stats.xGDelta !== null && stats.xGDelta !== undefined && Number.isFinite(Number(stats.xGDelta)) ? Number(stats.xGDelta) : null,
        dirtySheetSupport: stats.dirtySheetSupport !== null && stats.dirtySheetSupport !== undefined && Number.isFinite(Number(stats.dirtySheetSupport)) ? Number(stats.dirtySheetSupport) : null,
        dirtySheetBand: stats.dirtySheetSample >= 5 && Number.isFinite(Number(stats.dirtySheetHomeRate)) && Number.isFinite(Number(stats.dirtySheetAwayRate))
          ? ((Number(stats.dirtySheetHomeRate) + Number(stats.dirtySheetAwayRate)) / 2 >= 0.8 ? "80%+" : (Number(stats.dirtySheetHomeRate) + Number(stats.dirtySheetAwayRate)) / 2 >= 0.6 ? "60–79%" : "<60%")
          : "missing",
        shotsOnTargetInsideBox: stats.shotsOnTargetInsideBox !== null && stats.shotsOnTargetInsideBox !== undefined && Number.isFinite(Number(stats.shotsOnTargetInsideBox)) ? Number(stats.shotsOnTargetInsideBox) : null,
        bigChances: stats.bigChances !== null && stats.bigChances !== undefined && Number.isFinite(Number(stats.bigChances)) ? Number(stats.bigChances) : null,
        liveConversionSupport: stats.liveConversionSupport !== null && stats.liveConversionSupport !== undefined && Number.isFinite(Number(stats.liveConversionSupport)) ? Number(stats.liveConversionSupport) : null,
        totalSotSupport: stats.totalSotSupport !== null && stats.totalSotSupport !== undefined && Number.isFinite(Number(stats.totalSotSupport)) ? Number(stats.totalSotSupport) : null,
        historicalOverSupport: stats.historicalOverSupport !== null && stats.historicalOverSupport !== undefined && String(stats.historicalOverSupport).trim() !== "" && Number.isFinite(Number(stats.historicalOverSupport)) ? Number(stats.historicalOverSupport) : null,
        shotQualityBand: stats.shotsOnTargetInsideBox == null && stats.bigChances == null ? "missing"
          : (Number(stats.shotsOnTargetInsideBox || 0) >= 4 || Number(stats.bigChances || 0) >= 3 ? "strong"
            : (Number(stats.shotsOnTargetInsideBox || 0) >= 2 || Number(stats.bigChances || 0) >= 1 ? "some" : "low")),
        liveConversionBand: stats.liveConversionSupport == null ? "missing"
          : (Number(stats.liveConversionSupport) >= 1.5 ? "high" : Number(stats.liveConversionSupport) > 0 ? "some" : "none"),
        shotBand: "missing",
        onTargetBand: stats.onTarget === null || stats.onTarget === undefined ? "missing" : Number(stats.onTarget) < 1 ? "0" : Number(stats.onTarget) < 2 ? "1" : Number(stats.onTarget) < 3 ? "2" : "3+",
        onTarget10mBand: stats.onTarget10m === null || stats.onTarget10m === undefined ? "missing" : Number(stats.onTarget10m) < 3 ? "0–2" : Number(stats.onTarget10m) < 6 ? "3–5" : "6+",
        xGBand: stats.xGDelta === null || stats.xGDelta === undefined ? "missing" : Number(stats.xGDelta) < 0.1 ? "0–0.09" : Number(stats.xGDelta) < 0.25 ? "0.10–0.24" : Number(stats.xGDelta) < 0.5 ? "0.25–0.49" : "0.50+",
        createdAt: row.created_at
      };
    });
    // Analyze only the currently approved AI window: second half 46–88.
    // Never include first-half, halftime, stoppage/out-of-window alerts, or unknown periods.
    const records = allRecords.filter(row =>
      row.phase === "second_half" && Number.isFinite(row.minute) && row.minute >= 46 && row.minute <= 88
    );
    // Trigger-level attribution is explicit and forward-looking. Older alerts without
    // triggerIds remain visible as unattributed; never infer their cause from outcomes.
    const triggerHistoryResult = await analyticsPool.query(
      "SELECT payload, created_at FROM alert_history WHERE payload->>'source'='server-push' AND COALESCE(payload->>'level','AI')='AI' AND created_at > NOW() - INTERVAL '180 days' ORDER BY created_at DESC LIMIT 10000"
    );
    const triggerHistoryRows = triggerHistoryResult.rows.map(row => {
      const p = row.payload || {};
      const rawMinute = p.minuteNumber !== null && p.minuteNumber !== undefined && String(p.minuteNumber).trim() !== ""
        ? p.minuteNumber : String(p.minute || "").match(/\d{1,3}/)?.[0];
      const parsedMinute = Number(rawMinute);
      const minute = Number.isFinite(parsedMinute) ? parsedMinute : null;
      const phase = p.periodAtSignal || "unknown";
      const finalScore = String(p.betFinalScore || "");
      const verified = ["won","lost"].includes(String(p.betOutcome || "").toLowerCase()) &&
        Boolean(p.betSettlementProvider) && Boolean(p.betSettlementFixtureId) &&
        ["first_half","full_time"].includes(String(p.betScoreScope || "")) &&
        /^[0-9]+-[0-9]+$/.test(finalScore) &&
        (p.betScoreScope !== "first_half" || (String(p.betHalfTimeScore || "").trim() !== "" && String(p.betHalfTimeScore) === finalScore));
      const outcome = verified ? String(p.betOutcome).toLowerCase()
        : ["won","lost","void","push"].includes(String(p.betOutcome || "").toLowerCase()) ? "unverified" : "pending";
      return {
        triggerIds: Array.isArray(p.triggerIds) ? [...new Set(p.triggerIds.map(String))] : [],
        supportSignalIds: Array.isArray(p.supportSignalIds) ? [...new Set(p.supportSignalIds.map(String))] : [],
        minute,
        phase,
        minuteBand: !Number.isFinite(minute) ? "Άγνωστο λεπτό"
          : phase === "first_half" ? (minute < 30 ? "1′–29′" : "30′–40′")
          : (minute < 60 ? "46′–59′" : minute < 75 ? "60′–74′" : "75′–88′"),
        powerRankingMinuteBand: !Number.isFinite(minute) ? "Άγνωστο λεπτό"
          : phase === "first_half" ? (minute < 30 ? "1′–29′" : "30′–35′")
          : (minute < 60 ? "46′–59′" : minute < 75 ? "60′–74′" : "75′–88′"),
        league: String(p.league || "Άγνωστη διοργάνωση"),
        outcome,
        createdAt: row.created_at
      };
    });
    const approvedWindowTriggerRows = triggerHistoryRows.filter(row =>
      row.phase === "second_half" && Number.isInteger(row.minute) && row.minute >= 46 && row.minute <= 88
    );
    const instrumentedTriggerRows = approvedWindowTriggerRows.filter(row => row.triggerIds.length > 0);
    const legacyUnattributedAlerts = approvedWindowTriggerRows.filter(row => row.triggerIds.length === 0).length;
    const triggerDefinitions = [
      { id: "recent_sot_pressure", label: "Πρόσφατη πίεση SOT", detail: "3+ SOT / 5′ ή 6+ SOT / 10′" },
      { id: "cumulative_20_sot", label: "20+ συνολικά SOT", detail: "Συνολικά SOT πριν από το 75′" },
      { id: "xg_threshold", label: "Υψηλό xG δύο ομάδων", detail: "Μία ομάδα ≥3.50 xG και η άλλη ≥2.50 xG" },
      { id: "man_advantage_pressure", label: "Man Advantage", detail: "Πρόσφατη κόκκινη κάρτα και πίεση της αριθμητικά υπερέχουσας ομάδας" },
      { id: "power_ranking_59", label: "Power Ranking 59+", detail: "Βαθμολογία ≥59/100 · trigger μέσα στα AI Alerts" },
      { id: "power_ranking_autonomous_65", label: "Αυτόνομο Power Ranking 65+", detail: "Ανεξάρτητη ειδοποίηση μόνο από βαθμολογία ≥65/100" }
    ];
    const summarizeTriggerRows = rows => {
      const wins = rows.filter(row => row.outcome === "won").length;
      const losses = rows.filter(row => row.outcome === "lost").length;
      const verifiedSettled = wins + losses;
      return {
        activated: rows.length,
        verifiedSettled,
        wins,
        losses,
        pending: rows.filter(row => row.outcome === "pending").length,
        unverified: rows.filter(row => row.outcome === "unverified").length,
        successRate: verifiedSettled ? Math.round(wins / verifiedSettled * 1000) / 10 : null
      };
    };
    const groupTriggerRows = (rows, field) => {
      const groups = new Map();
      for (const row of rows) {
        const key = String(row[field] || "Άγνωστο");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      return [...groups.entries()].map(([value, groupRows]) => ({
        value, ...summarizeTriggerRows(groupRows)
      })).sort((a,b) => b.activated - a.activated);
    };
    const triggerPerformance = triggerDefinitions.map(definition => {
      const rows = ["power_ranking_59", "power_ranking_autonomous_65"].includes(definition.id)
        ? triggerHistoryRows.filter(row => row.triggerIds.includes(definition.id) && (
            (row.phase === "first_half" && Number.isInteger(row.minute) && row.minute >= 1 && row.minute <= 35) ||
            (row.phase === "second_half" && Number.isInteger(row.minute) && row.minute >= 46 && row.minute <= 88)
          ))
        : instrumentedTriggerRows.filter(row => row.triggerIds.includes(definition.id));
      return {
        ...definition,
        ...summarizeTriggerRows(rows),
        byMinute: groupTriggerRows(rows, ["power_ranking_59", "power_ranking_autonomous_65"].includes(definition.id) ? "powerRankingMinuteBand" : "minuteBand"),
        byLeague: groupTriggerRows(rows, "league")
      };
    });
    const triggerCombinationMap = new Map();
    for (const row of instrumentedTriggerRows.filter(item => !item.triggerIds.includes("power_ranking_autonomous_65"))) {
      const key = [...row.triggerIds].sort().join(" + ");
      if (!key) continue;
      if (!triggerCombinationMap.has(key)) triggerCombinationMap.set(key, []);
      triggerCombinationMap.get(key).push(row);
    }
    const triggerCombinations = [...triggerCombinationMap.entries()].map(([combination, rows]) => ({
      combination,
      labels: combination.split(" + ").map(id => triggerDefinitions.find(item => item.id === id)?.label || id),
      ...summarizeTriggerRows(rows)
    })).sort((a,b) => b.activated - a.activated);
    const dangerousAttackSupportRows = instrumentedTriggerRows.filter(row => row.supportSignalIds.includes("dangerous_attacks_pressure"));
    const dangerousAttackSupport = {
      label: "Επικίνδυνες επιθέσεις (συμπληρωματική ένδειξη, όχι αυτόνομο trigger)",
      ...summarizeTriggerRows(dangerousAttackSupportRows),
      byMinute: groupTriggerRows(dangerousAttackSupportRows, "minuteBand"),
      byLeague: groupTriggerRows(dangerousAttackSupportRows, "league")
    };
    const summarize = rows => {
      const wins = rows.filter(row => row.won).length;
      return { settled: rows.length, wins, losses: rows.length - wins, successRate: rows.length ? Math.round(wins / rows.length * 1000) / 10 : null };
    };
    const overall = summarize(records);
    // Diagnose the requested late-alert windows independently of the live protocol's 88′ cutoff.
    const bySignalWindow = [
      { window: "2ο ημίχρονο 46′–59′", ...summarize(records.filter(row => row.minute >= 46 && row.minute <= 59)) },
      { window: "2ο ημίχρονο 60′–74′", ...summarize(records.filter(row => row.minute >= 60 && row.minute <= 74)) },
      { window: "2ο ημίχρονο 75′–88′", ...summarize(records.filter(row => row.minute >= 75 && row.minute <= 88)) }
    ];
    const segment = (field, label, sourceRows = records) => {
      const values = [...new Set(sourceRows.map(row => row[field]).filter(value => value !== null && value !== undefined && value !== ""))].sort();
      return values.map(value => ({ [label]: value, ...summarize(sourceRows.filter(row => row[field] === value)) }))
        .filter(row => row.settled >= 5)
        .sort((a,b) => b.settled - a.settled);
    };
    const recommendations = [];
    if (records.length < 20) {
      recommendations.push({
        priority: "data",
        title: "Συγκέντρωση επαρκούς ιστορικού",
        detail: "Υπάρχουν " + records.length + " πραγματικά διακανονισμένα AI alerts στο δείγμα των τελευταίων 180 ημερών. Χρειάζονται τουλάχιστον 20 συνολικά και 20 ανά ομάδα πριν προταθεί αλλαγή κανόνα."
      });
    } else {
      for (const item of segment("oddsBand", "oddsBand")) {
        if (item.settled < 20 || item.successRate == null) continue;
        const difference = item.successRate - overall.successRate;
        if (difference <= -10) recommendations.push({
          priority: "review",
          title: "Επανέλεγχος alerts με απόδοση " + item.oddsBand,
          detail: "Το ποσοστό επιτυχίας είναι " + item.successRate + "% σε " + item.settled + " περιπτώσεις, " + Math.abs(difference).toFixed(1) + " μονάδες κάτω από το συνολικό " + overall.successRate + "%. Να ελεγχθούν τα συγκεκριμένα ματς και οι αποδόσεις πριν αλλάξει ο κανόνας."
        });
        if (difference >= 8) recommendations.push({
          priority: "test",
          title: "Υποψήφια ομάδα για δοκιμή: " + item.oddsBand,
          detail: "Η ομάδα έχει " + item.successRate + "% σε " + item.settled + " περιπτώσεις, πάνω από τη συνολική επίδοση. Να ελεγχθεί σε ανεξάρτητο ιστορικό δείγμα· δεν αλλάζει αυτόματα το live πρωτόκολλο."
        });
      }
      for (const [field, label] of [["shotBand", "τελικές στο 5λεπτο"], ["onTargetBand", "σουτ στην εστία στο 5λεπτο"], ["onTarget10mBand", "σουτ στην εστία στο 10λεπτο"], ["xGBand", "μεταβολή xG στο 5λεπτο"], ["dirtySheetBand", "ιστορικό ομάδων που δέχονται γκολ"]]) {
        for (const item of segment(field, field)) {
          if (item.settled < 20 || item.successRate == null || item[field] === "missing") continue;
          const difference = item.successRate - overall.successRate;
          if (difference <= -10) recommendations.push({
            priority: "review",
            title: "Επανέλεγχος σήματος: " + label + " (" + item[field] + ")",
            detail: "Επιτυχία " + item.successRate + "% σε " + item.settled + " settled alerts, " + Math.abs(difference).toFixed(1) + " μονάδες κάτω από τη συνολική επίδοση. Να ελεγχθεί αν χρειάζεται αυστηρότερο κατώφλι."
          });
          if (difference >= 8) recommendations.push({
            priority: "test",
            title: "Δοκιμή σήματος: " + label + " (" + item[field] + ")",
            detail: "Επιτυχία " + item.successRate + "% σε " + item.settled + " settled alerts, πάνω από τη συνολική επίδοση. Απαιτείται ανεξάρτητος ιστορικός έλεγχος πριν από αλλαγή."
          });
        }
      }
      for (const item of segment("minuteBand", "minuteBand")) {
        if (item.settled < 20 || item.successRate == null) continue;
        const difference = item.successRate - overall.successRate;
        if (difference <= -12) recommendations.push({
          priority: "review",
          title: "Έλεγχος χρονικού παραθύρου " + item.minuteBand,
          detail: "Επιτυχία " + item.successRate + "% σε " + item.settled + " settled alerts. Να εξεταστεί αν τα σήματα αυτού του χρονικού παραθύρου χρειάζονται αυστηρότερα κριτήρια."
        });
      }
      if (!recommendations.length) recommendations.push({
        priority: "observe",
        title: "Δεν τεκμηριώνεται ακόμη αλλαγή",
        detail: "Το τρέχον δείγμα δεν δείχνει αρκετά μεγάλη, επαρκώς τεκμηριωμένη διαφορά ανά ομάδα. Διατηρούμε τους κανόνες και συνεχίζουμε τη μέτρηση."
      });
    }
    // Compare signal groups within each half, never against a pooled cross-half baseline.
    // Recommendations are research-only and require at least 20 settled alerts per segment.
    for (const phase of ["second_half"]) {
      const phaseRows = records.filter(row => row.phase === phase);
      const phaseOverall = summarize(phaseRows);
      if (phaseOverall.settled < 20) continue;
      for (const [field, label] of [
        ["minuteBand", "χρονικό παράθυρο έκδοσης alert"],
        ["onTargetBand", "πρόσφατα SOT 5λέπτου"],
        ["onTarget10mBand", "πρόσφατα SOT 10λέπτου"],
        ["shotQualityBand", "ποιότητα τελικών εντός περιοχής / μεγάλες ευκαιρίες"],
        ["liveConversionBand", "αποτελεσματικότητα SOT"],
        ["dirtySheetBand", "Dirty Sheet ιστορικό"],
        ["xGBand", "μεταβολή xG"],
        ["totalSotSupport", "υποστήριξη συνολικών SOT"],
        ["historicalOverSupport", "ιστορική υποστήριξη Over"]
      ]) {
        for (const item of segment(field, field, phaseRows)) {
          if (item.settled < 20 || item.successRate == null || item[field] === "missing") continue;
          const difference = item.successRate - phaseOverall.successRate;
          if (difference <= -10) recommendations.push({
            priority: "review",
            title: (phase === "first_half" ? "1ο ημίχρονο" : "2ο ημίχρονο") + " · επανέλεγχος " + label + " (" + item[field] + ")",
            detail: "Επιτυχία " + item.successRate + "% σε " + item.settled + " settled alerts, " + Math.abs(difference).toFixed(1) + " μονάδες κάτω από το αντίστοιχο ημίχρονο (" + phaseOverall.successRate + "%). Απαιτείται έλεγχος πριν από οποιαδήποτε αλλαγή."
          });
          if (difference >= 8) recommendations.push({
            priority: "test",
            title: (phase === "first_half" ? "1ο ημίχρονο" : "2ο ημίχρονο") + " · θετικό σήμα " + label + " (" + item[field] + ")",
            detail: "Επιτυχία " + item.successRate + "% σε " + item.settled + " settled alerts, " + difference.toFixed(1) + " μονάδες πάνω από το αντίστοιχο ημίχρονο. Χρειάζεται ανεξάρτητη επιβεβαίωση· δεν αλλάζει αυτόματα το live πρωτόκολλο."
          });
        }
      }
    }
    const dailyResult = await analyticsPool.query(
      "SELECT payload FROM alert_history WHERE payload->>'source'='server-push' AND COALESCE(payload->>'level','AI')='AI' AND created_at >= ((date_trunc('day', NOW() AT TIME ZONE 'Europe/Athens')) AT TIME ZONE 'Europe/Athens') ORDER BY created_at DESC LIMIT 5000"
    );
    const dailyOutcomes = dailyResult.rows.map(row => String(row.payload?.betOutcome || 'pending').toLowerCase());
    const dailyWins = dailyOutcomes.filter(value => value === 'won').length;
    const dailyLosses = dailyOutcomes.filter(value => value === 'lost').length;
    const dailyPending = dailyOutcomes.filter(value => !['won','lost','push','void'].includes(value)).length;
    const dailyPushes = dailyOutcomes.filter(value => value === 'push').length;
    const dailyVoids = dailyOutcomes.filter(value => value === 'void').length;
    const dailySettled = dailyWins + dailyLosses;
    const report = {
      generatedAt: new Date().toISOString(),
      windowDays: 180,
      dailySummary: {
        date: new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Athens", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()),
        total: dailyOutcomes.length, wins: dailyWins, losses: dailyLosses, pending: dailyPending,
        pushes: dailyPushes, voids: dailyVoids, settled: dailySettled,
        successRate: dailySettled ? Math.round(dailyWins / dailySettled * 1000) / 10 : null,
        note: "AI alerts created today in Greece local time; excludes HI ACTIVITY observations."
      },
      method: "statistical_review_of_settled_server_generated_ai_alerts_second_half_only",
      automaticRuleChanges: false,
      sample: overall,
      dataQuality: {
        recordsAnalyzed: records.length,
        allSettledAlertsIn180Days: allRecords.length,
        researchScope: "second_half_46_to_88_only",
        alertsExcludedOutsideResearchScope: allRecords.length - records.length,
        alertsMissingOdds: records.filter(row => row.oddsBand === "missing").length,
        alertsMissingSignalStats: result.rows.filter(row => !row.payload?.statsAtSignal).length,
        alertsWithDirtySheetHistory: records.filter(row => row.dirtySheetBand !== "missing").length,
        minimumRecommendedSamplePerSegment: 20,
        note: "Μόνο πραγματικά server-generated AI alerts με καταγεγραμμένο αποτέλεσμα· δεν κατασκευάζονται αποτελέσματα."
      },
      byOdds: segment("oddsBand", "oddsBand"),
      byMinute: segment("minuteBand", "minuteBand"),
      bySignalWindow,
      byPeriod: segment("phase", "period"),
      byShots: [],
      byOnTarget: segment("onTargetBand", "onTargetBand"),
      byOnTarget10m: segment("onTarget10mBand", "onTarget10mBand"),
      byXG: segment("xGBand", "xGBand"),
      byDirtySheet: segment("dirtySheetBand", "dirtySheetBand"),
      byShotQuality: segment("shotQualityBand", "shotQualityBand"),
      byLiveConversion: segment("liveConversionBand", "liveConversionBand"),
      byTotalSotSupport: segment("totalSotSupport", "totalSotSupport"),
      byHistoricalOverSupport: segment("historicalOverSupport", "historicalOverSupport"),
      triggerEvaluation: {
        windowDays: 180,
        instrumentedAlerts: instrumentedTriggerRows.length,
        legacyUnattributedAlerts: legacyUnattributedAlerts,
        triggers: triggerPerformance,
        combinations: triggerCombinations,
        dangerousAttackSupport,
        note: "Η απόδοση υπολογίζεται μόνο από διακανονισμένα alerts με επαληθευμένο provider, fixture και σκορ. Τα παλαιότερα alerts χωρίς triggerIds δεν αποδίδονται εκ των υστέρων. Τα ποσοστά συνδυασμών δείχνουν συσχέτιση, όχι αιτιότητα."
      },
      missingData: { historicalOverSupport: records.filter(row => row.historicalOverSupport === null || row.historicalOverSupport === undefined).length },
      recommendations
    };
    await analyticsPool.query("INSERT INTO protocol_analyst_reports(generated_at,report) VALUES($1,$2::jsonb)", [report.generatedAt, JSON.stringify(report)]);
    await analyticsPool.query("DELETE FROM protocol_analyst_reports WHERE id NOT IN (SELECT id FROM protocol_analyst_reports ORDER BY generated_at DESC LIMIT 50)").catch(() => {});
    console.log("Goal Pulse protocol analyst completed:", JSON.stringify({ settledAlerts: overall.settled, successRate: overall.successRate, byPeriod: report.byPeriod, recommendations: recommendations.length }));
    return report;
  })().catch(error => {
    console.error("Goal Pulse protocol analyst failed:", error.message);
    return null;
  }).finally(() => { protocolAnalystRunInFlight = null; });
  return protocolAnalystRunInFlight;
}

async function savePushSubscription(subscription) {
  const endpoint = String(subscription?.endpoint || "");
  if (!endpoint.startsWith("https://") || !subscription?.keys?.p256dh || !subscription?.keys?.auth) throw new Error("Invalid push subscription");
  pushSubscriptions.set(endpoint, subscription);
  if (await ensurePushDb()) {
    await analyticsPool.query(
      "INSERT INTO push_subscriptions(endpoint,subscription,created_at,updated_at) VALUES($1,$2::jsonb,NOW(),NOW()) ON CONFLICT(endpoint) DO UPDATE SET subscription=EXCLUDED.subscription,updated_at=NOW()",
      [endpoint, JSON.stringify(subscription)]
    );
  }
}
async function sendPushToSubscribers(payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return { sent: 0, failed: 0, configured: false };
  let subscriptions = [...pushSubscriptions.values()];
  if (await ensurePushDb()) {
    try {
      const result = await analyticsPool.query("SELECT subscription FROM push_subscriptions");
      subscriptions = result.rows.map(row => row.subscription);
    } catch {}
  }
  let sent = 0, failed = 0;
  await Promise.all(subscriptions.map(async subscription => {
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 300, urgency: "high" });
      sent++;
    } catch (error) {
      failed++;
      console.error("Goal Pulse push delivery failed:", JSON.stringify({
        statusCode: Number(error.statusCode || 0),
        message: String(error.message || "unknown push error").slice(0, 180),
        endpointHost: (() => { try { return new URL(subscription.endpoint).host; } catch { return "invalid"; } })()
      }));
      if (error.statusCode === 404 || error.statusCode === 410) {
        console.warn("Removing expired Goal Pulse push subscription:", JSON.stringify({
          statusCode: error.statusCode,
          endpointHost: (() => { try { return new URL(subscription.endpoint).host; } catch { return "invalid"; } })()
        }));
        pushSubscriptions.delete(subscription.endpoint);
        if (await ensurePushDb()) await analyticsPool.query("DELETE FROM push_subscriptions WHERE endpoint=$1", [subscription.endpoint]).catch(() => {});
      }
    }
  }));
  return { sent, failed, configured: true };
}
function pushRequestAllowed(req, res) {
  const origin = req.headers.origin || "";
  if (!isAllowedOrigin(origin)) { send(res, 403, { error: "Origin not allowed" }); return false; }
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  const rateKey = ip + ":" + new URL(req.url, "http://localhost").pathname;
  const now = Date.now(), previous = pushRateLimit.get(rateKey) || 0;
  if (now - previous < 800) { send(res, 429, { error: "Too many requests" }); return false; }
  pushRateLimit.set(rateKey, now);
  return true;
}
async function readJsonBody(req, maxBytes = 20000) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxBytes) throw new Error("Request body too large");
  }
  return JSON.parse(raw || "{}");
}

const cache = new Map();
const pitchInflight = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const SCOREBOARD_TTL_MS = 15 * 1000;
const SCOREBOARD_STALE_TTL_MS = 15 * 1000;
const SCOREBOARD_LEAGUES = [
  "eng.1", "esp.1", "ita.1", "ger.1", "fra.1", "por.1", "ned.1", "sco.1", "gre.1", "tur.1", "bra.1", "arg.1", "usa.1", "mex.1", "aus.1", "eng.2", "esp.2", "ita.2", "ger.2", "fra.2", "bel.1", "aut.1", "sui.1", "den.1", "nor.1", "swe.1", "pol.1", "jpn.1", "kor.1", "sau.1", "bra.2", "eng.3", "eng.4", "ita.3", "ger.3", "fra.3", "por.2", "ned.2", "sco.2", "bel.2", "aut.2", "sui.2", "den.2", "nor.2", "swe.2", "pol.2", "tur.2", "usa.2", "bra.3", "arg.2", "uefa.champions", "uefa.europa", "uefa.europa.conf", "eng.fa", "eng.league_cup", "esp.copa_del_rey", "esp.super_cup", "ita.coppa_italia", "ita.super_cup", "ger.dfb_pokal", "ger.super_cup", "fra.coupe_de_france", "ned.cup", "sco.tennents", "sco.cis", "por.taca.portugal", "gre.cup", "arg.copa", "bra.copa_do_brazil", "conmebol.libertadores", "conmebol.sudamericana", "eng.5", "eng.6", "eng.7", "esp.3", "ita.4", "ger.4", "fra.4", "por.3", "ned.3", "gre.2", "bra.4", "arg.3", "jpn.2", "kor.2", "aus.2", "usa.nwsl", "eng.w.1", "esp.w.1", "fra.w.1", "uefa.nations", "fifa.world", "fifa.worldq.uefa", "fifa.worldq.conmebol", "conmebol.copa_america", "concacaf.gold", "concacaf.nations", "caf.nations", "afc.asian.cup", "fifa.cwc", "ita.w.1", "ger.w.1", "por.w.1", "mex.w.1", "bra.w.1", "arg.w.1", "aus.w.1", "uefa.w.champions", "chi.1", "col.1", "uru.1", "par.1", "ecu.1", "per.1", "bol.1", "ven.1", "crc.1", "egy.1", "rsa.1", "mar.1", "irn.1", "qat.1", "uae.1", "ind.1", "tha.1", "idn.1", "mys.1", "irl.1", "isl.1", "fin.1", "rou.1", "cro.1", "srb.1", "cze.1", "svk.1", "hun.1", "bul.1", "ukr.1", "rus.1", "nzl.1", "chi.2", "col.2", "uru.2", "par.2", "ecu.2", "per.2", "rou.2", "cro.2", "cze.2", "irl.2", "fin.2", "isl.2", "irq.1", "aze.1", "arm.1", "int.ukrainian_youth"
];
// Probe every configured ESPN competition once after startup. If ESPN returns
// HTTP 400, skip that path for the rest of this process to avoid repeated failures.
// This keeps historical exclusions from permanently hiding competitions that may
// now be available, without changing match selection or alert protocols.
const ESPN_UNSUPPORTED_LEAGUES = new Set();
const scoreboardCache = new Map();
const scoreboardInflight = new Map();
const sportScoreWidgetSlugCache = { at: 0, map: new Map() };
const liveHistory = new Map();
const LIVE_HISTORY_TTL_MS = 11 * 60 * 1000;
function resolveDatabaseUrl(raw) {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  // These compatibility rules are specific to the Render deployment. Do not
  // rewrite a database host when this same API is deployed on another platform.
  const onRender = Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID);
  const renderHost = "dpg-db9t153rjlhs7382ko40-a";
  if (/^[a-f0-9]{32}$/i.test(trimmed)) {
    if (!onRender) {
      console.warn("DATABASE_URL looks like a password rather than a connection URL; database disabled.");
      return "";
    }
    const username = process.env.PGUSER || "goal_pulse_memberships_user";
    const database = process.env.PGDATABASE || "goal_pulse_memberships";
    const password = process.env.PGPASSWORD || process.env.DATABASE_PASSWORD || trimmed;
    return "postgresql://" + encodeURIComponent(username) + ":" + encodeURIComponent(password) + "@" + renderHost + "/" + encodeURIComponent(database);
  }
  // Keep a valid platform-provided connection URL unchanged outside Render.
  try {
    const parsed = new URL(trimmed);
    if (onRender && (parsed.hostname.toLowerCase() === "base" ||
        parsed.hostname.toLowerCase() === renderHost)) {
      parsed.hostname = renderHost;
    }
    return parsed.toString();
  } catch {
    if (!onRender) return trimmed;
    // Render-only fallback for its known placeholder hostname.
    return trimmed
      .replace(/@base(?=[:/?#]|$)/i, "@" + renderHost)
      .replace(/:\/\/base(?=[:/?#]|$)/i, "://" + renderHost)
      .replace(/@dpg-db9t153rjlhs7382ko40-a(?=[:/?#]|$)/i, "@" + renderHost)
      .replace(/:\/\/dpg-db9t153rjlhs7382ko40-a(?=[:/?#]|$)/i, "://" + renderHost);
  }
}
function getConfiguredDatabaseUrl() {
  const directUrl = process.env.DATABASE_URL || process.env.ConnectionStrings__DefaultConnection || process.env.ConnectionStrings__Default || "";
  if (directUrl.trim()) return directUrl;
  // VibeNest may expose PostgreSQL credentials as separate environment variables.
  const host = process.env.POSTGRES_HOST || process.env.PGHOST || "";
  const user = process.env.POSTGRES_USER || process.env.PGUSER || "";
  const password = process.env.POSTGRES_PASSWORD || process.env.PGPASSWORD || "";
  const database = process.env.POSTGRES_DB || process.env.PGDATABASE || "";
  const port = process.env.POSTGRES_PORT || process.env.PGPORT || "5432";
  if (!host || !user || !password || !database) return "";
  return "postgresql://" + encodeURIComponent(user) + ":" + encodeURIComponent(password) +
    "@" + host + ":" + encodeURIComponent(port) + "/" + encodeURIComponent(database);
}
const resolvedDatabaseUrl = resolveDatabaseUrl(getConfiguredDatabaseUrl());
const analyticsPool = resolvedDatabaseUrl && Pool ? new Pool({
  connectionString: resolvedDatabaseUrl,
  ssl: resolvedDatabaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000
}) : null;
const competitionHistoryStore = createCompetitionHistoryStore({ pool: analyticsPool });
// Dedicated pool prevents shared analytics traffic from starving HI Activity history.
const highActivityHistoryPool = resolvedDatabaseUrl && Pool ? new Pool({
  connectionString: resolvedDatabaseUrl,
  ssl: resolvedDatabaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000
}) : null;
ensureAlertHistoryDb().then(ready => console.log('Persistent alert history schema:', ready ? 'ready' : 'unavailable')).catch(error => console.error('Persistent alert history initialization failed:', error.message));
let analyticsDbInit = null;
let analyticsDbWarningLogged = false;

async function ensureAnalyticsDb() {
  if (!analyticsPool) return false;
  if (!analyticsDbInit) {
    analyticsDbInit = analyticsPool.query(`
      CREATE TABLE IF NOT EXISTS live_stat_snapshots (
        id BIGSERIAL PRIMARY KEY,
        event_id TEXT NOT NULL,
        match_date TEXT NOT NULL,
        team_name TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        shots_on_target DOUBLE PRECISION,
        corners DOUBLE PRECISION,
        attacks DOUBLE PRECISION,
        dangerous_attacks DOUBLE PRECISION,
        minute TEXT
      );
      ALTER TABLE live_stat_snapshots ADD COLUMN IF NOT EXISTS attacks DOUBLE PRECISION;
      ALTER TABLE live_stat_snapshots ADD COLUMN IF NOT EXISTS dangerous_attacks DOUBLE PRECISION;
      CREATE INDEX IF NOT EXISTS live_stat_snapshots_event_team_time_idx
        ON live_stat_snapshots (event_id, team_name, observed_at DESC);
      CREATE INDEX IF NOT EXISTS live_stat_snapshots_time_idx
        ON live_stat_snapshots (observed_at DESC);
    `).then(() => true).catch(error => {
      analyticsDbInit = null;
      if (!analyticsDbWarningLogged) {
        console.error("Goal Pulse analytics database unavailable; using in-memory fallback:", error.message);
        analyticsDbWarningLogged = true;
      }
      return false;
    });
  }
  return analyticsDbInit;
}

ensureAnalyticsDb().then(async ready => {
  if (!ready) return;
  let client;
  try {
    client = await analyticsPool.connect();
    await client.query("BEGIN");
    const probeEventId = "goal-pulse-db-write-test-" + Date.now();
    const inserted = await client.query(
      "INSERT INTO live_stat_snapshots (event_id, match_date, team_name, shots_on_target) VALUES ($1, $2, $3, $4) RETURNING id, event_id",
      [probeEventId, new Date().toISOString().slice(0, 10), "Goal Pulse DB write test", 1]
    );
    const verified = await client.query("SELECT id FROM live_stat_snapshots WHERE id = $1 AND event_id = $2", [inserted.rows[0].id, probeEventId]);
    await client.query("ROLLBACK");
    const counts = await analyticsPool.query("SELECT COUNT(*)::int AS snapshot_count, COUNT(DISTINCT event_id)::int AS event_count FROM live_stat_snapshots");
    console.log("Goal Pulse analytics database write test:", JSON.stringify({
      connected: true,
      schemaReady: true,
      insertVerified: verified.rowCount === 1,
      testRowRolledBack: true,
      savedSnapshots: counts.rows[0].snapshot_count,
      savedEvents: counts.rows[0].event_count
    }));
  } catch (error) {
    if (client) { try { await client.query("ROLLBACK"); } catch (_) {} }
    console.error("Goal Pulse analytics database write test failed:", error.code || error.message);
  } finally {
    if (client) client.release();
  }
});

async function persistRollingTrends(matches, date) {
  if (!analyticsPool || !await ensureAnalyticsDb()) return false;
  try {
    const snapshots = [];
    for (const match of matches) for (const team of match.teams || []) {
      const hasPersistableStat = ["shotsOnTarget", "corners", "attacks", "dangerousAttacks"]
        .some(key => team[key] != null && Number.isFinite(Number(team[key])));
      if (team.team && hasPersistableStat) {
        snapshots.push([String(match.eventId), date, String(team.team), team.shotsOnTarget, team.corners, team.attacks, team.dangerousAttacks, String(match.minute || "")]);
      }
    }
    if (!snapshots.length) return true;
    const values = [];
    const tuples = snapshots.map((row, index) => {
      const n = index * 8;
      values.push(...row);
      return `($${n+1}, $${n+2}, $${n+3}, NOW(), $${n+4}, $${n+5}, $${n+6}, $${n+7}, $${n+8})`;
    });
    const snapshotInsert = await analyticsPool.query(
      `INSERT INTO live_stat_snapshots
       (event_id, match_date, team_name, observed_at, shots_on_target, corners, attacks, dangerous_attacks, minute)
       VALUES ${tuples.join(", ")}`, values
    );
    const eventIds = [...new Set(matches.map(match => String(match.eventId)).filter(Boolean))];
    const persistedCheck = await analyticsPool.query(
      `SELECT COUNT(*)::int AS snapshots, COUNT(DISTINCT event_id)::int AS events
       FROM live_stat_snapshots
       WHERE event_id = ANY($1::text[]) AND match_date = $2`,
      [eventIds, date]
    );
    console.log("Goal Pulse live snapshot persistence verified:", JSON.stringify({
      date, attemptedRows: snapshots.length, insertedRows: snapshotInsert.rowCount,
      savedSnapshotsForEvents: persistedCheck.rows[0].snapshots,
      savedEventsForDate: persistedCheck.rows[0].events
    }));
    const baselines = {};
    for (const minutes of [5, 10]) {
      const result = await analyticsPool.query(
        `SELECT DISTINCT ON (event_id, team_name)
           event_id, team_name, observed_at, shots_on_target, corners, attacks, dangerous_attacks
         FROM live_stat_snapshots
         WHERE event_id = ANY($1::text[])
           AND shots_on_target IS NOT NULL
           AND observed_at <= NOW() - ($2::interval)
           AND observed_at >= NOW() - ($2::interval + $3::interval)
         ORDER BY event_id, team_name, observed_at DESC`,
        [eventIds, minutes + " minutes", minutes === 5 ? "2 minutes" : "3 minutes"]
      );
      baselines[minutes] = result.rows;
    }
    for (const match of matches) {
      const makeWindow = minutes => {
        const teams = (match.teams || []).map(team => {
          const previous = baselines[minutes].find(row =>
            row.event_id === String(match.eventId) &&            String(row.team_name).trim().toLowerCase() === String(team.team || "").trim().toLowerCase()
          );
          const delta = (currentKey, previousKey = currentKey) => {
            const current = team[currentKey];
            const old = previous?.[previousKey];
            if (!previous || current == null || old == null || !Number.isFinite(Number(current)) || !Number.isFinite(Number(old))) return null;
            return Math.max(0, Number(current) - Number(old));
          };
          return {
            team: team.team,
            shotsOnTarget: delta("shotsOnTarget", "shots_on_target"),
            corners: delta("corners"),
            attacks: delta("attacks"),
            dangerousAttacks: delta("dangerousAttacks", "dangerous_attacks")
          };
        });
        const baselineTimes = baselines[minutes]
          .filter(row => row.event_id === String(match.eventId))
          .map(row => new Date(row.observed_at).getTime())
          .filter(Number.isFinite);
        const sampleMinutes = baselineTimes.length
          ? Math.round((Date.now() - Math.max(...baselineTimes)) / 60000)
          : minutes;
        return {
          available: teams.some(team => team.shotsOnTarget != null || team.corners != null || team.attacks != null || team.dangerousAttacks != null),
          sampleMinutes,
          teams
        };
      };
      match.trend = { source: "PostgreSQL-persisted cumulative-stat deltas", window5m: makeWindow(5), window10m: makeWindow(10) };
    }
    console.log("Goal Pulse rolling trend verification:", JSON.stringify({
      date, liveMatchesChecked: matches.length,
      window5mAvailable: matches.filter(match => match.trend?.window5m?.available).length,
      window10mAvailable: matches.filter(match => match.trend?.window10m?.available).length,
      persistedBaselineRows5m: baselines[5].length,
      persistedBaselineRows10m: baselines[10].length
    }));
    return true;
  } catch (error) {
    if (!analyticsDbWarningLogged) {
      console.error("Goal Pulse persistent trend storage failed; using in-memory fallback:", error.message);
      analyticsDbWarningLogged = true;
    }
    return false;
  }
}



function addRollingTrends(matches) {
  const now = Date.now();
  for (const match of matches) {
    const id = String(match.eventId || "");
    if (!id || !Array.isArray(match.teams) || match.teams.length < 2) continue;
    let history = liveHistory.get(id) || [];
    const last = history[history.length - 1];
    const snapshot = {
      at: now,
      teams: match.teams.map(team => ({
        team: String(team.team || "").trim().toLowerCase(),
        shotsOnTarget: team.shotsOnTarget,
        corners: team.corners,
        attacks: team.attacks,
        dangerousAttacks: team.dangerousAttacks
      }))
    };
    if (!last || now - last.at >= 12000) history.push(snapshot);
    history = history.filter(item => now - item.at <= LIVE_HISTORY_TTL_MS);
    liveHistory.set(id, history);

    const makeWindow = minutes => {
      const targetAge = minutes * 60 * 1000;
      const baseline = [...history].reverse().find(item => now - item.at >= targetAge);
      if (!baseline || !last) return { available: false, sampleMinutes: null, teams: [] };
      const deltas = match.teams.map((team, index) => {
        const name = String(team.team || "").trim().toLowerCase();
        const previous = baseline.teams.find(item => item.team && item.team === name) || baseline.teams[index];
        if (!previous) return { team: team.team, shotsOnTarget: null, corners: null, attacks: null, dangerousAttacks: null };
        const delta = key => {
          const current = team[key];
          const old = previous[key];
          if (current == null || old == null || !Number.isFinite(Number(current)) || !Number.isFinite(Number(old))) return null;
          return Math.max(0, Number(current) - Number(old));
        };
        return { team: team.team, shotsOnTarget: delta("shotsOnTarget"), corners: delta("corners"), attacks: delta("attacks"), dangerousAttacks: delta("dangerousAttacks") };
      });
      const available = deltas.some(item => item.shotsOnTarget != null || item.corners != null || item.attacks != null || item.dangerousAttacks != null);
      return { available, sampleMinutes: Math.round((now - baseline.at) / 60000 * 10) / 10, teams: deltas };
    };
    match.trend = {
      source: "server-observed cumulative-stat deltas",
      window5m: makeWindow(5),
      window10m: makeWindow(10)
    };
  }
  if (liveHistory.size > 500) {
    const oldest = [...liveHistory.entries()].sort((a, b) => (a[1].at(-1)?.at || 0) - (b[1].at(-1)?.at || 0)).slice(0, liveHistory.size - 500);
    for (const [id] of oldest) liveHistory.delete(id);
  }
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function pitchLeagueAliases(code) {
  const aliases = {
    "eng.1":["premier league"],"eng.2":["championship"],"eng.3":["league one"],"eng.4":["league two"],
    "esp.1":["laliga","la liga"],"esp.2":["laliga 2","segunda division"],
    "ita.1":["serie a"],"ita.2":["serie b"],"ita.3":["serie c"],
    "ger.1":["bundesliga"],"ger.2":["2. bundesliga"],"ger.3":["3. liga"],
    "fra.1":["ligue 1"],"fra.2":["ligue 2"],"fra.3":["championnat national"],"fra.4":["national 2"],
    "por.1":["primeira liga","liga portugal"],"por.2":["liga portugal 2"],"por.3":["liga 3"],
    "ned.1":["eredivisie"],"ned.2":["eerste divisie"],"ned.3":["tweede divisie"],
    "sco.1":["premiership"],"sco.2":["championship"],
    "gre.1":["super league greece","super league"],"gre.2":["super league 2"],
    "tur.1":["super lig","süper lig"],
    "bra.1":["serie a"],"bra.2":["serie b"],"arg.1":["liga profesional","primera division"],"arg.2":["primera nacional"],"arg.3":["primera b metropolitana"],
    "usa.1":["major league soccer","mls"],"usa.2":["usl championship"],"mex.1":["liga mx"],"aus.1":["a-league men","a-league"],
    "bel.1":["pro league"],"bel.2":["challenger pro league"],
    "aut.1":["bundesliga"],"aut.2":["2. liga"],
    "sui.1":["super league"],"den.1":["superliga"],"nor.1":["eliteserien"],"nor.2":["obos-ligaen"],"swe.1":["allsvenskan"],"swe.2":["superettan"],
    "pol.1":["ekstraklasa"],"jpn.1":["j1 league"],"kor.1":["k league 1"],"sau.1":["saudi pro league"],
    "irn.1":["persian gulf pro league","persian gulf league","iran pro league"],
    "irq.1":["iraqi stars league","iraq stars league","iraqi premier league"],
    "aze.1":["azerbaijan premier league","misli premier league","premyer liqa"],
    "arm.1":["armenian premier league","fastex premier league"],
    "int.ukrainian_youth":["ukrainian youth team championship","ukrainian youth championship"],
    "uefa.champions":["uefa champions league","champions league"],"uefa.europa":["uefa europa league","europa league"],
    "uefa.europa.conf":["uefa conference league","conference league"],"eng.fa":["fa cup"],"eng.league_cup":["efl cup","league cup"],
    "esp.copa_del_rey":["copa del rey"],"ita.coppa_italia":["coppa italia"],"ger.dfb_pokal":["dfb pokal"]
  };
  return aliases[code] || [];
}
function pitchSeasonForCode(code, year, seasons) {
  const calendar = ["bra.1","arg.1","usa.1","mex.1","aus.1","bra.2","arg.2","arg.3"].includes(code);
  const wanted = calendar ? String(year) : String(year)+"/"+String(year+1);
  const available = Array.isArray(seasons) ? seasons.map(String) : [];
  if (available.includes(wanted)) return wanted;
  if (available.includes(String(year-1)+"/"+String(year))) return String(year-1)+"/"+String(year);
  if (available.includes(String(year-1))) return String(year-1);
  if (available.length) return available[0];
  return wanted;
}
async function findPitchLeague(code) {
  const response = await pitchGet("/v1/leagues");
  const leagues = response?.data?.leagues || [];
  const aliases = pitchLeagueAliases(code);
  if (!aliases.length) return null;
  const normal = value => String(value||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  // Match a competition only when its normalized name matches an explicit alias.
  // Substring matching and falling back to the first result can silently map
  // unrelated leagues (e.g. Egypt's Premier League as England's Premier League).
  const candidates = leagues.filter(item => aliases.some(alias => normal(item.name) === normal(alias)));
  const country = code.split(".")[0];
  const countryCodes = {eng:["ENG","GB","GBR","UK"],esp:["ESP"],ita:["ITA"],ger:["DEU","GER","DE"],fra:["FRA"],por:["PRT","POR","PT"],ned:["NLD","NED","NL"],sco:["SCO","GB","GBR","UK"],gre:["GRC","GRE","GR"],tur:["TUR"],bra:["BRA"],arg:["ARG"],usa:["USA"],mex:["MEX"],aus:["AUS"],bel:["BEL"],aut:["AUT"],sui:["CHE","SUI","CH"],den:["DNK","DEN","DK"],nor:["NOR"],swe:["SWE"],pol:["POL"],jpn:["JPN"],kor:["KOR"],sau:["SAU"],irn:["IRN","IR"],irq:["IRQ","IQ"],aze:["AZE","AZ"],arm:["ARM","AM"],int:["INT","UKR","UA","UKRAINE"]};
  const allowed = countryCodes[country] || [];
  return candidates.find(item => allowed.includes(String(item.country_code || "").toUpperCase())) || null;
}
// Recent Dirty Sheet profile: share of the team's latest completed league matches in which it CONCEDED at least one goal.
// Missing history/provider data is neutral and never fabricated; cache per league for six hours.
const dirtySheetLeagueCache = new Map();
async function getDirtySheetSupport(leagueCode, homeName, awayName) {
  try {
    if (!leagueCode || !homeName || !awayName) return { support: 0, homeRate: null, awayRate: null, sample: 0 };
    const now = Date.now();
    let cached = dirtySheetLeagueCache.get(String(leagueCode));
    if (!cached || now - cached.at > 6 * 60 * 60 * 1000) {
      const league = await findPitchLeague(String(leagueCode));
      if (!league?.id) return { support: 0, homeRate: null, awayRate: null, sample: 0 };
      const year = new Date().getUTCFullYear();
      const season = pitchSeasonForCode(String(leagueCode), year, league.seasons);
      const response = await pitchGet("/v1/leagues/" + encodeURIComponent(league.id) + "/matches?season=" + encodeURIComponent(season) + "&status=all");
      const rows = response?.data?.matches || [];
      const norm = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const completed = rows.map(m => ({
        date: String(m.time_utc || m.date || ""), status: String(m.status || "").toLowerCase(),
        home: norm(m.home_team?.name), away: norm(m.away_team?.name),
        hs: Number(m.score_home), as: Number(m.score_away)
      })).filter(m => /finished|full.?time|\bft\b|ended/.test(m.status) && m.home && m.away && Number.isFinite(m.hs) && Number.isFinite(m.as));
      cached = { at: now, completed }; dirtySheetLeagueCache.set(String(leagueCode), cached);
    }
    const norm = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const rates = name => {
      const target = norm(name);
      const matches = cached.completed.filter(m => m.home === target || m.away === target).sort((a,b) => b.date.localeCompare(a.date)).slice(0, 10);
      if (matches.length < 5) return { rate: null, sample: matches.length };
      const conceded = matches.filter(m => m.home === target ? m.as > 0 : m.hs > 0).length;
      return { rate: conceded / matches.length, sample: matches.length };
    };
    const h = rates(homeName), a = rates(awayName);
    // Weight Dirty Sheet rates by the actual number of completed matches available for each team.
    // Small samples contribute less; unavailable history stays neutral and is never fabricated.
    const usable = [h,a].filter(x => x.rate != null && Number(x.sample) >= 5);
    const totalSample = usable.reduce((sum,x) => sum + Number(x.sample), 0);
    const avg = totalSample > 0 ? usable.reduce((sum,x) => sum + x.rate * Number(x.sample), 0) / totalSample : null;
    const support = avg == null ? 0 : avg >= 0.9 ? 2 : avg >= 0.8 ? 1.5 : avg >= 0.7 ? 1 : avg >= 0.6 ? 0.5 : 0;
    return { support, homeRate: h.rate, awayRate: a.rate, sample: Math.min(h.sample, a.sample) };
  } catch (error) {
    console.warn("Dirty Sheet history unavailable; neutral fallback:", String(error.message || error).slice(0,160));
    return { support: 0, homeRate: null, awayRate: null, sample: 0 };
  }
}
// Supporting historical Over profile for the exact live market line.
// Uses the same completed league-season cache as Dirty Sheet; small samples stay neutral.
async function getHistoricalOverSupport(leagueCode, homeName, awayName, targetLine) {
  try {
    const line = Number(targetLine);
    if (!leagueCode || !homeName || !awayName || !Number.isFinite(line)) {
      return { support: 0, homeRate: null, awayRate: null, homeSample: 0, awaySample: 0, line: Number.isFinite(line) ? line : null };
    }
    const cached = dirtySheetLeagueCache.get(String(leagueCode));
    if (!cached || !Array.isArray(cached.completed)) {
      return { support: 0, homeRate: null, awayRate: null, homeSample: 0, awaySample: 0, line };
    }
    const norm = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const profile = name => {
      const target = norm(name);
      const matches = cached.completed.filter(m => m.home === target || m.away === target)
        .sort((a,b) => b.date.localeCompare(a.date)).slice(0, 15);
      if (matches.length < 5) return { rate: null, sample: matches.length };
      const wins = matches.filter(m => (m.hs + m.as) > line).length;
      return { rate: wins / matches.length, sample: matches.length };
    };
    const home = profile(homeName), away = profile(awayName);
    const usable = [home, away].filter(x => x.rate != null && x.sample >= 5);
    const best = usable.length ? Math.max(...usable.map(x => x.rate)) : null;
    const support = best == null ? 0 : best >= 0.75 ? 2 : best >= 0.65 ? 1.5 : best >= 0.55 ? 1 : best >= 0.5 ? 0.5 : 0;
    return { support, homeRate: home.rate, awayRate: away.rate, homeSample: home.sample, awaySample: away.sample, line };
  } catch (error) {
    console.warn("Historical Over profile unavailable; neutral fallback:", String(error.message || error).slice(0,160));
    return { support: 0, homeRate: null, awayRate: null, homeSample: 0, awaySample: 0, line: Number.isFinite(Number(targetLine)) ? Number(targetLine) : null };
  }
}


// PRE-MATCH: free ESPN season-wide league history. This is isolated from live
// alert history and is strictly additive; missing data never changes live eligibility.
const preMatchSeasonProfileCache = new Map();
const preMatchSeasonCollectionAt = new Map();
const preMatchScanState = { status: "idle", startedAt: null, completedAt: null, results: [], error: null };

let preMatchSeasonDbInit = null;
const PRE_MATCH_PROFILE_TTL_MS = 12 * 60 * 60 * 1000;
function isPreMatchLeagueCode(code) {
  const value = String(code || "");
  if (!SCOREBOARD_LEAGUES.includes(value)) return false;
  if (/^(uefa|fifa|conmebol|concacaf|caf|afc|int)\./i.test(value)) return false;
  if (/(?:^|\.)(?:cup|copa|fa|league_cup|super_cup|tennents|cis)$/i.test(value)) return false;
  return true;
}
function preMatchNormalizeTeam(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
async function ensurePreMatchSeasonDb() {
  if (!analyticsPool) return false;
  if (!preMatchSeasonDbInit) preMatchSeasonDbInit = analyticsPool.query(`
    CREATE TABLE IF NOT EXISTS pre_match_season_profiles (
      league_code TEXT NOT NULL,
      season_key TEXT NOT NULL,
      team_key TEXT NOT NULL,
      team_name TEXT NOT NULL,
      profile JSONB NOT NULL,
      source TEXT NOT NULL DEFAULT 'ESPN public scoreboard',
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (league_code, season_key, team_key)
    );
    CREATE INDEX IF NOT EXISTS pre_match_season_profiles_fetched_idx
      ON pre_match_season_profiles(fetched_at DESC);
    CREATE TABLE IF NOT EXISTS pre_match_collection_state (
      league_code TEXT NOT NULL,
      season_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      last_success_at TIMESTAMPTZ,
      retry_after TIMESTAMPTZ,
      fixtures INTEGER NOT NULL DEFAULT 0,
      teams INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      source TEXT NOT NULL DEFAULT 'ESPN public scoreboard',
      PRIMARY KEY (league_code, season_key)
    );
  `).then(() => true).catch(error => {
    preMatchSeasonDbInit = null;
    console.warn("[Pre-Match] persistent profile store unavailable:", error.message);
    return false;
  });
  return preMatchSeasonDbInit;
}
function preMatchSeasonBounds(leagueCode, now = new Date()) {
  return seasonBoundsForLeague(leagueCode, now);
}
function preMatchScoreValue(value) {
  if (value && typeof value === "object") value = value.value ?? value.displayValue;
  const n = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function preMatchSeasonMonthKeys(startValue, endValue) {
  const start = new Date(Date.UTC(Number(String(startValue).slice(0,4)), Number(String(startValue).slice(4,6))-1, 1));
  const end = new Date(Date.UTC(Number(String(endValue).slice(0,4)), Number(String(endValue).slice(4,6))-1, 1));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return [];
  const months = [];
  for (let d = start; d <= end; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth()+1, 1))) months.push(String(d.getUTCFullYear()) + String(d.getUTCMonth()+1).padStart(2, "0"));
  return months;
}

async function collectPreMatchLeagueSeason(leagueCode, options = {}) {
  const code = String(leagueCode || "");
  if (!isPreMatchLeagueCode(code)) return { ok: false, reason: "unsupported-league" };
  const bounds = preMatchSeasonBounds(code);
  const cacheKey = code + "|" + bounds.seasonKey;
  const now = Date.now();
  const last = preMatchSeasonCollectionAt.get(cacheKey) || 0;
  if (!options.force && now - last < PRE_MATCH_PROFILE_TTL_MS) return { ok: true, cached: true, leagueCode: code, season: bounds.seasonKey };
  preMatchSeasonCollectionAt.set(cacheKey, now);
  const dbReadyAtStart = await ensurePreMatchSeasonDb();
  if (dbReadyAtStart) {
    await analyticsPool.query(
      `INSERT INTO pre_match_collection_state (league_code,season_key,status,started_at,completed_at,retry_after,last_error)
       VALUES ($1,$2,'running',NOW(),NULL,NULL,NULL)
       ON CONFLICT (league_code,season_key) DO UPDATE SET
       status='running',started_at=NOW(),completed_at=NULL,retry_after=NULL,last_error=NULL`,
      [code, bounds.seasonKey]
    ).catch(error => console.warn("[Pre-Match] collection state start write failed:", error.message));
  }
  try {
    const startYear = Number(bounds.start.slice(0,4));
    const monthRanges = preMatchSeasonMonthKeys(bounds.start, bounds.end);
    if (!monthRanges.length) throw new Error("Invalid ESPN season month range");
    const allEvents = [];
    // ESPN now accepts YYYYMM month selectors; date-range selectors return HTTP 400.
    // Keep month requests batched to avoid calendar-year response truncation.
    for (let offset = 0; offset < monthRanges.length; offset += 3) {
      const monthResults = await Promise.all(monthRanges.slice(offset, offset + 3).map(async month => {
        const url = "https://site.api.espn.com/apis/site/v2/sports/soccer/" + encodeURIComponent(code) +
          "/scoreboard?dates=" + month + "&limit=500";
        let response = await fetch(url, { headers: ESPN_HEADERS, signal: AbortSignal.timeout(25000) });
        if (response.status === 403 || response.status === 429 || response.status >= 500) {
          response = await fetch(url.replace("site.api.espn.com", "site.web.api.espn.com"),
            { headers: ESPN_HEADERS, signal: AbortSignal.timeout(25000) });
        }
        if (!response.ok) throw new Error("ESPN season-month HTTP " + response.status + " (" + month + ")");
        const body = await response.json();
        const rows = Array.isArray(body.events) ? body.events : [];
        if (rows.length >= 500) throw new Error("ESPN season-month response reached the 500-event safety cap (" + month + ")");
        return rows;
      }));
      allEvents.push(...monthResults.flat());
    }
    const expectedSeasonSlug = String(options.seasonSlug || "");
    const expectedSeasonYear = Number(options.seasonYear || startYear);
    // The month windows cover the exact season dates. Filter again by ESPN's
    // season slug/year so adjacent competitions or season spillover stay excluded.
    const events = allEvents.filter(event => {
      const actualSlug = String(event.season?.slug || "");
      if (expectedSeasonSlug) return actualSlug === expectedSeasonSlug;
      return Number(event.season?.year) === expectedSeasonYear;
    });
    const completed = new Map();
    for (const event of events) {
      const competition = Array.isArray(event.competitions) ? event.competitions[0] : null;
      const status = competition?.status?.type || event.status?.type || {};
      if (status.completed !== true && String(status.state || "").toLowerCase() !== "post") continue;
      const competitors = Array.isArray(competition?.competitors) ? competition.competitors : [];
      const home = competitors.find(side => String(side.homeAway || "").toLowerCase() === "home") || competitors[0];
      const away = competitors.find(side => side !== home) || competitors[1];
      if (!home?.team?.id || !away?.team?.id) continue;
      const homeGoals = preMatchScoreValue(home.score);
      const awayGoals = preMatchScoreValue(away.score);
      if (homeGoals == null || awayGoals == null) continue;
      const id = String(event.id || competition.id || "");
      if (!id || completed.has(id)) continue;
      completed.set(id, {
        id, date: String(event.date || ""), homeId: String(home.team.id), awayId: String(away.team.id),
        home: String(home.team.displayName || home.team.name || ""),
        away: String(away.team.displayName || away.team.name || ""),
        homeGoals, awayGoals
      });
    }
    const aggregates = new Map();
    const leagueOverCounts = Object.fromEntries(PRE_MATCH_OVER_LINES.map(line => [line, 0]));
    const emptyStats = () => ({
      matches: 0, goalsFor: 0, goalsAgainst: 0, cleanSheets: 0, failedToScore: 0,
      over: Object.fromEntries(PRE_MATCH_OVER_LINES.map(line => [line, 0]))
    });
    const ensure = (id, name) => {
      const key = preMatchNormalizeTeam(name);
      if (!key) return null;
      if (!aggregates.has(key)) aggregates.set(key, {
        teamId: String(id), teamName: String(name), ...emptyStats(),
        homeMatches: 0, awayMatches: 0,
        homeAway: { home: emptyStats(), away: emptyStats() },
        opponents: {}
      });
      return aggregates.get(key);
    };
    const updateStats = (target, goalsFor, goalsAgainst) => {
      target.matches++;
      target.goalsFor += goalsFor;
      target.goalsAgainst += goalsAgainst;
      if (goalsAgainst === 0) target.cleanSheets++;
      if (goalsFor === 0) target.failedToScore++;
      for (const line of PRE_MATCH_OVER_LINES) if (goalsFor + goalsAgainst > Number(line)) target.over[line]++;
    };
    const updateOpponent = (target, opponentName, goalsFor, goalsAgainst) => {
      const opponentKey = preMatchNormalizeTeam(opponentName);
      if (!opponentKey) return;
      if (!target.opponents[opponentKey]) target.opponents[opponentKey] = {
        teamName: String(opponentName), ...emptyStats(), wins: 0, draws: 0, losses: 0
      };
      const item = target.opponents[opponentKey];
      updateStats(item, goalsFor, goalsAgainst);
      if (goalsFor > goalsAgainst) item.wins++;
      else if (goalsFor === goalsAgainst) item.draws++;
      else item.losses++;
    };
    const finalizeStats = stats => ({
      ...stats,
      goalsForAvg: stats.matches ? Number((stats.goalsFor / stats.matches).toFixed(3)) : null,
      goalsAgainstAvg: stats.matches ? Number((stats.goalsAgainst / stats.matches).toFixed(3)) : null,
      cleanSheetRate: stats.matches ? Number((stats.cleanSheets / stats.matches).toFixed(4)) : null,
      failedToScoreRate: stats.matches ? Number((stats.failedToScore / stats.matches).toFixed(4)) : null,
      overRates: Object.fromEntries(Object.entries(stats.over).map(([line, count]) =>
        [line, stats.matches ? Number((count / stats.matches).toFixed(4)) : null]))
    });
    for (const match of completed.values()) {
      const total = match.homeGoals + match.awayGoals;
      const h = ensure(match.homeId, match.home), a = ensure(match.awayId, match.away);
      if (!h || !a) continue;
      updateStats(h, match.homeGoals, match.awayGoals);
      updateStats(a, match.awayGoals, match.homeGoals);
      h.homeMatches++; a.awayMatches++;
      updateStats(h.homeAway.home, match.homeGoals, match.awayGoals);
      updateStats(a.homeAway.away, match.awayGoals, match.homeGoals);
      updateOpponent(h, match.away, match.homeGoals, match.awayGoals);
      updateOpponent(a, match.home, match.awayGoals, match.homeGoals);
      for (const line of PRE_MATCH_OVER_LINES) if (total > Number(line)) leagueOverCounts[line]++;
    }
    const leagueOverRates = Object.fromEntries(PRE_MATCH_OVER_LINES.map(line =>
      [line, completed.size ? Number((leagueOverCounts[line] / completed.size).toFixed(4)) : null]
    ));
    if (!completed.size) throw new Error("ESPN returned no completed, score-validated fixtures for the selected season");
    const profiles = [];
    for (const [teamKey, value] of aggregates) {
      if (!value.matches) continue;
      const profile = {
        ...finalizeStats(value),
        homeAway: {
          home: finalizeStats(value.homeAway.home),
          away: finalizeStats(value.homeAway.away)
        },
        opponents: Object.fromEntries(Object.entries(value.opponents).map(([opponentKey, opponent]) =>
          [opponentKey, finalizeStats(opponent)])),
        leagueOverRates,
        profileVersion: 2,
        coverage: "provider-season-range",
        season: bounds.seasonKey,
        seasonSlug: expectedSeasonSlug || null,
        leagueCode: code,
        source: "ESPN public scoreboard",
        fixtureCount: completed.size,
        fetchedAt: new Date().toISOString()
      };
      const entry = { at: now, profile };
      preMatchSeasonProfileCache.set(code + "|" + bounds.seasonKey + "|" + teamKey, entry);
      profiles.push({ teamKey, teamName: value.teamName, profile });
    }
    if (!profiles.length) throw new Error("No valid team profiles could be built from the completed fixtures");
    const dbReady = await ensurePreMatchSeasonDb();
    if (dbReady && profiles.length) {
      const client = await analyticsPool.connect();
      try {
        await client.query("BEGIN");
        for (const item of profiles) {
          await client.query(
            `INSERT INTO pre_match_season_profiles (league_code,season_key,team_key,team_name,profile,source,fetched_at)
             VALUES ($1,$2,$3,$4,$5::jsonb,$6,NOW())
             ON CONFLICT (league_code,season_key,team_key) DO UPDATE SET
             team_name=EXCLUDED.team_name, profile=EXCLUDED.profile, source=EXCLUDED.source, fetched_at=NOW()`,
            [code, bounds.seasonKey, item.teamKey, item.teamName, JSON.stringify(item.profile), "ESPN public scoreboard"]
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { client.release(); }
    }
    const fetchedAt = new Date().toISOString();
    if (dbReady) {
      await analyticsPool.query(
        `INSERT INTO pre_match_collection_state
           (league_code,season_key,status,started_at,completed_at,last_success_at,retry_after,fixtures,teams,last_error,source)
         VALUES ($1,$2,'complete',NOW(),NOW(),NOW(),NULL,$3,$4,NULL,$5)
         ON CONFLICT (league_code,season_key) DO UPDATE SET
           status='complete',completed_at=NOW(),last_success_at=NOW(),retry_after=NULL,
           fixtures=EXCLUDED.fixtures,teams=EXCLUDED.teams,last_error=NULL,source=EXCLUDED.source`,
        [code, bounds.seasonKey, completed.size, profiles.length, "ESPN public scoreboard"]
      );
    }
    return {
      ok: true, leagueCode: code, season: bounds.seasonKey, source: "ESPN public scoreboard",
      fixtures: completed.size, teams: profiles.length, persisted: dbReady,
      coverage: expectedSeasonSlug ? "season-slug-filtered" : "season-year-filtered",
      fetchedAt
    };
  } catch (error) {
    // Back off on provider failures; persist the failure so a restart cannot trigger
    // an immediate retry storm. A failed refresh never overwrites valid team profiles.
    const retryAt = Date.now() + 30 * 60 * 1000;
    preMatchSeasonCollectionAt.set(cacheKey, retryAt - PRE_MATCH_PROFILE_TTL_MS);
    if (await ensurePreMatchSeasonDb()) {
      await analyticsPool.query(
        `INSERT INTO pre_match_collection_state
           (league_code,season_key,status,started_at,completed_at,retry_after,last_error)
         VALUES ($1,$2,'error',NOW(),NOW(),TO_TIMESTAMP($3 / 1000.0),$4)
         ON CONFLICT (league_code,season_key) DO UPDATE SET
           status='error',completed_at=NOW(),retry_after=EXCLUDED.retry_after,last_error=EXCLUDED.last_error`,
        [code, bounds.seasonKey, retryAt, String(error.message || error).slice(0, 500)]
      ).catch(stateError => console.warn("[Pre-Match] collection failure state write failed:", stateError.message));
    }
    console.warn("[Pre-Match] season collection unavailable for", code, error.message);
    return { ok: false, leagueCode: code, season: bounds.seasonKey, reason: "provider-unavailable", error: String(error.message || error).slice(0, 240) };
  }
}
async function getPreMatchSeasonProfile(leagueCode, teamName) {
  const code = String(leagueCode || "");
  const bounds = preMatchSeasonBounds(code);
  const teamKey = preMatchNormalizeTeam(teamName);
  if (!code || !teamKey) return null;
  const key = code + "|" + bounds.seasonKey + "|" + teamKey;
  const cached = preMatchSeasonProfileCache.get(key);
  if (cached?.profile && Date.now() - Number(cached.at || 0) < PRE_MATCH_PROFILE_TTL_MS) return cached.profile;
  if (await ensurePreMatchSeasonDb()) {
    try {
      const result = await analyticsPool.query(
        "SELECT profile FROM pre_match_season_profiles WHERE league_code=$1 AND season_key=$2 AND team_key=$3",
        [code, bounds.seasonKey, teamKey]
      );
      if (result.rows?.[0]?.profile) {
        const profile = result.rows[0].profile;
        preMatchSeasonProfileCache.set(key, { at: Date.now(), profile });
        return profile;
      }
    } catch (error) {
      console.warn("[Pre-Match] profile read unavailable:", error.message);
    }
  }
  return null;
}
async function getPreMatchSeasonSupport(leagueCode, homeName, awayName, targetLine) {
  const line = Number(targetLine);
  const neutral = { support: 0, homeRate: null, awayRate: null, homeSample: 0, awaySample: 0, season: null, context: null };
  if (!Number.isFinite(line)) return neutral;
  const [home, away] = await Promise.all([
    getPreMatchSeasonProfile(leagueCode, homeName), getPreMatchSeasonProfile(leagueCode, awayName)
  ]);
  const context = buildPreMatchMatchupContext(home, away, homeName, awayName);
  const rateFor = profile => profile?.overRates?.[String(line)] ?? null;
  const hr = rateFor(home), ar = rateFor(away);
  // Preserve the existing Over-only support score exactly. New metrics are
  // captured as transparent context for shadow evaluation, not trigger gates.
  const support = (hr != null && hr >= 0.65 ? 0.5 : 0) + (ar != null && ar >= 0.65 ? 0.5 : 0);
  return {
    support, homeRate: hr, awayRate: ar,
    homeSample: Number(home?.matches || 0), awaySample: Number(away?.matches || 0),
    season: home?.season || away?.season || null,
    context: context && (home || away) ? context : null
  };
}
async function schedulePreMatchSeasonCollection(events) {
  if (!Array.isArray(events) || !events.length) return { attempted: 0, skipped: 0, results: [] };
  const leagues = [...new Set(events.map(event => String(event.__goalPulseLeagueCode || "")).filter(code => isPreMatchLeagueCode(code)))];
  const candidates = leagues.map(code => {
    const leagueEvents = events.filter(event => String(event.__goalPulseLeagueCode || "") === code);
    const seasonEvent = leagueEvents.find(event => event.season?.slug || event.season?.year) || leagueEvents[0];
    const bounds = preMatchSeasonBounds(code);
    const seasonFilter = seasonEventFilterForLeague(code, seasonEvent);
    return {
      code, ...seasonFilter,
      seasonKey: bounds.seasonKey, key: code + "|" + bounds.seasonKey
    };
  });
  const persisted = new Map();
  if (await ensurePreMatchSeasonDb()) {
    const states = await analyticsPool.query(
`SELECT league_code,season_key,status,last_success_at,retry_after,
              EXISTS (
                SELECT 1 FROM pre_match_season_profiles p
                 WHERE p.league_code=pre_match_collection_state.league_code
                   AND p.season_key=pre_match_collection_state.season_key
                   AND p.profile->>'profileVersion'='2'
              ) AS profile_v2
         FROM pre_match_collection_state
        WHERE league_code = ANY($1::text[])`,
      [candidates.map(item => item.code)]
    ).catch(error => {
      console.warn("[Pre-Match] collection state read failed:", error.message);
      return { rows: [] };
    });
    for (const row of states.rows || []) persisted.set(row.league_code + "|" + row.season_key, row);
  }
  const now = Date.now();
  const due = [];
  let skipped = 0;
  for (const item of candidates) {
    const state = persisted.get(item.key);
    const successAt = state?.last_success_at ? new Date(state.last_success_at).getTime() : 0;
    const retryAt = state?.retry_after ? new Date(state.retry_after).getTime() : 0;
    const memoryAt = preMatchSeasonCollectionAt.get(item.key) || 0;
    const fresh = successAt > 0 && now - successAt < PRE_MATCH_PROFILE_TTL_MS && state?.profile_v2 === true;
    const coolingDown = retryAt > now;
    const collecting = state?.status === "running";
    const memoryFresh = !state && memoryAt > 0 && now - memoryAt < PRE_MATCH_PROFILE_TTL_MS;
    if (fresh || coolingDown || collecting || memoryFresh) { skipped++; continue; }
    due.push(item);
  }
  // Keep provider load bounded: two league jobs at a time, at most three month requests per job.
  // Persisted state makes the 12-hour refresh window survive service restarts.
  const results = [];
  for (let offset = 0; offset < due.length; offset += 2) {
    const batch = await Promise.all(due.slice(offset, offset + 2).map(item =>
      collectPreMatchLeagueSeason(item.code, { seasonSlug: item.seasonSlug, seasonYear: item.seasonYear }).catch(error => {
        console.warn("[Pre-Match] collection task failed for", item.code, error.message);
        return { ok: false, leagueCode: item.code, reason: "collection-failed", error: String(error.message || error).slice(0, 240) };
      })
    ));
    results.push(...batch);
  }
  return { attempted: due.length, skipped, results };
}

function getAthensDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Athens", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const part = type => parts.find(item => item.type === type)?.value || "";
  return part("year") + part("month") + part("day");
}
let preMatchDailyScanDate = "";
let preMatchDailyRetryAt = 0;
let preMatchDailyScanRunning = false;
async function runScheduledPreMatchCollection() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Athens", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const hour = Number(parts.find(part => part.type === "hour")?.value);
  if (!Number.isFinite(hour) || hour < 6) return { skipped: "before-daily-scan-time" };
  const date = getAthensDateKey();
  if (preMatchDailyScanRunning || preMatchScanState.status === "running" || preMatchDailyScanDate === date || Date.now() < preMatchDailyRetryAt) {
    return { skipped: "already-running-or-run-or-retrying" };
  }
  preMatchDailyScanRunning = true;
  preMatchScanState.status = "running";
  preMatchScanState.startedAt = new Date().toISOString();
  preMatchScanState.completedAt = null;
  preMatchScanState.results = [];
  preMatchScanState.error = null;
  try {
    const response = await fetch("http://127.0.0.1:" + PORT + "/api/scoreboard?date=" + date, {
      headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(90000)
    });
    if (!response.ok) throw new Error("Daily scoreboard unavailable: HTTP " + response.status);
    const scoreboard = await response.json();
    const events = (scoreboard.feeds || []).flatMap(feed =>
      (feed.events || []).map(event => ({ ...event, __goalPulseLeagueCode: feed.code || "" }))
    );
    const result = await schedulePreMatchSeasonCollection(events);
    preMatchDailyScanDate = date;
    preMatchDailyRetryAt = 0;
    preMatchScanState.status = "complete";
    preMatchScanState.completedAt = new Date().toISOString();
    preMatchScanState.results = result.results || [];
    preMatchScanState.skipped = Number(result.skipped || 0);
    preMatchScanState.error = result.attempted === 0 && result.skipped === 0
      ? "No supported league fixtures were found in today's scoreboard."
      : null;
    console.log("[Pre-Match] scheduled daily scan completed:", JSON.stringify({
      date, scheduledFixtures: events.length,
      supportedLeagues: [...new Set(events.map(event => event.__goalPulseLeagueCode).filter(isPreMatchLeagueCode))].length,
      attempted: result.attempted, skipped: result.skipped,
      successful: result.results.filter(item => item.ok).length,
      failed: result.results.filter(item => !item.ok).length
    }));
    return result;
  } catch (error) {
    preMatchDailyRetryAt = Date.now() + 15 * 60 * 1000;
    preMatchScanState.status = "error";
    preMatchScanState.completedAt = new Date().toISOString();
    preMatchScanState.error = String(error.message || error).slice(0, 240);
    console.warn("[Pre-Match] scheduled daily scan failed; will retry:", String(error.message || error).slice(0, 180));
    throw error;
  } finally {
    preMatchDailyScanRunning = false;
  }
}

async function pitchGet(apiPath) {
  const key = process.env.PITCH_API_KEY;
  if (!key) {
    const error = new Error("PITCH_API_KEY is not configured");
    error.status = 503;
    throw error;
  }
  const cached = cache.get(apiPath);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.body;

  let sharedRequest = pitchInflight.get(apiPath);
  if (!sharedRequest) {
    sharedRequest = (async () => {
      const response = await fetch(API_BASE + apiPath, {
        headers: { "X-API-KEY": key, "Accept": "application/json" },
        signal: AbortSignal.timeout(12000)
      });
      const raw = await response.text();
      let body;
      try { body = JSON.parse(raw); } catch { body = { error: { message: "Invalid response from football data provider" } }; }
      if (!response.ok) {
        const error = new Error(body?.error?.message || "Football data provider error");
        error.status = response.status;
        error.code = body?.error?.code;
        throw error;
      }
      cache.set(apiPath, { at: Date.now(), body });
      if (cache.size > 200) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) cache.delete(oldestKey);
      }
      return body;
    })();
    pitchInflight.set(apiPath, sharedRequest);
  }
  try {
    return await sharedRequest;
  } finally {
    if (pitchInflight.get(apiPath) === sharedRequest) pitchInflight.delete(apiPath);
  }
}


const ODDS_PAPI_BASE = "https://api.oddspapi.io/v4";
// Accept common existing Render secret names, while keeping OddsPapi authentication server-side.
function getOddsPapiApiKey() {
  return process.env.ODDSPAPI_API_KEY || process.env.ODDSPAPI_KEY || process.env.ODDS_PAPI_API_KEY || process.env.ODDS_API_KEY || "";
}
const oddsPapiCache = new Map();
let oddsPapiBlockedUntil = 0;
let oddsPapiBlockedStatus = 0;
const normalizeOddsTeam = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
async function oddsPapiGet(pathname, params = {}, ttlMs = 15000) {
  const apiKey = getOddsPapiApiKey();
  if (!apiKey || Date.now() < oddsPapiBlockedUntil) return null;
  const query = new URLSearchParams({ ...params, apiKey });
  const cacheKey = pathname + "?" + query.toString().replace(/apiKey=[^&]+/, "apiKey=[redacted]");
  const cached = oddsPapiCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ttlMs) return cached.body;
  const response = await fetch(ODDS_PAPI_BASE + "/" + pathname + "?" + query.toString(), {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(9000)
  });
  if (!response.ok) {
    // Capture a short, sanitized provider error so 403s can be diagnosed as key,
    // account-plan, endpoint-access, or other provider-side failures.
    const providerErrorText = (await response.text().catch(() => "")).replace(/apiKey=[^&\s"'<>]+/gi, "apiKey=[redacted]").replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [redacted]").slice(0, 300);
    // Avoid hammering the provider after rate-limit or access-denied responses.
    // Unverified odds remain suppressed; retry only after a cooldown.
    if (response.status === 429 || response.status === 403) {
      oddsPapiBlockedStatus = response.status;
      oddsPapiBlockedUntil = Date.now() + (response.status === 429 ? 5 * 60 * 1000 : 15 * 60 * 1000);
      console.warn("OddsPapi temporarily paused after HTTP " + oddsPapiBlockedStatus + "; retrying after cooldown; provider detail: " + (providerErrorText || "empty response"));
      return null;
    }
    const error = new Error("OddsPapi HTTP " + response.status + (providerErrorText ? ": " + providerErrorText : ""));
    error.status = response.status;
    throw error;
  }
  const body = await response.json();
  oddsPapiCache.set(cacheKey, { at: Date.now(), body });
  if (oddsPapiCache.size > 100) oddsPapiCache.delete(oddsPapiCache.keys().next().value);
  return body;
}
// Odds are optional for Goal Pulse alerts; never block an alert solely because odds are unavailable.
function minimumLiveAlertOdds() {
  return 0;
}
async function getVerifiedOverOddsPapi(match, targetLine, period = "first_half") {
  if (!getOddsPapiApiKey()) return null;
  const line = Number(targetLine);
  if (!Number.isFinite(line) || line < 0.5 || Math.abs(line * 2 - Math.round(line * 2)) > 0.001) return null;
  // Use a stable, hour-aligned fixture window so identical live scans share the cache
  // instead of generating a fresh from/to query (and API request) for every candidate.  const hourMs = 60 * 60 * 1000;
  const windowBase = Math.floor(Date.now() / hourMs) * hourMs;
  const from = new Date(windowBase - 12 * hourMs).toISOString();
  const to = new Date(windowBase + 13 * hourMs).toISOString();
  // Keep the query window below the API 48-hour limit and reuse the live-fixture list.
  const fixtures = await oddsPapiGet("fixtures", { sportId: "10", from, to, statusId: "1" }, 60 * 1000);
  if (!Array.isArray(fixtures)) return null;
  const home = normalizeOddsTeam(match.home || match.homeTeam || match.teams?.[0]?.name);
  const away = normalizeOddsTeam(match.away || match.awayTeam || match.teams?.[1]?.name);
  if (!home || !away) return null;
  const teamAliases = value => [...new Set([
    value?.home, value?.homeTeam, value?.participant1Name, value?.participant1ShortName,
    value?.away, value?.awayTeam, value?.participant2Name, value?.participant2ShortName
  ].filter(Boolean).map(normalizeOddsTeam).filter(Boolean))];
  const sourceHomeAliases = [...new Set([match.home, match.homeTeam, match.teams?.[0]?.name].filter(Boolean).map(normalizeOddsTeam))];
  const sourceAwayAliases = [...new Set([match.away, match.awayTeam, match.teams?.[1]?.name].filter(Boolean).map(normalizeOddsTeam))];
  // Match provider team aliases safely: exact aliases first, then only when all
  // meaningful tokens of the shorter name occur in the longer name. This handles
  // prefixes such as "FK"/"FC" and expanded club names without matching one vague token.
  const meaningfulTeamTokens = value => normalizeOddsTeam(value)
    .split(/\s+/)
    .filter(token => token && !/^(fc|fk|sc|ac|cf|cd|ud|afc|club|football|soccer|the)$/.test(token));
  const teamNamesMatch = (left, right) => {
    const a = meaningfulTeamTokens(left);
    const b = meaningfulTeamTokens(right);
    if (!a.length || !b.length) return false;
    if (a.join(" ") === b.join(" ")) return true;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    if (shorter.some(token => token.length < 4)) return false;
    if (shorter.length === 1 && shorter[0].length < 7) return false;
    return shorter.every(token => longer.includes(token));
  };
  const fixture = fixtures.find(item => {
    const status = String(item.statusName || "").toLowerCase();
    if (!/in.play|live|1st half|first half|half.time|2nd half|second half/.test(status)) return false;
    const fixtureHomeAliases = [item.participant1Name, item.participant1ShortName, item.participant1Abbr].filter(Boolean);
    const fixtureAwayAliases = [item.participant2Name, item.participant2ShortName, item.participant2Abbr].filter(Boolean);
    return sourceHomeAliases.some(name => fixtureHomeAliases.some(alias => teamNamesMatch(name, alias))) &&
      sourceAwayAliases.some(name => fixtureAwayAliases.some(alias => teamNamesMatch(name, alias)));
  });
  if (!fixture || !fixture.fixtureId || fixture.statusName === "Ended") {
    console.warn("OddsPapi fixture match missing:", JSON.stringify({
      home, away, fixturesReturned: fixtures.length,
      liveFixtures: fixtures.filter(item => /in.play|live|1st half|first half|half.time|2nd half|second half/i.test(String(item.statusName || ""))).length,
      sample: fixtures.slice(0, 4).map(item => ({home: item.participant1Name, homeShort: item.participant1ShortName, away: item.participant2Name, awayShort: item.participant2ShortName, status: item.statusName}))
    }));
    return null;
  }
  const [markets, odds] = await Promise.all([
    oddsPapiGet("markets", { language: "en" }, 6 * 60 * 60 * 1000),
    oddsPapiGet("odds", { fixtureId: fixture.fixtureId, oddsFormat: "decimal" }, 12000)
  ]);
  if (!Array.isArray(markets) || !odds || !odds.bookmakerOdds) {
    console.warn("OddsPapi odds payload missing:", JSON.stringify({
      home, away, fixtureId: fixture.fixtureId, hasMarkets: Array.isArray(markets),
      marketCount: Array.isArray(markets) ? markets.length : null,
      oddsReturned: Boolean(odds), hasBookmakerOdds: Boolean(odds?.bookmakerOdds),
      hasOdds: fixture.hasOdds ?? odds?.hasOdds ?? null
    }));
    return null;
  }
  const isFirstHalf = period !== "second_half";
  const matchingMarkets = markets.filter(m => {
    if (Number(m.sportId) !== 10 || Math.abs(Number(m.handicap) - line) >= 0.001 || String(m.marketType || "").toLowerCase() !== "totals") return false;
    const marketName = String(m.marketName || "");
    const normalizedPeriod = String(m.period || "").toLowerCase().replace(/[_ -]/g, "");
    if (/asian/i.test(marketName) || /asian/i.test(normalizedPeriod)) return false;
    if (isFirstHalf) return /over.?under.*first half|first half.*over.?under/i.test(marketName) && normalizedPeriod.includes("firsthalf");
    // In the second half, recommend only non-Asian full-match totals, settled at full time.
    return !/first half|second half|asian/i.test(marketName) && !normalizedPeriod.includes("firsthalf") && !normalizedPeriod.includes("secondhalf") && /(fulltime|fullmatch|match|regular time|ft)/i.test(normalizedPeriod);
  });
  if (!matchingMarkets.length) {
    console.warn("OddsPapi target market missing:", JSON.stringify({
      home, away, fixtureId: fixture.fixtureId, period, targetLine: line,
      marketCount: markets.length,
      totalsSamples: markets.filter(m => Number(m.sportId) === 10 && String(m.marketType || "").toLowerCase() === "totals").slice(0, 12).map(m => ({
        marketId: m.marketId, marketName: m.marketName, period: m.period, handicap: m.handicap,
        outcomes: (m.outcomes || []).map(o => o.outcomeName)
      }))
    }));
    return null;
  }
  const valid = [];
  for (const [bookmaker, board] of Object.entries(odds.bookmakerOdds)) {
    if (board?.bookmakerIsActive === false || board?.suspended === true) continue;
    for (const marketDef of matchingMarkets) {      const market = board?.markets?.[String(marketDef.marketId)];      if (!market || market.marketActive === false) continue;
      for (const [outcomeId, outcome] of Object.entries(market.outcomes || {})) {
        const definition = (marketDef.outcomes || []).find(o => String(o.outcomeId) === String(outcomeId));
        if (!/over/i.test(String(definition?.outcomeName || ""))) continue;
        const player = outcome?.players?.["0"];
        const price = Number(player?.price);
        if (!player?.active || !Number.isFinite(price) || price <= 1.0) continue;
        // changedAt records the last price movement, not feed freshness; an unchanged active quote remains valid.
        const changedAt = Date.parse(player.changedAt || player.bookmakerChangedAt || "");
        valid.push({ price, bookmaker, line: Number(marketDef.handicap), changedAt: Number.isFinite(changedAt) ? changedAt : null });
      }
    }
  }
  valid.sort((a, b) => b.price - a.price);
  if (!valid.length) {
    console.warn("OddsPapi target market has no valid active Over quote:", JSON.stringify({
      home, away, fixtureId: fixture.fixtureId, period, targetLine: line,
      matchingMarkets: matchingMarkets.map(m => ({marketId: m.marketId, marketName: m.marketName, period: m.period, handicap: m.handicap})),
      bookmakerCount: Object.keys(odds.bookmakerOdds || {}).length,
      sampleBookmakers: Object.entries(odds.bookmakerOdds || {}).slice(0, 3).map(([name, board]) => ({
        name, active: board?.bookmakerIsActive, marketKeys: Object.keys(board?.markets || {}).slice(0, 8)
      }))
    }));
  }
  return valid[0] || null;
}


const API_FOOTBALL_BASE = "https://apiv3.apifootball.com/";
const apiFootballOddsCache = { at: 0, body: null };
function getApiFootballKey() {
  return process.env.APIFOOTBALL_API_KEY || process.env.API_FOOTBALL_API_KEY || "";
}
async function getVerifiedOverApiFootball(match, targetLine, period = "first_half") {
  const apiKey = getApiFootballKey();
  const line = Number(targetLine);
  if (!apiKey || !Number.isFinite(line) || line < 0.5) return null;
  try {
    let events = apiFootballOddsCache.body;
    if (!events || Date.now() - apiFootballOddsCache.at > 12000) {
      const url = new URL(API_FOOTBALL_BASE);
      url.searchParams.set("action", "get_live_odds_commnets");
      url.searchParams.set("APIkey", apiKey);
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(9000) });
      if (!response.ok) throw new Error("APIfootball live odds HTTP " + response.status);
      events = await response.json();
      apiFootballOddsCache.at = Date.now();
      apiFootballOddsCache.body = events;
      const sample = Array.isArray(events) ? events[0] : Object.values(events || {})[0];
      console.info("APIfootball live odds feed fetched:", JSON.stringify({
        responseType: Array.isArray(events) ? "array" : typeof events,
        eventCount: Array.isArray(events) ? events.length : Object.keys(events || {}).length,
        sampleFields: sample && typeof sample === "object" ? Object.keys(sample).slice(0, 24) : [],
        sampleHasLiveOdds: Array.isArray(sample?.live_odds),
        sampleLeague: sample?.league_name || sample?.country_name || null,
        sampleOdds: Array.isArray(sample?.live_odds) ? sample.live_odds.slice(0, 4).map(odd => ({
          keys: Object.keys(odd || {}).slice(0, 20),
          odd_name: odd?.odd_name || null,
          type: odd?.type || null,
          handicap: odd?.handicap || null,
          valuePresent: odd?.value != null || odd?.odds != null || odd?.price != null,
          updatedFieldPresent: odd?.upd != null || odd?.updated_at != null || odd?.odd_date != null,
          bookmakerPresent: odd?.bookmaker != null || odd?.odd_bookmakers != null
        })) : []
      }));
    }
    const rows = Array.isArray(events) ? events : Object.values(events || {});
    const norm = value => normalizeOddsTeam(value);
    const tokens = value => norm(value).split(/\s+/).filter(t => t && !/^(fc|fk|sc|ac|cf|cd|ud|afc|club|football|the)$/.test(t));
    const namesMatch = (a, b) => {
      const x = tokens(a), y = tokens(b);
      if (!x.length || !y.length) return false;
      if (x.join(" ") === y.join(" ")) return true;
      const short = x.length <= y.length ? x : y, long = x.length <= y.length ? y : x;
      return !short.some(t => t.length < 4) && !(short.length === 1 && short[0].length < 7) && short.every(t => long.includes(t));
    };
    const home = match.home || match.homeTeam || match.teams?.[0]?.name;
    const away = match.away || match.awayTeam || match.teams?.[1]?.name;
    const fixture = rows.find(row =>
      namesMatch(home, row.match_hometeam_name || row.home_team) &&
      namesMatch(away, row.match_awayteam_name || row.away_team)
    );
    if (!fixture || !Array.isArray(fixture.live_odds)) return null;
    const firstHalf = period !== "second_half";
    const candidates = fixture.live_odds.filter(odd => {
      const market = String(odd.odd_name || odd.market || "").toLowerCase();
      const type = String(odd.type || odd.name || "").toLowerCase();
      const label = market + " " + type;
      if (!/over|total goals|total.*goal|goals total/.test(label)) return false;
      if (!/^over\b/.test(type) && !/\bover\s*\d/.test(market)) return false;
      const periodMarked = /first half|1st half|half 1|half-time|halftime/.test(label);
      if (firstHalf !== periodMarked) return false;
      const handicapText = String(odd.handicap ?? "").trim();
      const parsed = handicapText ? Number(handicapText.replace(/^over\s*/i, "")) : NaN;
      const typeLine = type.match(/over\s*(\d+(?:\.\d+)?)/i);
      const marketLine = market.match(/over\s*(\d+(?:\.\d+)?)/i);
      const actualLine = Number.isFinite(parsed) ? parsed : Number(typeLine?.[1] || marketLine?.[1]);
      if (!Number.isFinite(actualLine) || Math.abs(actualLine - line) > 0.001) return false;
      if (/yes|suspend|inactive/.test(String(odd.suspended || "").toLowerCase())) return false;
      const price = Number(odd.value ?? odd.odds ?? odd.price);
      if (!Number.isFinite(price) || price <= 1) return false;
      const updated = Date.parse(String(odd.upd || odd.updated_at || odd.odd_date || ""));
      if (!Number.isFinite(updated) || Date.now() - updated > 5 * 60 * 1000 || updated > Date.now() + 60 * 1000) return false;
      return true;
    });
    if (!candidates.length) return null;
    const best = candidates.sort((a,b) => Number(b.value ?? b.odds ?? b.price) - Number(a.value ?? a.odds ?? a.price))[0];
    return {
      price: Number(best.value ?? best.odds ?? best.price),
      line,
      bookmaker: String(best.bookmaker || best.odd_bookmakers || "APIfootball live market"),
      provider: "APIfootball",
      verifiedAt: new Date().toISOString()
    };
  } catch (error) {
    console.warn("APIfootball live odds fallback unavailable:", String(error.message || error).slice(0, 220));
    return null;
  }
}
async function getVerifiedOver(match, targetLine, period = "first_half") {
  const primary = await getVerifiedOverOddsPapi(match, targetLine, period);
  if (primary) return primary;
  return getVerifiedOverApiFootball(match, targetLine, period);
}

const ALLOWED_ORIGINS = new Set([
  "https://goal-pulse.onrender.com",
  "https://goalmatrix-live.onrender.com",
  "https://goal-pulse.vibenest.net",
  "https://goal-pulse-live-2026-2.onrender.com",
  "https://nikosvretos28-commits.github.io",
  "https://goalmatrix-production.up.railway.app"
]);

function isAllowedOrigin(value) {
  if (ALLOWED_ORIGINS.has(value || "")) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" &&
      (parsed.hostname === "vibenest.net" || parsed.hostname.endsWith(".vibenest.net"));
  } catch {
    return false;
  }
}

function isAllowedRequestOrigin(req) {
  const origin = req.headers.origin;
  if (origin) return isAllowedOrigin(origin);
  // Browsers commonly omit Origin on same-origin GET requests. Accept that case
  // only when the HTTPS Referer host matches this request's Host header.
  const referer = req.headers.referer || "";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase();
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  try {
    const parsed = new URL(referer);
    // The platform may terminate TLS at its edge and omit forwarded-proto
    // on internal requests. An HTTPS Referer matching the effective request host
    // is sufficient for this same-origin fallback.
    return parsed.protocol === "https:" &&
      parsed.host.toLowerCase() === host &&
      isAllowedOrigin(parsed.origin);
  } catch {
    return false;
  }
}
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Cache-Control");
  }
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, "http://localhost");
  if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { error: "Method not allowed" });

  if (url.pathname === "/api/public-config" && req.method === "GET") {
    return send(res, 200, { previewUnlock: GOALMATRIX_PREVIEW_UNLOCK });
  }

  if (url.pathname === "/api/power-games/access" && req.method === "POST") {
    if (!isAllowedRequestOrigin(req)) return send(res, 403, { error: "Origin not allowed" });
    if (!POWER_GAMES_ADMIN_PIN) return send(res, 503, { error: "Power Games admin access is not configured" });
    const ip = String(req.socket?.remoteAddress || "unknown").slice(0, 100);
    const now = Date.now();
    const attempt = powerGamesAuthAttempts.get(ip) || { count: 0, since: now, blockedUntil: 0 };
    if (attempt.blockedUntil > now) return send(res, 429, { error: "Too many attempts" });
    if (now - attempt.since > 10 * 60 * 1000) { attempt.count = 0; attempt.since = now; attempt.blockedUntil = 0; }
    try {
      const body = await readJsonBody(req, 4096);
      const supplied = String(body.pin || "");
      if (supplied !== POWER_GAMES_ADMIN_PIN) {
        attempt.count += 1;
        if (attempt.count >= 8) attempt.blockedUntil = now + 10 * 60 * 1000;
        powerGamesAuthAttempts.set(ip, attempt);
        return send(res, attempt.blockedUntil > now ? 429 : 401, { ok: false, error: "Invalid admin PIN" });
      }
      powerGamesAuthAttempts.delete(ip);
      return send(res, 200, { ok: true });
    } catch (error) {
      return send(res, 400, { ok: false, error: "Invalid request" });
    }
  }

  if (url.pathname === "/api/alerts/history/verify" && req.method === "GET") {
    // Read-only audit: allow direct navigation when both Origin and Referer are absent.\n    // If either header is present, it must still match the allowlist.\n    if ((req.headers.origin || req.headers.referer) && !isAllowedRequestOrigin(req)) return send(res, 403, { error: "Origin not allowed" });
    if (!await ensureAlertHistoryDb()) return send(res, 503, { error: "Persistent alert history database unavailable" });
    try {
      // Read-only integrity audit: it never edits or settles alerts.
      const result = await analyticsPool.query(
        "SELECT alert_id, event_id, created_at, payload FROM alert_history WHERE payload->>'source'='server-push' AND COALESCE(payload->>'level','AI')='AI' AND created_at > NOW() - INTERVAL '180 days' ORDER BY created_at DESC LIMIT 10000"
      );
      const rows = result.rows.map(row => ({ id: row.alert_id, eventId: row.event_id, createdAt: row.created_at, payload: row.payload || {} }));
      const terminal = rows.filter(row => ['won','lost','push','void'].includes(String(row.payload.betOutcome || '').toLowerCase()));
      const isVerifiedSettlement = payload => {
        const scope = String(payload.betScoreScope || "");
        const score = String(payload.betFinalScore || "").match(/^(\d+)\s*-\s*(\d+)$/);
        if (!score || !payload.betSettlementProvider || !payload.betSettlementFixtureId) return false;
        if (scope === "first_half") return Boolean(payload.betHalfTimeScore) && String(payload.betHalfTimeScore) === String(payload.betFinalScore);
        return scope === "full_time";
      };
      const verifiedTerminal = terminal.filter(row => isVerifiedSettlement(row.payload));
      const unverifiedTerminal = terminal.length - verifiedTerminal.length;
      const pending = rows.filter(row => !['won','lost','push','void'].includes(String(row.payload.betOutcome || '').toLowerCase()));
      const signalMinute = payload => {
        const raw = payload.minuteNumber !== null && payload.minuteNumber !== undefined && String(payload.minuteNumber).trim() !== ""
          ? payload.minuteNumber : String(payload.minute || "").match(/\d{1,3}/)?.[0];
        const value = Number(raw);
        if (Number.isFinite(value)) return value;
        const fallback = Number(String(raw ?? "").match(/\d{1,3}/)?.[0]);
        return Number.isFinite(fallback) ? fallback : null;
      };
      const summarizeSignalWindow = (period, minMinute, maxMinute, label) => {
        const sample = rows.filter(row => row.payload.periodAtSignal === period && signalMinute(row.payload) !== null
          && signalMinute(row.payload) >= minMinute && signalMinute(row.payload) <= maxMinute);
        const verified = sample.filter(row => isVerifiedSettlement(row.payload));
        const unverified = sample.filter(row => ['won','lost','push','void'].includes(String(row.payload.betOutcome || '').toLowerCase()) && !isVerifiedSettlement(row.payload)).length;
        const outcomes = verified.map(row => String(row.payload.betOutcome || "pending").toLowerCase());
        const wins = outcomes.filter(value => value === "won").length;
        const losses = outcomes.filter(value => value === "lost").length;
        const pushes = outcomes.filter(value => value === "push").length;
        const voids = outcomes.filter(value => value === "void").length;
        const settled = wins + losses;
        return { window: label, total: sample.length, settled, wins, losses, unverified,
          pending: sample.length - verified.length - unverified, pushes, voids,
          successRate: settled ? Math.round(wins / settled * 1000) / 10 : null };
      };
      const bySignalWindow = [
        summarizeSignalWindow("first_half", 35, 40, "1ο ημίχρονο 35′–40′"),
        summarizeSignalWindow("second_half", 76, 88, "2ο ημίχρονο 76′–88′")
      ];
      const byOutcome = {};
      const byPeriod = {};
      for (const row of terminal) {
        const outcome = String(row.payload.betOutcome || 'unknown').toLowerCase();
        byOutcome[outcome] = (byOutcome[outcome] || 0) + 1;
      }
      for (const row of verifiedTerminal) {
        const outcome = String(row.payload.betOutcome || 'unknown').toLowerCase();
        const period = String(row.payload.periodAtSignal || 'unknown');
        if (!byPeriod[period]) byPeriod[period] = { settled: 0, wins: 0, losses: 0, pushes: 0, voids: 0 };
        byPeriod[period].settled++;
        if (outcome === 'won') byPeriod[period].wins++;
        if (outcome === 'lost') byPeriod[period].losses++;
        if (outcome === 'push') byPeriod[period].pushes++;
        if (outcome === 'void') byPeriod[period].voids++;
      }
      const issues = [];
      let issueCountTotal = 0;
      const addIssue = (row, code, detail) => {
        issueCountTotal++;
        if (issues.length < 100) issues.push({
          alertId: row.id, eventId: row.eventId,
          teams: [row.payload.homeTeam || row.payload.home || null, row.payload.awayTeam || row.payload.away || null],
          market: row.payload.market || null, minute: row.payload.minuteNumber ?? row.payload.minute ?? null,
          periodAtSignal: row.payload.periodAtSignal || null,
          evaluationRule: row.payload.evaluationRule || null,
          betOutcome: row.payload.betOutcome || 'pending',
          finalScore: row.payload.betFinalScore || null,
          issue: code, detail
        });
      };
      for (const row of rows) {
        const p = row.payload;
        const outcome = String(p.betOutcome || 'pending').toLowerCase();
        if (['won','lost','push','void'].includes(outcome)) {
          if (!p.betFinalScore) addIssue(row, 'missing_final_score', 'Settled alert has no recorded final score.');
          if (!p.betSettledAt) addIssue(row, 'missing_settlement_time', 'Settled alert has no recorded settlement timestamp.');
          if (!p.evaluationRule) addIssue(row, 'missing_evaluation_rule', 'Settled alert has no recorded evaluation rule.');
          if (p.periodAtSignal === 'second_half' && p.evaluationRule === 'end_of_first_half_score') addIssue(row, 'period_rule_conflict', 'Second-half alert is marked as settled using first-half score.');
          // Internal consistency check: compare stored settlement against its recorded score and Over line.
          // This does not independently verify the score with a provider; it catches contradictory stored outcomes.
          const scoreMatch = String(p.betFinalScore || '').match(/^\s*(\d+)\s*[-:]\s*(\d+)\s*$/);
          const overMatch = String(p.market || '').match(/\bover\s*(\d+(?:\.\d+)?)/i);
          const firstHalfSettlement = p.evaluationRule === 'end_of_first_half_score' || p.periodAtSignal === 'first_half';
          const expectedScoreScope = firstHalfSettlement ? 'first_half' : 'full_time';
          const scoreScopeVerified = p.betScoreScope === expectedScoreScope;
          if (!scoreScopeVerified) addIssue(row, 'settlement_score_scope_unverified', 'Saved score scope is missing or does not match the alert period; the outcome cannot be safely verified from this record.');
          if (!p.betSettlementProvider || !p.betSettlementFixtureId) addIssue(row, 'settlement_source_unverified', 'Legacy settlement does not identify the score provider and fixture used.');
          if (firstHalfSettlement && !p.betHalfTimeScore) addIssue(row, 'first_half_score_unverified', 'First-half settlement does not retain the exact half-time score separately.');
          else if (firstHalfSettlement && String(p.betHalfTimeScore) !== String(p.betFinalScore)) addIssue(row, 'first_half_score_conflict', 'Saved first-half settlement score does not match the separately retained half-time score.');
          if (p.lineType === 'asian' && p.asianPeriod === 'second_half' && ['won','lost','push'].includes(outcome)) {
            const secondHalfGoals = Number(p.betSecondHalfGoals);
            const line = overMatch ? Number(overMatch[1]) : Number(p.overLine);
            if (!Number.isFinite(secondHalfGoals) || !Number.isFinite(line)) {
              addIssue(row, 'asian_period_score_unverified', 'Second-half Asian result has no saved second-half goal total or valid line for outcome verification.');
            } else {
              const expected = secondHalfGoals === line && Number.isInteger(line) ? 'push' : secondHalfGoals > line ? 'won' : 'lost';
              if (expected !== outcome) addIssue(row, 'market_score_outcome_conflict', 'Recorded Asian outcome conflicts with saved second-half goals and Over line (expected ' + expected + ', stored ' + outcome + ').');
            }
          } else if (scoreScopeVerified && scoreMatch && overMatch && ['won','lost','push'].includes(outcome) && p.lineType !== 'asian') {
            const totalGoals = Number(scoreMatch[1]) + Number(scoreMatch[2]);
            const line = Number(overMatch[1]);
            const expected = totalGoals === line && Number.isInteger(line) ? 'push' : totalGoals > line ? 'won' : 'lost';
            if (expected !== outcome) addIssue(row, 'market_score_outcome_conflict', 'Recorded outcome conflicts with the saved period score and Over line (expected ' + expected + ', stored ' + outcome + ').');
          }
        }
        if (p.periodAtSignal === 'second_half' && p.evaluationRule === 'end_of_first_half_score' && !['won','lost','push','void'].includes(outcome)) {
          addIssue(row, 'period_rule_conflict_pending', 'Second-half alert is associated with first-half settlement rule.');
        }
        // Surface old unresolved records explicitly; do not guess their outcome.
        if (!['won','lost','push','void'].includes(outcome)) {
          const ageHours = (Date.now() - new Date(row.created_at).getTime()) / 3600000;
          if (Number.isFinite(ageHours) && ageHours >= 6) {
            const market = String(p.market || '').trim();
            if (!market) {
              addIssue(row, 'pending_missing_market', 'Alert is still pending and has no saved market/line, so its outcome cannot be graded safely.');
            } else {
              addIssue(row, 'stale_pending_settlement', 'Alert has remained pending for at least 6 hours; verify provider final/period score before settlement.');
            }
          }
        }
      }
      const winRate = verifiedTerminal.filter(row => String(row.payload.betOutcome).toLowerCase() === 'won' || String(row.payload.betOutcome).toLowerCase() === 'lost');
      const wins = winRate.filter(row => String(row.payload.betOutcome).toLowerCase() === 'won').length;
      const nowMs = Date.now();
      const pendingRows = rows.filter(row => pending.includes(row));
      const pendingAge = { under1h: 0, from1to24h: 0, from1to7d: 0, over7d: 0, missingCreatedAt: 0 };
      for (const row of pendingRows) {
        const created = new Date(row.createdAt).getTime();
        if (!Number.isFinite(created)) pendingAge.missingCreatedAt++;
        else {
          const age = nowMs - created;
          if (age < 60 * 60 * 1000) pendingAge.under1h++;
          else if (age < 24 * 60 * 60 * 1000) pendingAge.from1to24h++;
          else if (age < 7 * 24 * 60 * 60 * 1000) pendingAge.from1to7d++;
          else pendingAge.over7d++;
        }
      }
      const pendingSample = [...pendingRows].sort((a,b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()).slice(0, 30).map(row => ({
        alertId: row.id, eventId: row.eventId,
        createdAt: row.createdAt,
        ageHours: Number.isFinite(new Date(row.createdAt).getTime()) ? Math.round((nowMs - new Date(row.createdAt).getTime()) / 360000) / 10 : null,
        teams: [row.payload.homeTeam || row.payload.home || null, row.payload.awayTeam || row.payload.away || null],
        market: row.payload.market || null,
        minute: row.payload.minuteNumber ?? row.payload.minute ?? null,
        periodAtSignal: row.payload.periodAtSignal || null,
        evaluationRule: row.payload.evaluationRule || null,
        eventStatus: row.payload.status || row.payload.matchStatus || null,
        startScore: row.payload.startScore ?? null,
        betOutcome: row.payload.betOutcome || 'pending'
      }));
      return send(res, 200, {
        ok: true, readOnly: true, generatedAt: new Date().toISOString(), windowDays: 180,
        scanned: rows.length, settled: terminal.length, verifiedSettled: verifiedTerminal.length,
        unverifiedSettled: unverifiedTerminal, pending: pending.length,
        pendingAge, pendingSample,
        settledWinLossSample: winRate.length,
        wins, losses: winRate.length - wins,
        successRate: winRate.length ? Math.round(wins / winRate.length * 1000) / 10 : null,
        byOutcome, byPeriod, bySignalWindow,
        integrity: { issueCount: issueCountTotal, issueLimit: 100, issues },
        note: "Read-only audit. Accuracy rates include only settlements with explicit score scope, provider, fixture ID and retained half-time score where applicable. Legacy outcomes remain visible but are excluded until independently reconciled; this audit does not itself re-fetch provider scores."
      });
    } catch (error) {
      console.error("Alert history verification failed:", error.message);
      return send(res, 503, { error: "Could not verify alert history" });
    }
  }

  if (url.pathname === "/api/protocol-analyst/alerts" && req.method === "POST") {
    if (!isAllowedRequestOrigin(req)) return send(res, 403, { error: "Origin not allowed" });
    const auth = await authorizePrivateAdminRequest(req);
    if (!auth.ok) return send(res, auth.status, { ok: false, error: auth.error });
    if (!await ensureAlertHistoryDb()) return send(res, 503, { error: "Persistent alert history database unavailable" });
    try {
      // Read-only detail view. The returned records are filtered with the existing verified-settlement rules.
      const result = await analyticsPool.query(
        "SELECT alert_id, event_id, created_at, payload FROM alert_history WHERE payload->>'source'='server-push' AND COALESCE(payload->>'level','AI')='AI' AND payload->>'betOutcome' IN ('won','lost') AND payload->>'betSettlementProvider' IS NOT NULL AND payload->>'betSettlementFixtureId' IS NOT NULL AND payload->>'betScoreScope' IN ('first_half','full_time') AND payload->>'betFinalScore' IS NOT NULL AND payload->>'betFinalScore' <> '' AND (payload->>'betScoreScope' <> 'first_half' OR (NULLIF(payload->>'betHalfTimeScore','') IS NOT NULL AND payload->>'betHalfTimeScore'=payload->>'betFinalScore')) AND created_at > NOW() - INTERVAL '180 days' ORDER BY created_at DESC LIMIT 10000"
      );
      const records = result.rows.map(row => {
        const p = row.payload || {};
        const minuteCandidate = p.minuteNumber !== null && p.minuteNumber !== undefined && String(p.minuteNumber).trim() !== ""
          ? p.minuteNumber : String(p.minute || "").match(/[0-9]{1,3}/)?.[0];
        const parsedMinute = Number(minuteCandidate);
        const minute = Number.isFinite(parsedMinute) ? parsedMinute : Number(String(minuteCandidate ?? "").match(/[0-9]{1,3}/)?.[0]);
        const odds = p.odds !== null && p.odds !== undefined && p.odds !== "" ? Number(p.odds) : null;
        const stats = p.statsAtSignal || {};
        const scoreParts = String(p.betFinalScore || "").split("-").map(Number);
        const verifiedScore = scoreParts.length === 2 && String(p.betFinalScore || "").split("-").every(part => part.length > 0 && [...part].every(char => char >= "0" && char <= "9")) && scoreParts.every(value => Number.isInteger(value) && value >= 0);
        return {
          alertId: row.alert_id, eventId: row.event_id, createdAt: row.created_at,
          teams: [p.homeTeam || p.home || null, p.awayTeam || p.away || null],
          league: p.league || "Άγνωστη διοργάνωση",
          minute: Number.isFinite(minute) ? minute : null, period: p.periodAtSignal || "unknown",
          odds: Number.isFinite(odds) && odds > 1 ? odds : null,
          triggerIds: Array.isArray(p.triggerIds) ? [...new Set(p.triggerIds.map(String))] : [],
          supportSignalIds: Array.isArray(p.supportSignalIds) ? [...new Set(p.supportSignalIds.map(String))] : [],
          market: p.market || null, startScore: p.startScore ?? null, startScoreline: (p.startHomeScore ?? p.scoreAtSignal?.home) != null && (p.startAwayScore ?? p.scoreAtSignal?.away) != null ? `${p.startHomeScore ?? p.scoreAtSignal.home}-${p.startAwayScore ?? p.scoreAtSignal.away}` : null, finalScore: p.betFinalScore || null,
          halfTimeScore: p.betHalfTimeScore || null, outcome: p.betOutcome, scoreScope: p.betScoreScope,
          settlementProvider: p.betSettlementProvider, verifiedScore,
          statsAtSignal: { onTarget: stats.onTarget ?? null, onTarget10m: stats.onTarget10m ?? null, totalOnTarget: stats.totalOnTarget ?? null, xG: stats.xG ?? null, xGDelta: stats.xGDelta ?? null }
        };
      }).filter(row => row.verifiedScore && row.period === "second_half" && Number.isInteger(row.minute) && row.minute >= 46 && row.minute <= 88);
      return send(res, 200, {
        ok: true, readOnly: true, windowDays: 180, generatedAt: new Date().toISOString(),
        scanned: result.rows.length, verifiedSettled: records.length, records,
        note: "Only server-generated AI alerts with verified provider, fixture, score scope and final score are included. No records or live rules are changed."
      });
    } catch (error) {
      console.error("MIE alert detail read failed:", error.message);
      return send(res, 503, { error: "Could not load verified alert details" });
    }
  }

  if (url.pathname === "/api/protocol-analyst" && req.method === "POST") {
    if (!isAllowedRequestOrigin(req)) return send(res, 403, { error: "Origin not allowed" });
    const auth = await authorizePrivateAdminRequest(req);
    if (!auth.ok) return send(res, auth.status, { ok: false, error: auth.error });
    if (!await ensureProtocolAnalystDb()) return send(res, 503, { error: "Protocol analyst database unavailable" });
    try {
      // Always recompute from current settled history; cached reports may predate
      // the latest halftime repair or settlement pass.
      const report = await runProtocolAnalyst();
      if (!report) return send(res, 503, { error: "Protocol analysis could not be refreshed" });
      return send(res, 200, { ok: true, report, refreshed: true });
    } catch (error) {
      console.error("Protocol analyst read failed:", error.message);
      return send(res, 503, { error: "Could not load protocol analysis" });
    }
  }

  if (url.pathname === "/api/high-activity/history" && req.method === "GET") {
    if (!isAllowedRequestOrigin(req)) return send(res, 403, { error: "Origin not allowed" });
    if (!await ensureHighActivityHistoryDb()) {
      const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get("limit") || 5000)));
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset") || 0)));
      return send(res, 200, { ok: true, persistent: false, volatile: true, observations: volatileHistoryRows(volatileHighActivityHistory).slice(offset, offset + limit) });
    }
    try {
      const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get("limit") || 5000)));
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset") || 0)));
      const result = await highActivityHistoryPool.query("SELECT payload FROM high_activity_history ORDER BY created_at DESC, observation_id DESC LIMIT $1 OFFSET $2", [limit, offset]);
      return send(res, 200, { ok: true, persistent: true, observations: result.rows.map(row => row.payload) });
    } catch (error) {
      console.error("High Activity history read failed:", error.message);
      return send(res, 503, { error: "Could not load High Activity history" });
    }
  }
  if (url.pathname === "/api/high-activity/history" && req.method === "POST") {
    if (!isAllowedRequestOrigin(req)) return send(res, 403, { error: "Origin not allowed" });
    const highActivityDbReady = await ensureHighActivityHistoryDb();
    try {
      const body = await readJsonBody(req, 4 * 1024 * 1024);
      const incoming = Array.isArray(body.observations) ? body.observations.slice(0, 5000) : body.observation ? [body.observation] : [];
      const records = incoming.filter(x => x && x.observationId && x.eventId && Number.isFinite(Number(x.createdAt))).map(x => ({
        observation_id: String(x.observationId).slice(0, 240),
        event_id: String(x.eventId).slice(0, 120),
        created_at: Number(x.createdAt),
        payload: x
      }));
      if (!records.length) return send(res, 400, { error: "No valid High Activity observations supplied" });
      if (!highActivityDbReady) {
        for (const record of records) saveVolatileRecord(volatileHighActivityHistory, record.observation_id, record.payload, ["outcome", "settledAt", "settlementReason", "settlementScore", "settlementProvider", "settlementFixtureId", "settlementFixtureDate", "settlementLeague"]);
        return send(res, 200, { ok: true, saved: records.length, persistent: false, volatile: true });
      }
      await highActivityHistoryPool.query(
        `INSERT INTO high_activity_history(observation_id,event_id,created_at,payload,updated_at)
         SELECT x.observation_id,x.event_id,to_timestamp(x.created_at/1000.0),x.payload,NOW()
         FROM jsonb_to_recordset($1::jsonb) AS x(observation_id text,event_id text,created_at double precision,payload jsonb)
         ON CONFLICT(observation_id) DO UPDATE SET payload=CASE
           WHEN high_activity_history.payload->>'outcome' IN ('won','lost')
            AND COALESCE(EXCLUDED.payload->>'outcome','pending') NOT IN ('won','lost')
           THEN EXCLUDED.payload || jsonb_build_object(
             'outcome', high_activity_history.payload->'outcome',
             'settledAt', high_activity_history.payload->'settledAt',
             'settlementReason', high_activity_history.payload->'settlementReason',
             'settlementScore', high_activity_history.payload->'settlementScore',
             'settlementProvider', high_activity_history.payload->'settlementProvider',
             'settlementFixtureId', high_activity_history.payload->'settlementFixtureId',
             'settlementFixtureDate', high_activity_history.payload->'settlementFixtureDate',
             'settlementLeague', high_activity_history.payload->'settlementLeague'
           )
           ELSE EXCLUDED.payload
         END,updated_at=NOW()`,
        [JSON.stringify(records)]
      );
      return send(res, 200, { ok: true, saved: records.length, persistent: true });
    } catch (error) {
      console.error("High Activity history save failed:", error.message);
      return send(res, 503, { error: "Could not save High Activity history" });
    }
  }

  if (url.pathname === "/api/high-activity/resolve" && req.method === "POST") {
    if (!isAllowedRequestOrigin(req)) return send(res, 403, { error: "Origin not allowed" });
    try {
      const body = await readJsonBody(req, 512 * 1024);
      const incoming = Array.isArray(body.observations) ? body.observations.slice(0, 100) : [];
      const normalize = normalizeFixtureName;
      const slug = value => normalize(value).replace(/\s+/g, "-");
      const parseScore = value => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
      const resolved = [];
      for (const item of incoming) {
        if (!item || !item.observationId || !item.home || !item.away || !Number.isFinite(Number(item.createdAt))) continue;
        let createdAt = Number(item.createdAt);
        if (createdAt > 0 && createdAt < 1e12) createdAt *= 1000;
        const date = new Date(createdAt).toISOString().slice(0, 10);
        const candidateByKey = new Map();
        for (const teamName of [item.home, item.away]) {
          const key = date + "|" + slug(teamName);
          let cached = historicalTeamResultCache.get(key);
          const ttl = cached?.matches?.length ? 15 * 60 * 1000 : 2 * 60 * 1000;
          if (!cached || Date.now() - cached.at > ttl) {
            try {
              const response = await fetch("https://sportscore.com/api/v1/fixtures/?sport=football&date=" + encodeURIComponent(date) + "&status=finished&team=" + encodeURIComponent(slug(teamName)) + "&limit=200&src=goal-pulse", {
                headers: { Accept: "application/json" }, signal: AbortSignal.timeout(9000)
              });
              const payload = response.ok ? await response.json() : {};
              const matches = Array.isArray(payload.matches) ? payload.matches : Array.isArray(payload.data) ? payload.data : Array.isArray(payload.fixtures) ? payload.fixtures : [];
              cached = { at: Date.now(), matches };
              historicalTeamResultCache.set(key, cached);
              if (historicalTeamResultCache.size > 1000) historicalTeamResultCache.delete(historicalTeamResultCache.keys().next().value);
            } catch (error) { cached = { at: Date.now(), matches: [] }; historicalTeamResultCache.set(key, cached); }
          }
          for (const candidate of cached.matches) {
            const home = String(candidate.home || candidate.home_name || candidate.home_team?.name || candidate.homeTeam?.name || "").trim();
            const away = String(candidate.away || candidate.away_name || candidate.away_team?.name || candidate.awayTeam?.name || "").trim();
            const league = String(candidate.league?.name || candidate.league_name || candidate.competition?.name || candidate.competition_name || candidate.tournament?.name || "");
            const fixtureDate = String(candidate.date || candidate.match_date || candidate.fixture_date || date).slice(0, 10);
            const id = String(candidate.id || candidate.fixture_id || candidate.event_id || "");
            candidateByKey.set(id ? "id:" + id : JSON.stringify(candidate), { id, date: fixtureDate, home, away, league, raw: candidate });
          }
        }
        const fixture = findUniqueCompletedFixture([...candidateByKey.values()], {
          eventId: item.providerFixtureId || "", home: item.home, away: item.away, league: item.league || item.competition || "", date
        });
        const match = fixture?.raw;
        if (!match) continue;
        const homeScore = parseScore(match.home_score ?? match.homeScore ?? match.scores?.home ?? match.score?.home);
        const awayScore = parseScore(match.away_score ?? match.awayScore ?? match.scores?.away ?? match.score?.away);
        if (homeScore == null || awayScore == null) continue;
        const homeHtScore = parseScore(match.home_ht_score ?? match.homeHtScore ?? match.half_time_score?.home);
        const awayHtScore = parseScore(match.away_ht_score ?? match.awayHtScore ?? match.half_time_score?.away);
        resolved.push({ observationId: String(item.observationId), homeScore, awayScore, homeHtScore, awayHtScore,
          status: "post", source: "SportScore", fixtureId: fixture.id || null,
          fixtureDate: fixture.date, league: fixture.league || null, home: fixture.home, away: fixture.away });
      }
      return send(res, 200, { ok: true, resolved });
    } catch (error) {
      console.error("High Activity historical resolution failed:", error.message);
      return send(res, 503, { error: "Could not resolve High Activity history" });
    }
  }

  if (url.pathname === "/api/alerts/history/private" && req.method === "POST") {
    if (!isAllowedRequestOrigin(req)) return send(res, 403, { error: "Origin not allowed" });
    const auth = await authorizePrivateAdminRequest(req);
    if (!auth.ok) return send(res, auth.status, { ok: false, error: auth.error });
    const body = auth.body;
    const now = Date.now();
    try {
      const limit = Math.max(1, Math.min(1000, Number(body.limit || 500)));
      const offset = Math.max(0, Math.floor(Number(body.offset || 0)));
      const period = String(body.period || "all").toLowerCase();
      if (!await ensureAlertHistoryDb()) {
        const dateKey = value => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Athens", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
        const today = dateKey(now), yesterday = dateKey(now - 86400000);
        const rows = volatileHistoryRows(volatileAlertHistory).filter(item => {
          const at = Number(item.createdAt || 0);
          if (!at) return false;
          if (period === "today") return dateKey(at) === today;
          if (period === "yesterday") return dateKey(at) === yesterday;
          if (period === "7d") return at >= now - 7 * 86400000;
          if (period === "30d") return at >= now - 30 * 86400000;
          return true;
        });
        return send(res, 200, { ok: true, private: true, persistent: false, alerts: rows.slice(offset, offset + limit) });
      }
      const windowSql = period === "today"
        ? "created_at >= (date_trunc('day', NOW() AT TIME ZONE 'Europe/Athens') AT TIME ZONE 'Europe/Athens')"
        : period === "yesterday"
          ? "created_at >= ((date_trunc('day', NOW() AT TIME ZONE 'Europe/Athens') - INTERVAL '1 day') AT TIME ZONE 'Europe/Athens') AND created_at < (date_trunc('day', NOW() AT TIME ZONE 'Europe/Athens') AT TIME ZONE 'Europe/Athens')"
          : period === "7d" ? "created_at >= NOW() - INTERVAL '7 days'"
          : period === "30d" ? "created_at >= NOW() - INTERVAL '30 days'" : "TRUE";
      const result = await analyticsPool.query(
        `SELECT payload FROM alert_history WHERE ${windowSql} ORDER BY created_at DESC, alert_id DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return send(res, 200, { ok: true, private: true, persistent: true, alerts: result.rows.map(row => row.payload) });
    } catch (error) {
      console.error("Private AI alert history request failed:", error.message);
      return send(res, 400, { ok: false, error: "Could not load private AI alert history" });
    }
  }

  if (url.pathname === "/api/alerts/history" && req.method === "GET") {
    if (!isAllowedRequestOrigin(req)) return send(res, 403, { error: "Origin not allowed" });
    if (!await ensureAlertHistoryDb()) {
      const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get("limit") || 5000)));
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset") || 0)));
      const period = String(url.searchParams.get("period") || "all").toLowerCase();
      const now = Date.now();
      const dateKey = value => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Athens", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
      const today = dateKey(now), yesterday = dateKey(now - 86400000);
      const rows = volatileHistoryRows(volatileAlertHistory).filter(item => {
        const at = Number(item.createdAt || 0);
        if (!at) return false;
        if (period === "today") return dateKey(at) === today;
        if (period === "yesterday") return dateKey(at) === yesterday;
        if (period === "7d") return at >= now - 7 * 86400000;
        if (period === "30d") return at >= now - 30 * 86400000;
        return true;
      });
      return send(res, 200, { ok: true, persistent: false, volatile: true, historyScope: period, alerts: rows.slice(offset, offset + limit).map(publicAlertPayload) });
    }
    try {
      // Return the requested history window using Greece-local calendar boundaries.
      const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get("limit") || 5000)));
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset") || 0)));
      const period = String(url.searchParams.get("period") || "all").toLowerCase();
      const windowSql = period === "today"
        ? "created_at >= (date_trunc('day', NOW() AT TIME ZONE 'Europe/Athens') AT TIME ZONE 'Europe/Athens')"
        : period === "yesterday"
          ? "created_at >= ((date_trunc('day', NOW() AT TIME ZONE 'Europe/Athens') - INTERVAL '1 day') AT TIME ZONE 'Europe/Athens') AND created_at < (date_trunc('day', NOW() AT TIME ZONE 'Europe/Athens') AT TIME ZONE 'Europe/Athens')"
          : period === "7d"
            ? "created_at >= NOW() - INTERVAL '7 days'"
            : period === "30d"
              ? "created_at >= NOW() - INTERVAL '30 days'"
              : "TRUE";
      const result = await analyticsPool.query(
        `SELECT payload
           FROM alert_history
          WHERE ${windowSql}
          ORDER BY created_at DESC, alert_id DESC
          LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return send(res, 200, { ok: true, persistent: true, historyScope: period, alerts: result.rows.map(row => publicAlertPayload(row.payload)) });
    } catch (error) {
      return send(res, 503, { error: "Could not load alert history" });
    }
  }
  if (url.pathname === "/api/alerts/history" && req.method === "POST") {
    if (!isAllowedRequestOrigin(req)) return send(res, 403, { error: "Origin not allowed" });
    const alertHistoryDbReady = await ensureAlertHistoryDb();
    try {
      const body = await readJsonBody(req, 4 * 1024 * 1024);
      const incoming = Array.isArray(body.alerts) ? body.alerts.slice(0, 5000) : body.alert ? [body.alert] : [];
      if (!incoming.length) return send(res, 400, { error: "No alert records supplied" });
      const records = incoming.filter(a => a && a.eventId && Number.isFinite(Number(a.createdAt))).map(a => {
        const level = a.level === "VIP" ? "VIP" : "AI";
        const alertId = String(a.alertId || [a.eventId, level, a.createdAt, a.market || ""].join(":")).slice(0, 240);
        return { alert_id: alertId, event_id: String(a.eventId), level, created_at: Number(a.createdAt), payload: { ...a, alertId, level } };
      });
      if (!records.length) return send(res, 400, { error: "No valid alert records supplied" });
      if (!alertHistoryDbReady) {
        for (const record of records) saveVolatileRecord(volatileAlertHistory, record.alert_id, record.payload, ["betOutcome", "outcome", "betSettlementLabel", "betSettlementReason", "betFinalScore", "betMatchFinalScore", "betHalfTimeScore", "betScoreScope", "betScoreSource", "betSettlementProvider", "betSettlementFixtureId", "betSettlementFixtureDate", "betSettlementLeague", "betSettledAt", "evaluatedAt", "evaluationRule"]);
        return send(res, 200, { ok: true, persistent: false, volatile: true, saved: records.length });
      }
      await analyticsPool.query(
        `INSERT INTO alert_history(alert_id,event_id,level,created_at,payload,updated_at) SELECT x.alert_id,x.event_id,x.level,to_timestamp(x.created_at/1000.0),x.payload,NOW() FROM jsonb_to_recordset($1::jsonb) AS x(alert_id text,event_id text,level text,created_at numeric,payload jsonb) ON CONFLICT(alert_id) DO UPDATE SET payload=CASE
          WHEN alert_history.payload->>'periodAtSignal'='second_half'
           AND alert_history.payload->>'evaluationRule'='end_of_match_score'
           AND EXCLUDED.payload->>'periodAtSignal'='halftime'
          THEN EXCLUDED.payload || jsonb_build_object(
            'periodAtSignal', alert_history.payload->'periodAtSignal',
            'evaluationRule', alert_history.payload->'evaluationRule',
            'betOutcome', alert_history.payload->'betOutcome',
            'outcome', alert_history.payload->'outcome',
            'betSettlementLabel', alert_history.payload->'betSettlementLabel',
            'betFinalScore', alert_history.payload->'betFinalScore',
            'betSettledAt', alert_history.payload->'betSettledAt',
            'evaluatedAt', alert_history.payload->'evaluatedAt'
          )
          WHEN alert_history.payload->>'betOutcome' IN ('won','lost','void','push')
           AND COALESCE(EXCLUDED.payload->>'betOutcome','pending') NOT IN ('won','lost','void','push')
          THEN EXCLUDED.payload || jsonb_build_object(
            'betOutcome', alert_history.payload->'betOutcome',
            'outcome', COALESCE(alert_history.payload->'outcome','"εκκρεμεί"'::jsonb),
            'betSettlementLabel', alert_history.payload->'betSettlementLabel',
            'betSettlementReason', alert_history.payload->'betSettlementReason',
            'betFinalScore', alert_history.payload->'betFinalScore',
            'betMatchFinalScore', alert_history.payload->'betMatchFinalScore',
            'betHalfTimeScore', alert_history.payload->'betHalfTimeScore',
            'betScoreScope', alert_history.payload->'betScoreScope',
            'betScoreSource', alert_history.payload->'betScoreSource',
            'betSettlementProvider', alert_history.payload->'betSettlementProvider',
            'betSettlementFixtureId', alert_history.payload->'betSettlementFixtureId',
            'betSettlementFixtureDate', alert_history.payload->'betSettlementFixtureDate',
            'betSettlementLeague', alert_history.payload->'betSettlementLeague',
            'betSettledAt', alert_history.payload->'betSettledAt',
            'evaluatedAt', alert_history.payload->'evaluatedAt',
            'evaluationRule', alert_history.payload->'evaluationRule'
          )
          WHEN alert_history.payload->>'betOutcome' IN ('won','lost','void','push')
           AND EXCLUDED.payload->>'betOutcome' IN ('won','lost','void','push')
          THEN EXCLUDED.payload || jsonb_strip_nulls(jsonb_build_object(
            'betFinalScore', COALESCE(NULLIF(EXCLUDED.payload->'betFinalScore','null'::jsonb), alert_history.payload->'betFinalScore'),
            'betMatchFinalScore', COALESCE(NULLIF(EXCLUDED.payload->'betMatchFinalScore','null'::jsonb), alert_history.payload->'betMatchFinalScore'),
            'betScoreScope', COALESCE(NULLIF(EXCLUDED.payload->'betScoreScope','null'::jsonb), alert_history.payload->'betScoreScope'),
            'betSettledAt', COALESCE(NULLIF(EXCLUDED.payload->'betSettledAt','null'::jsonb), alert_history.payload->'betSettledAt'),
            'evaluatedAt', COALESCE(NULLIF(EXCLUDED.payload->'evaluatedAt','null'::jsonb), alert_history.payload->'evaluatedAt'),
            'evaluationRule', COALESCE(NULLIF(EXCLUDED.payload->'evaluationRule','null'::jsonb), alert_history.payload->'evaluationRule'),            'betSettlementLabel', COALESCE(NULLIF(EXCLUDED.payload->'betSettlementLabel','null'::jsonb), alert_history.payload->'betSettlementLabel'),
            'betSettlementReason', COALESCE(NULLIF(EXCLUDED.payload->'betSettlementReason','null'::jsonb), alert_history.payload->'betSettlementReason'),
            'betHalfTimeScore', COALESCE(NULLIF(EXCLUDED.payload->'betHalfTimeScore','null'::jsonb), alert_history.payload->'betHalfTimeScore'),
            'betScoreSource', COALESCE(NULLIF(EXCLUDED.payload->'betScoreSource','null'::jsonb), alert_history.payload->'betScoreSource'),
            'betSettlementProvider', COALESCE(NULLIF(EXCLUDED.payload->'betSettlementProvider','null'::jsonb), alert_history.payload->'betSettlementProvider'),
            'betSettlementFixtureId', COALESCE(NULLIF(EXCLUDED.payload->'betSettlementFixtureId','null'::jsonb), alert_history.payload->'betSettlementFixtureId'),
            'betSettlementFixtureDate', COALESCE(NULLIF(EXCLUDED.payload->'betSettlementFixtureDate','null'::jsonb), alert_history.payload->'betSettlementFixtureDate'),
            'betSettlementLeague', COALESCE(NULLIF(EXCLUDED.payload->'betSettlementLeague','null'::jsonb), alert_history.payload->'betSettlementLeague')
          ))
          ELSE EXCLUDED.payload
        END || jsonb_strip_nulls(jsonb_build_object(
          'reason', CASE WHEN EXCLUDED.payload ? 'reason' THEN NULL ELSE alert_history.payload->'reason' END,
          'triggerIds', CASE WHEN EXCLUDED.payload ? 'triggerIds' THEN NULL ELSE alert_history.payload->'triggerIds' END,
          'supportSignalIds', CASE WHEN EXCLUDED.payload ? 'supportSignalIds' THEN NULL ELSE alert_history.payload->'supportSignalIds' END,
          'statsAtSignal', CASE WHEN EXCLUDED.payload ? 'statsAtSignal' THEN NULL ELSE alert_history.payload->'statsAtSignal' END,
          'odds', CASE WHEN EXCLUDED.payload ? 'odds' THEN NULL ELSE alert_history.payload->'odds' END,
          'bookmaker', CASE WHEN EXCLUDED.payload ? 'bookmaker' THEN NULL ELSE alert_history.payload->'bookmaker' END,
          'oddsVerifiedAt', CASE WHEN EXCLUDED.payload ? 'oddsVerifiedAt' THEN NULL ELSE alert_history.payload->'oddsVerifiedAt' END,
          'scoreAtSignal', CASE WHEN EXCLUDED.payload ? 'scoreAtSignal' THEN NULL ELSE alert_history.payload->'scoreAtSignal' END,
          'supportingCriteriaScore', CASE WHEN EXCLUDED.payload ? 'supportingCriteriaScore' THEN NULL ELSE alert_history.payload->'supportingCriteriaScore' END,
          'evidenceKinds', CASE WHEN EXCLUDED.payload ? 'evidenceKinds' THEN NULL ELSE alert_history.payload->'evidenceKinds' END,
          'points', CASE WHEN EXCLUDED.payload ? 'points' THEN NULL ELSE alert_history.payload->'points' END
        )), updated_at=NOW()`,
        [JSON.stringify(records)]
      );
      return send(res, 200, { ok: true, persistent: true, saved: records.length });
    } catch (error) {
      console.error("Alert history write failed:", error.message);
      return send(res, 503, { error: "Could not save alert history" });
    }
  }

  if (url.pathname === "/api/pre-match/scan" && req.method === "GET") {
    if (!isAllowedRequestOrigin(req)) return send(res, 403, { error: "Origin not allowed" });
    try {
      let leagues = [];
      let persistent = false;
      if (await ensurePreMatchSeasonDb()) {
        const result = await analyticsPool.query(
          `SELECT COALESCE(p.league_code,s.league_code) AS league_code,
                  COALESCE(p.season_key,s.season_key) AS season_key,
                  COUNT(*)::int AS teams,
                  MAX(p.fetched_at) AS updated_at,
                  MAX(COALESCE((p.profile->>'fixtureCount')::int, 0)) AS fixtures,
                  MAX(s.status) AS collection_status,
                  MAX(s.last_error) AS last_error,
                  MAX(s.last_success_at) AS last_success_at,
                  MAX(s.retry_after) AS retry_after
             FROM pre_match_collection_state s
             FULL OUTER JOIN pre_match_season_profiles p
               ON s.league_code=p.league_code AND s.season_key=p.season_key
            GROUP BY COALESCE(p.league_code,s.league_code), COALESCE(p.season_key,s.season_key)
            ORDER BY MAX(COALESCE(s.completed_at,p.fetched_at)) DESC
            LIMIT 40`
        );
        leagues = result.rows.map(row => ({
          leagueCode: row.league_code, season: row.season_key,
          teams: Number(row.teams || 0), fixtures: Number(row.fixtures || 0),
          updatedAt: row.updated_at, lastSuccessAt: row.last_success_at || row.updated_at,
          status: row.collection_status || "legacy-profile",
          lastError: row.last_error || null, retryAfter: row.retry_after || null
        }));
        persistent = true;
      } else {
        const grouped = new Map();
        for (const [key, entry] of preMatchSeasonProfileCache) {
          if (!entry?.profile) continue;
          const [leagueCode, season] = key.split("|");
          const groupKey = leagueCode + "|" + season;
          const item = grouped.get(groupKey) || { leagueCode, season, teams: 0, fixtures: 0, updatedAt: entry.profile.fetchedAt || null };
          item.teams++;
          item.fixtures = Math.max(item.fixtures, Number(entry.profile.fixtureCount || 0));
          grouped.set(groupKey, item);
        }
        leagues = [...grouped.values()];
      }
      return send(res, 200, {
        ok: true, persistent, run: preMatchScanState,
        summary: {
          competitions: leagues.length,
          teams: leagues.reduce((sum, item) => sum + item.teams, 0),
          fixtures: leagues.reduce((sum, item) => sum + item.fixtures, 0),
          freshLeagues: leagues.filter(item => item.updatedAt && Date.now() - new Date(item.updatedAt).getTime() < PRE_MATCH_PROFILE_TTL_MS).length,
          staleLeagues: leagues.filter(item => !item.updatedAt || Date.now() - new Date(item.updatedAt).getTime() >= PRE_MATCH_PROFILE_TTL_MS).length,
          failedLeagues: leagues.filter(item => item.status === "error").length,
          lastUpdatedAt: leagues.reduce((latest, item) => !latest || new Date(item.updatedAt || 0) > new Date(latest) ? item.updatedAt : latest, null),
          leagues
        }
      });
    } catch (error) {
      console.error("[Pre-Match] status read failed:", error.message);
      return send(res, 503, { ok: false, error: "Could not read Pre-Match scan status" });
    }
  }
  if (url.pathname === "/api/pre-match/scan" && req.method === "POST") {
    if (!isAllowedRequestOrigin(req)) return send(res, 403, { error: "Origin not allowed" });
    if (preMatchScanState.status === "running") return send(res, 202, { ok: true, run: preMatchScanState });
    try {
      const date = getAthensDateKey();
      const base = "http://127.0.0.1:" + PORT;
      const response = await fetch(base + "/api/scoreboard?date=" + date, { signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error("Scoreboard unavailable: " + response.status);
      const scoreboard = await response.json();
      const events = (scoreboard.feeds || []).flatMap(feed =>
        (feed.events || []).map(event => ({ ...event, __goalPulseLeagueCode: feed.code || "" }))
      );
      const supported = [...new Set(events.map(event => String(event.__goalPulseLeagueCode || "")).filter(isPreMatchLeagueCode))];
      preMatchScanState.status = "running";
      preMatchScanState.startedAt = new Date().toISOString();
      preMatchScanState.completedAt = null;
      preMatchScanState.results = [];
      preMatchScanState.error = null;
      if (!supported.length) {
        preMatchScanState.status = "complete";
        preMatchScanState.completedAt = new Date().toISOString();
        preMatchScanState.error = "No supported league fixtures were found in today's scoreboard.";
        return send(res, 200, { ok: true, run: preMatchScanState, supportedLeagues: 0 });
      }
      schedulePreMatchSeasonCollection(events).then(result => {
        preMatchScanState.status = "complete";
        preMatchScanState.completedAt = new Date().toISOString();
        preMatchScanState.results = result.results || [];
        preMatchScanState.skipped = Number(result.skipped || 0);
        preMatchScanState.error = result.attempted === 0
          ? "All supported competitions are within the refresh window or a provider retry cooldown."
          : null;
        console.log("[Pre-Match] manual scan completed:", JSON.stringify({
          supportedLeagues: supported.length, attempted: result.attempted,
          skipped: preMatchScanState.skipped,
          successful: preMatchScanState.results.filter(item => item.ok).length,
          failed: preMatchScanState.results.filter(item => !item.ok).length
        }));
      }).catch(error => {
        preMatchScanState.status = "error";
        preMatchScanState.completedAt = new Date().toISOString();
        preMatchScanState.error = String(error.message || error).slice(0, 240);
        console.error("[Pre-Match] manual scan failed:", preMatchScanState.error);
      });
      return send(res, 202, { ok: true, run: preMatchScanState, supportedLeagues: supported.length });
    } catch (error) {
      preMatchScanState.status = "error";
      preMatchScanState.completedAt = new Date().toISOString();
      preMatchScanState.error = String(error.message || error).slice(0, 240);
      console.error("[Pre-Match] manual scan could not start:", preMatchScanState.error);
      return send(res, 503, { ok: false, run: preMatchScanState });
    }
  }

  if (url.pathname === "/api/push/vapid-public-key" && req.method === "GET") {
    return send(res, VAPID_PUBLIC_KEY ? 200 : 503, VAPID_PUBLIC_KEY ? { publicKey: VAPID_PUBLIC_KEY } : { error: "Push is not configured" });
  }
  if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
    if (!pushRequestAllowed(req, res)) return;
    try {
      const body = await readJsonBody(req);
      await savePushSubscription(body.subscription);
      return send(res, 201, { ok: true, persistent: Boolean(analyticsPool && await ensurePushDb()) });
    } catch (error) {
      return send(res, 400, { error: error.message || "Invalid subscription" });
    }
  }
  if (url.pathname === "/api/push/unsubscribe" && req.method === "POST") {
    if (!pushRequestAllowed(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const endpoint = String(body.endpoint || "");
      if (!endpoint.startsWith("https://")) return send(res, 400, { error: "Invalid subscription endpoint" });
      pushSubscriptions.delete(endpoint);
      let persistent = false;
      if (await ensurePushDb()) {
        await analyticsPool.query("DELETE FROM push_subscriptions WHERE endpoint=$1", [endpoint]);
        persistent = true;
      }
      return send(res, 200, { ok: true, persistent });
    } catch (error) {
      return send(res, 400, { error: error.message || "Could not unsubscribe" });
    }
  }
  if (url.pathname === "/api/push/test" && req.method === "POST") {
    if (!pushRequestAllowed(req, res)) return;
    try {
      // Synthetic AI-alert-shaped push test. Clearly labelled and never stored,
      // scored, settled, or included in AI/HI/VIP history or scanner results.
      const result = await sendPushToSubscribers({
        title: "TEST · ΔΟΚΙΜΑΣΤΙΚΟ AI ALERT",
        body: "ΔΟΚΙΜΑΣΤΙΚΟΣ ΑΓΩΝΑΣ — North City 1–0 South United · 32′ | 3 SOT στα τελευταία 5′ (εικονικά στοιχεία). Δεν είναι πραγματικός αγώνας ή πρόταση στοιχήματος.",
        tag: "goal-matrix-synthetic-ai-test",
        url: "/"
      });
      return send(res, result.configured === false ? 503 : 200, { ok: result.sent > 0, test: true, ...result });
    } catch (error) {
      return send(res, 503, { ok: false, test: true, error: error.message || "Push test failed" });
    }
  }

  if (url.pathname === "/api/push/alert" && req.method === "POST") {
    if (!pushRequestAllowed(req, res)) return;
    try {
      const body = await readJsonBody(req);
      // Odds are optional. Do not reject a legitimate alert because a price is unavailable.
      const level = body.level === "VIP" ? "VIP" : "AI";
      const title = level === "VIP" ? "GoalMatrix · ◆ VIP ALERT" : "GoalMatrix · AI ALERT";
      const alertBody = String(body.body || "Νέα live ένδειξη στο GoalMatrix").slice(0, 180);
      const eventId = String(body.eventId || "").slice(0, 160);
      const result = await sendPushToSubscribers({
        title,
        body: alertBody,
        tag: "goal-pulse-" + level.toLowerCase() + "-" + String(body.eventId || "live").slice(0, 60),
        url: "/"
      });
      // The frontend saves the full alert record (teams, market, outcomes) before sending push.
      // Avoid inserting a second, incomplete client-push row into the persistent alert history.
      return send(res, 200, { ok: true, ...result });
    } catch (error) {
      return send(res, 400, { error: error.message || "Push send failed" });
    }
  }


  if (url.pathname === "/api/push/scan" && req.method === "POST") {
    if (!PUSH_SCAN_TOKEN || req.headers.authorization !== "Bearer " + PUSH_SCAN_TOKEN) {
      return send(res, 401, { error: "Unauthorized scanner" });
    }
    try {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const base = "http://127.0.0.1:" + PORT;
      // Scoreboard identity/score data and live statistics are independent inputs.
      // Fetch them together so the scanner does not wait for one endpoint before
      // starting the other; keep the existing timeouts and all downstream logic.
      const [scoreboardResponse, metricsResponse] = await Promise.all([
        fetch(base + "/api/scoreboard?date=" + date, { signal: AbortSignal.timeout(25000) }),
        fetch(base + "/api/live-metrics?date=" + date, { signal: AbortSignal.timeout(45000) })
      ]);
      if (!scoreboardResponse.ok) throw new Error("Scoreboard unavailable: " + scoreboardResponse.status);
      if (!metricsResponse.ok) throw new Error("Live metrics unavailable: " + metricsResponse.status);
      const [scoreboard, metrics] = await Promise.all([
        scoreboardResponse.json(),
        metricsResponse.json()
      ]);
      const scoreboardEvents = (scoreboard.feeds || []).flatMap(feed => (feed.events || []).map(event => ({ ...event, __goalPulseLeagueCode: feed.code || "" })));
      // Include recent completed fixtures so pending alerts can settle after UTC midnight.
      // Keep the current-day feed unchanged and append only finished events from prior dates.
      for (const daysBack of [1, 2]) {
        const pastDate = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
        try {
          const pastResponse = await fetch(base + "/api/scoreboard?date=" + pastDate, { signal: AbortSignal.timeout(15000) });
          if (!pastResponse.ok) continue;
          const pastScoreboard = await pastResponse.json();
          for (const feed of (pastScoreboard.feeds || [])) {
            for (const event of (feed.events || [])) {
              const state = String(event.status?.type?.state || "").toLowerCase();
              const label = String(event.status?.type?.name || event.status?.type?.detail || event.status?.type?.shortDetail || "").toLowerCase();
              if (state === "post" || /final|full.?time|finished|ended|\bft\b/.test(label)) {
                scoreboardEvents.push({ ...event, __goalPulseLeagueCode: feed.code || "" });
              }
            }
          }
        } catch (pastScoreboardError) {
          console.warn("[settlement] Prior-date scoreboard unavailable for", pastDate, pastScoreboardError.message);
        }
      }
      // Automatically collect full-season league profiles for today's scheduled competitions.
      // This runs in the background and never delays or gates the live scanner.
      schedulePreMatchSeasonCollection(scoreboardEvents).catch(error => {
        console.warn("[Pre-Match] automatic preparation failed:", error.message);
      });
      // Join scoreboard score/status fields to the separate live-stat feed by normalized team names.
      // The stats endpoint does not include scores, and displayClock often looks like "45:00";
      // without this join the AI scanner silently sees no eligible first-half matches.
      const normalizeLiveTeam = value => String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const scoreboardByTeams = new Map();
      let scoreboardJoinedMatches = 0;
      const scoreboardJoinSamples = [];
      for (const event of scoreboardEvents) {
        const competition = event.competitions?.[0];
        const competitors = competition?.competitors || [];
        const home = competitors.find(team => team.homeAway === "home") || competitors[0];
        const away = competitors.find(team => team.homeAway === "away") || competitors[1];
        if (!home?.team?.displayName || !away?.team?.displayName) continue;
        const key = normalizeLiveTeam(home.team.displayName) + "|" + normalizeLiveTeam(away.team.displayName);
        // ESPN can expose event-level and competition-level status separately.
        // The event-level object may be present but omit its clock, while the
        // competition-level object still carries the numeric displayClock.
        const eventStatus = event.status || {};
        const competitionStatus = competition?.status || {};
        const firstStatusValue = (...values) => values.find(value => value != null && String(value).trim() !== "");
        const statusText = String(firstStatusValue(
          eventStatus.type?.detail, competitionStatus.type?.detail,
          eventStatus.type?.shortDetail, competitionStatus.type?.shortDetail,
          eventStatus.type?.name, competitionStatus.type?.name,
          eventStatus.displayClock, competitionStatus.displayClock
        ) || "");
        // Prefer a real numeric minute/clock, not a non-empty status label.
        // A provider can expose "2nd half" at event level while the competition
        // status still carries the actual clock needed by the AI first-half gate.
        const isNumericScoreboardClock = value => {
          const raw = String(value ?? "").trim();
          return /^[0-9]{1,3}(?::[0-9]{1,2})?\s*['′’]?$/.test(raw);
        };
        const scoreboardMinute = [
          eventStatus.displayClock, competitionStatus.displayClock,
          eventStatus.type?.displayClock, competitionStatus.type?.displayClock
        ].find(isNumericScoreboardClock) || "";
        scoreboardByTeams.set(key, {
          homeScore: home.score != null ? Number(home.score) : null,
          awayScore: away.score != null ? Number(away.score) : null,
          statusText,
          status: String(firstStatusValue(eventStatus.type?.state, competitionStatus.type?.state, eventStatus.type?.name, competitionStatus.type?.name) || ""),
          minute: scoreboardMinute,
          leagueCode: String(event.__goalPulseLeagueCode || ""),
          settlementProvider: "ESPN",
          settlementFixtureId: event.id == null ? "" : String(event.id),
          settlementFixtureDate: String(event.date || "").slice(0, 10),
          settlementLeague: String(competition?.name || "")
        });
      }
      for (const match of (metrics.matches || [])) {
        const key = normalizeLiveTeam(match.home) + "|" + normalizeLiveTeam(match.away);
        const score = scoreboardByTeams.get(key);
        if (!score) continue;
        scoreboardJoinedMatches++;
        if (scoreboardJoinSamples.length < 3) scoreboardJoinSamples.push({ home: match.home, away: match.away, statsMinute: match.minute ?? "", scoreMinute: score.minute, homeScore: score.homeScore, awayScore: score.awayScore, statusText: score.statusText });
        if (match.homeScore == null) match.homeScore = score.homeScore;
        if (match.awayScore == null) match.awayScore = score.awayScore;
        if (!match.statusText) match.statusText = score.statusText;
        if (!match.status) match.status = score.status;
        if (!match.leagueCode && score.leagueCode) match.leagueCode = score.leagueCode;
        // Carry the exact scoreboard fixture identity with the score; never invent a fixture ID from an alert ID.
        if (score.settlementFixtureId) {
          match.settlementProvider = score.settlementProvider;
          match.settlementFixtureId = score.settlementFixtureId;
          match.settlementFixtureDate = score.settlementFixtureDate;
          match.settlementLeague = score.settlementLeague;
        }
        // Convert clocks like "45:00" to a minute number for the alert gate.
        if (match.minute != null && !Number.isFinite(Number(match.minute))) {
          const clockMatch = String(match.minute).trim().match(/^([0-9]{1,3})(?::[0-9]{1,2})?[ ]*['′’]?$/);
          if (clockMatch) match.minute = Number(clockMatch[1]);
        }
        if ((!Number.isFinite(Number(match.minute)) || Number(match.minute) === 0) && score.minute) {
          const clockMatch = String(score.minute).trim().match(/^([0-9]{1,3})(?::[0-9]{1,2})?[ ]*['′’]?$/);
          if (clockMatch) match.minute = Number(clockMatch[1]);
        }
      }
      const now = Date.now();
      // Evaluate persisted real push alerts at the end of their selected half.
      // First-half outcomes use halftime scores, so second-half goals cannot falsely confirm them.
      if (await ensureAlertHistoryDb()) {
        try {
          // Repair older HT alerts: the live market at half-time is the second-half remainder,
          // but earlier records were stored as "halftime" and incorrectly settled against HT score.
          // Reopen only those clearly misclassified push alerts so they can be graded from the final score.
          const repairedHalftime = await analyticsPool.query(
            "UPDATE alert_history SET payload = jsonb_set(jsonb_set(jsonb_set(jsonb_set(payload, '{periodAtSignal}', '\"second_half\"'::jsonb), '{evaluationRule}', '\"end_of_match_score\"'::jsonb), '{betOutcome}', '\"pending\"'::jsonb), '{outcome}', '\"εκκρεμεί\"'::jsonb), updated_at=NOW() WHERE payload->>'source'='server-push' AND payload->>'periodAtSignal'='halftime' AND payload->>'evaluationRule'='end_of_first_half_score' AND payload->>'betOutcome' IN ('won','lost') AND payload->>'market' ILIKE 'Over %' AND payload->>'market' NOT ILIKE '%corner%' AND payload->>'market' NOT ILIKE '%κόρνερ%' AND payload->>'market' NOT ILIKE '%asian%' AND created_at > NOW() - INTERVAL '30 days' RETURNING alert_id"
          );
          if (repairedHalftime.rowCount) console.warn("Goal Pulse history repaired: reopened halftime alerts misgraded against first-half score", JSON.stringify({ repaired: repairedHalftime.rowCount }));
          const pending = await analyticsPool.query(
            "SELECT alert_id,payload,created_at FROM alert_history WHERE lower(trim(COALESCE(payload->>'outcome',''))) IN ('','εκκρεμεί','pending','σε εκκρεμότητα','εκκρεμές') AND COALESCE(payload->>'level','AI') IN ('AI','VIP') AND ((payload->>'market' ILIKE '%goal%' OR payload->>'market' ILIKE '%γκολ%' OR payload->>'market' ILIKE '%over%') OR (NULLIF(trim(payload->>'market'),'') IS NULL AND payload->>'source'='server-push' AND payload->>'startScore' IS NOT NULL AND ((NULLIF(trim(payload->>'home'),'') IS NOT NULL AND NULLIF(trim(payload->>'away'),'') IS NOT NULL) OR (jsonb_typeof(payload->'teams')='array' AND jsonb_array_length(payload->'teams') >= 2)))) AND COALESCE(payload->>'market','') NOT ILIKE '%ασιατ%' AND COALESCE(payload->>'market','') NOT ILIKE '%asian%' AND COALESCE(payload->>'market','') NOT ILIKE '%corner%' AND COALESCE(payload->>'market','') NOT ILIKE '%κόρνερ%' AND created_at > NOW() - INTERVAL '30 days' ORDER BY created_at ASC LIMIT 2000"
          );
          // Fetch historical scoreboard dates only when unresolved alerts actually need them.
          // This extends reconciliation beyond the previous fixed 2-day window without
          // requesting every past date on every scan.
          const todayUtc = new Date().toISOString().slice(0, 10).replace(/-/g, "");
          const loadedPastDates = new Set([1, 2].map(daysBack =>
            new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10).replace(/-/g, "")
          ));
          const pendingDates = new Set();
          for (const pendingRow of pending.rows) {
            if (!pendingRow.created_at) continue;
            const alertDate = new Date(pendingRow.created_at).toISOString().slice(0, 10);
            // A UTC alert timestamp can fall on a different calendar day from the
            // provider's fixture date. Load adjacent historical scoreboard dates too.
            for (const offset of [0, -1, 1]) {
              const lookupDate = new Date(Date.parse(alertDate + "T00:00:00Z") + offset * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
              if (lookupDate <= todayUtc && lookupDate !== todayUtc && !loadedPastDates.has(lookupDate)) pendingDates.add(lookupDate);
            }
          }
          for (const alertDate of pendingDates) {
            try {
              const historicalResponse = await fetch(base + "/api/scoreboard?date=" + alertDate, { signal: AbortSignal.timeout(15000) });
              if (!historicalResponse.ok) continue;
              const historicalScoreboard = await historicalResponse.json();
              let addedFinished = 0;
              for (const feed of (historicalScoreboard.feeds || [])) {
                for (const event of (feed.events || [])) {
                  const state = String(event.status?.type?.state || "").toLowerCase();
                  const label = String(event.status?.type?.name || event.status?.type?.detail || event.status?.type?.shortDetail || "").toLowerCase();
                  if (state === "post" || /final|full.?time|finished|ended|\\bft\\b/.test(label)) {
                    scoreboardEvents.push({ ...event, __goalPulseLeagueCode: feed.code || "" });
                    addedFinished++;
                  }
                }
              }
              console.info("[settlement] Historical pending-alert date checked:", JSON.stringify({ date: alertDate, addedFinished }));
            } catch (historicalError) {
              console.warn("[settlement] Historical pending-alert date unavailable:", JSON.stringify({ date: alertDate, error: historicalError.message }));
            }
          }
          const metricById = new Map((metrics.matches || []).map(item => [String(item.eventId), item]));
          const normalizeTeam = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/^(?:(?:cd|fc|cf|sc|ac|afc)\s+|club deportivo\s+|deportivo\s+)/, "").trim();
          const completedScoreboardFixtures = [];
          for (const event of scoreboardEvents) {
            const competition = event.competitions?.[0];
            const competitors = competition?.competitors || [];
            const home = competitors.find(team => team.homeAway === "home") || competitors[0];
            const away = competitors.find(team => team.homeAway === "away") || competitors[1];
            const state = String(event.status?.type?.state || competition?.status?.type?.state || "").toLowerCase();
            const statusLabel = [event.status?.type?.name, event.status?.type?.detail, event.status?.type?.shortDetail,
              competition?.status?.type?.name, competition?.status?.type?.detail, competition?.status?.type?.shortDetail].filter(Boolean).join(" ").toLowerCase();
            if (!home?.team?.displayName || !away?.team?.displayName || !(state === "post" || /final|full.?time|finished|ended|\bft\b/.test(statusLabel))) continue;
            const homeFirstPeriod = Number(home.linescores?.[0]?.value ?? home.linescores?.[0]?.displayValue);
            const awayFirstPeriod = Number(away.linescores?.[0]?.value ?? away.linescores?.[0]?.displayValue);
            const fixtureDate = String(event.date || "").slice(0, 10);
            const leagueName = String(competition?.name || "");
            const completedResult = { status: "post", statusText: "finished", homeScore: home.score, awayScore: away.score,
              homeHtScore: Number.isFinite(homeFirstPeriod) ? homeFirstPeriod : null, awayHtScore: Number.isFinite(awayFirstPeriod) ? awayFirstPeriod : null,
              settlementProvider: "ESPN", settlementFixtureId: String(event.id || ""), settlementFixtureDate: fixtureDate, settlementLeague: leagueName };
            completedScoreboardFixtures.push({ id: event.id == null ? "" : String(event.id), date: fixtureDate, league: leagueName,
              home: home.team.displayName, away: away.team.displayName, result: completedResult });
          }
          for (const row of pending.rows) {
            const alert = row.payload || {};
            const minuteMatch = String(alert.minuteNumber ?? alert.minute ?? "").match(/(\d{1,3})/);
            const signalMinute = Number(alert.minuteNumber ?? (minuteMatch ? minuteMatch[1] : NaN));
            const explicitPeriod = String(alert.periodAtSignal || "").toLowerCase();
            // Trust the explicit period captured at signal time over a parsed clock number.
            // Some feeds expose "2nd half" in a clock field, whose first digit can parse as minute 2.
            // At half-time the first-half market has ended; new alerts target the remaining
            // match (second-half goals), so they must settle at full-time, not against HT score.
            const firstHalf = explicitPeriod
              ? explicitPeriod === "first_half"
              : Number.isFinite(signalMinute) && signalMinute <= 45;
            const secondHalf = explicitPeriod
              ? explicitPeriod === "second_half" || explicitPeriod === "halftime"
              : !firstHalf && Number.isFinite(signalMinute) && signalMinute > 45;
            let live = metricById.get(String(alert.eventId));
            // Completed scoreboard entries can recover final scores and, when supplied by
            // the provider, the first-period (half-time) score. Never substitute full-time
            // goals for a missing half-time score.
            const alertHome = alert.home || (Array.isArray(alert.teams) ? alert.teams[0] : "");
            const alertAway = alert.away || (Array.isArray(alert.teams) ? alert.teams[1] : "");
            const alertDate = row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : "";
            const matchedCompletedFixture = findUniqueCompletedFixture(completedScoreboardFixtures, {
              eventId: row.event_id || alert.eventId, home: alertHome, away: alertAway, league: alert.league, date: alertDate, dateToleranceDays: 1
            });
            let completed = matchedCompletedFixture?.result || null;
            // The public day endpoint caps finished fixtures at 200. For a specific
            // unresolved alert, query SportScore by team so busy dates cannot hide its result.
            // Also query SportScore when ESPN found the fixture but omitted half-time linescores:
            // a final score alone must never block a provider that can verify the requested half.
            const completedHasHalfTime = completed?.homeHtScore != null && completed?.awayHtScore != null;
            if ((!completed || (firstHalf && !completedHasHalfTime)) && alertHome && alertAway && row.created_at) {
              const alertDate = new Date(row.created_at).toISOString().slice(0, 10);
              const teamSlug = value => normalizeTeam(value).replace(/\s+/g, "-");
              const parseScore = value => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
              const toCompleted = match => {
                const matchHome = String(match.home || match.home_name || match.home_team?.name || match.homeTeam?.name || "").trim();
                const matchAway = String(match.away || match.away_name || match.away_team?.name || match.awayTeam?.name || "").trim();
                if (normalizeTeam(matchHome) !== normalizeTeam(alertHome) || normalizeTeam(matchAway) !== normalizeTeam(alertAway)) return null;
                const homeFinal = parseScore(match.home_score ?? match.homeScore ?? match.scores?.home ?? match.score?.home);
                const awayFinal = parseScore(match.away_score ?? match.awayScore ?? match.scores?.away ?? match.score?.away);
                if (homeFinal == null || awayFinal == null) return null;
                const homeHt = parseScore(match.home_ht_score ?? match.homeHtScore ??
                  match.half_time_score?.home ?? match.halfTimeScore?.home ??
                  match.scores?.half_time?.home ?? match.scores?.halftime?.home ??
                  match.period_scores?.first_half?.home ?? match.periods?.first_half?.home);
                const awayHt = parseScore(match.away_ht_score ?? match.awayHtScore ??
                  match.half_time_score?.away ?? match.halfTimeScore?.away ??
                  match.scores?.half_time?.away ?? match.scores?.halftime?.away ??
                  match.period_scores?.first_half?.away ?? match.periods?.first_half?.away);
                const leagueName = String(match.league?.name || match.league_name || match.competition?.name || match.competition_name || match.tournament?.name || "");
                const fixtureDate = String(match.date || match.match_date || match.fixture_date || alertDate).slice(0, 10);
                return { status: "post", statusText: "finished", homeScore: homeFinal, awayScore: awayFinal,
                  homeHtScore: homeHt, awayHtScore: awayHt, settlementProvider: "SportScore",
                  settlementFixtureId: getProviderFixtureId(match),
                  settlementFixtureDate: fixtureDate, settlementLeague: leagueName };
              };
              const alertDateCandidates = [alertDate, ...[-1, 1].map(offset =>
                new Date(Date.parse(alertDate + "T00:00:00Z") + offset * 86400000).toISOString().slice(0, 10)
              )];
              lookupLoop: for (const lookupDate of alertDateCandidates) {
                for (const teamName of [alertHome, alertAway]) {
                  const slug = teamSlug(teamName);
                  if (!slug) continue;
                  const key = lookupDate + "|" + slug;
                  let cached = historicalTeamResultCache.get(key);
                  const cacheTtl = cached?.matches?.length ? 15 * 60 * 1000 : 2 * 60 * 1000;
                  if (!cached || Date.now() - cached.at > cacheTtl) {
                    try {
                      let historicalResponse = await fetch("https://sportscore.com/api/v1/fixtures/?sport=football&date=" + encodeURIComponent(lookupDate) + "&status=finished&team=" + encodeURIComponent(slug) + "&limit=200&src=goal-pulse", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(9000) });
                      let body = historicalResponse.ok ? await historicalResponse.json() : {};
                      // Some SportScore team-filter requests return HTTP 200 with an empty
                      // matches array even though the date's finished-fixture feed contains
                      // the match. Fall back once per date to that complete feed, then apply
                      // the same strict team/date/league matching below.
                      let matches = historicalResponse.ok ? extractFixtureArray(body) : [];
                      if (!matches.length) {
                        const allKey = lookupDate + "|__all_finished__";
                        let allCached = historicalTeamResultCache.get(allKey);
                        if (!allCached || Date.now() - allCached.at > 15 * 60 * 1000) {
                          const allResponse = await fetch("https://sportscore.com/api/v1/fixtures/?sport=football&date=" + encodeURIComponent(lookupDate) + "&status=finished&limit=200&src=goal-pulse", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(9000) });
                          const allBody = allResponse.ok ? await allResponse.json() : {};
                          const allMatches = allResponse.ok ? extractFixtureArray(allBody) : [];
                          allCached = { at: Date.now(), matches: allMatches, httpStatus: allResponse.status,
                            rootKeys: allBody && typeof allBody === "object" ? Object.keys(allBody).slice(0, 20) : [] };
                          historicalTeamResultCache.set(allKey, allCached);
                        }
                        if (allCached.matches.length) {
                          matches = allCached.matches;
                          console.info("[settlement] SportScore used date-wide finished-fixture fallback:", JSON.stringify({
                            date: lookupDate, teamSlug: slug, fixtures: matches.length, httpStatus: allCached.httpStatus
                          }));
                        } else {
                          console.warn("[settlement] SportScore historical lookup and date-wide fallback returned no fixtures:", JSON.stringify({
                            date: lookupDate, teamSlug: slug, teamHttpStatus: historicalResponse.status,
                            teamRootKeys: body && typeof body === "object" ? Object.keys(body).slice(0, 20) : [],
                            fallbackHttpStatus: allCached.httpStatus, fallbackRootKeys: allCached.rootKeys
                          }));
                        }
                      }
                      cached = { at: Date.now(), matches, httpStatus: historicalResponse.status,
                        rootKeys: body && typeof body === "object" ? Object.keys(body).slice(0, 20) : [] };
                      historicalTeamResultCache.set(key, cached);
                      if (historicalTeamResultCache.size > 1000) historicalTeamResultCache.delete(historicalTeamResultCache.keys().next().value);
                    } catch (lookupError) {
                      cached = { at: Date.now(), matches: [] };
                      historicalTeamResultCache.set(key, cached);
                    }
                  }
                  const candidates = cached.matches.map(match => {
                    const result = toCompleted(match);
                    if (!result) return null;
                    const matchHome = String(match.home || match.home_name || match.home_team?.name || match.homeTeam?.name || "").trim();
                    const matchAway = String(match.away || match.away_name || match.away_team?.name || match.awayTeam?.name || "").trim();
                    return { id: result.settlementFixtureId, date: result.settlementFixtureDate, league: result.settlementLeague,
                      home: matchHome, away: matchAway, result, raw: match };
                  }).filter(Boolean);
                  const uniqueCandidates = [...new Map(candidates.map(candidate => [
                    candidate.id ? "id:" + candidate.id : JSON.stringify(candidate.raw), candidate
                  ])).values()];
                  const exactMatch = findUniqueCompletedFixture(uniqueCandidates, {
                    home: alertHome, away: alertAway, league: alert.league, date: alertDate, dateToleranceDays: 1
                  });
                  if (exactMatch) {
                    const sportScoreHasHalfTime = exactMatch.result.homeHtScore != null && exactMatch.result.awayHtScore != null;
                    // Prefer a provider result with verified HT score for first-half markets.
                    // Otherwise retain an existing ESPN fixture match for second-half/final-score use.
                    if (!firstHalf || sportScoreHasHalfTime || !completed) {
                      completed = exactMatch.result;
                      if (!firstHalf || sportScoreHasHalfTime) break lookupLoop;
                    }
                  }
                }
              }
            }
            if (secondHalf && completed) live = completed;
            else if (firstHalf && completed && completed.homeHtScore != null && completed.awayHtScore != null) live = completed;
            if (/κόρνερ|corner/i.test(String(alert.market || ""))) continue;
            if (!live) {
              console.warn("[settlement] Pending alert not matched to a verifiable period score:", JSON.stringify({
                alertId: row.alert_id, eventId: alert.eventId || row.event_id || null,
                home: alertHome || null, away: alertAway || null, league: alert.league || null,
                alertDate, period: firstHalf ? "first_half" : secondHalf ? "second_half" : explicitPeriod || null,
                completedFixtureMatched: Boolean(completed),
                missingHalfTimeScore: Boolean(firstHalf && completed && (completed.homeHtScore == null || completed.awayHtScore == null))
              }));
              continue;
            }
            const statusText = String(live.statusText || live.status || "").toLowerCase();
            const homeScore = Number(live.homeScore), awayScore = Number(live.awayScore);
            const hasFullScore = live.homeScore != null && live.awayScore != null && Number.isFinite(homeScore) && Number.isFinite(awayScore);
            let startScore = Number(alert.startScore);
            if (!Number.isFinite(startScore) && alert.startHomeScore != null && alert.startAwayScore != null &&
                Number.isFinite(Number(alert.startHomeScore)) && Number.isFinite(Number(alert.startAwayScore))) {
              startScore = Number(alert.startHomeScore) + Number(alert.startAwayScore);
            }
            if (!Number.isFinite(startScore) && alert.alertType === "power_ranking_signal" &&
                /goal|γκολ/i.test(String(alert.market || "")) && (firstHalf || secondHalf)) {
              // Recover legacy "next goal" Power Ranking rows only when every settled
              // sibling for this exact fixture and half agrees on the same Over market,
              // outcome, final score and verified provider fixture. Otherwise leave pending.
              try {
                const siblingResult = await analyticsPool.query(
                  "SELECT payload FROM alert_history WHERE event_id=$1 AND alert_id<>$2 AND payload->>'source'='server-push' AND payload->>'home'=$3 AND payload->>'away'=$4 AND payload->>'periodAtSignal'=$5 AND payload->>'market' ILIKE 'Over %' AND payload->>'market' NOT ILIKE '%corner%' AND payload->>'market' NOT ILIKE '%ασιατ%' AND payload->>'betOutcome' IN ('won','lost','push') AND payload->>'betFinalScore' IS NOT NULL AND payload->>'betSettlementProvider' IS NOT NULL AND payload->>'betSettlementFixtureId' IS NOT NULL AND created_at > NOW() - INTERVAL '30 days' ORDER BY created_at ASC",
                  [String(row.event_id || alert.eventId || ""), String(row.alert_id), String(alertHome), String(alertAway), firstHalf ? "first_half" : "second_half"]
                );
                const siblings = siblingResult.rows.map(item => item.payload || {}).filter(item => Number.isFinite(parseOverLine(item.market)));
                const signatures = new Set(siblings.map(item => JSON.stringify([
                  String(item.market || "").trim().toLowerCase(), item.betOutcome, item.betFinalScore,
                  item.betScoreScope, item.betSettlementProvider, item.betSettlementFixtureId,
                  item.betSettlementFixtureDate || null
                ])));
                if (siblings.length > 0 && signatures.size === 1) {
                  const sibling = siblings[0];
                  alert.betOutcome = sibling.betOutcome;
                  alert.betSettlementLabel = sibling.betSettlementLabel || (sibling.betOutcome === "won" ? "Κερδισμένο" : sibling.betOutcome === "lost" ? "Χαμένο" : "Επιστροφή");
                  alert.outcome = sibling.outcome || (sibling.betOutcome === "won" ? "Επιβεβαιώθηκε · επιτεύχθηκε ο στόχος γκολ" : sibling.betOutcome === "lost" ? "Δεν επιβεβαιώθηκε · δεν επιτεύχθηκε ο στόχος γκολ" : "Επιστροφή · ισοπαλία στη γραμμή Over");
                  for (const field of ["betFinalScore","betMatchFinalScore","betScoreScope","betSettlementProvider","betSettlementFixtureId","betSettlementFixtureDate","betSettlementLeague","betScoreSource","betHalfTimeScore"]) {
                    if (sibling[field] != null) alert[field] = sibling[field];
                  }
                  alert.betSettledAt = now;
                  alert.evaluatedAt = now;
                  alert.evaluationRule = "legacy_power_ranking_sibling_reconciliation";
                  alert.betSettlementReason = "Unanimous settlement inherited from settled Over alerts for the same fixture and half";
                  await analyticsPool.query("UPDATE alert_history SET payload=$2::jsonb,updated_at=NOW() WHERE alert_id=$1", [row.alert_id, JSON.stringify(alert)]);
                  console.info("[settlement] Legacy Power Ranking alert reconciled from unanimous siblings:", JSON.stringify({ alertId: row.alert_id, eventId: alert.eventId || row.event_id || null, outcome: alert.betOutcome, score: alert.betFinalScore, siblingCount: siblings.length }));
                  continue;
                }
              } catch (siblingError) {
                console.warn("[settlement] Legacy Power Ranking sibling reconciliation skipped:", JSON.stringify({ alertId: row.alert_id, error: siblingError.message }));
              }
            }
            if ((!Number.isFinite(startScore) && !canSettleOverWithoutStartScore(alert.market)) || (!firstHalf && !secondHalf)) continue;
            const settlement = getPeriodSettlementScore({ period: firstHalf ? "first_half" : "second_half",
              status: live.status, statusText, minute: live.minute, homeScore: live.homeScore, awayScore: live.awayScore,
              homeHtScore: live.homeHtScore, awayHtScore: live.awayHtScore });
            if (!settlement) continue;
            // A result is not considered settled unless its score is tied to a real provider fixture.
            // Keep the record pending when a feed supplies a score but no verifiable fixture identity.
            if (!live.settlementProvider || !live.settlementFixtureId) {
              console.warn("[settlement] Skipped score without provider fixture identity:", JSON.stringify({
                alertId: row.alert_id, eventId: alert.eventId || row.event_id || null,
                provider: live.settlementProvider || null, fixtureId: live.settlementFixtureId || null
              }));
              continue;
            }
            const outcomeScore = settlement.total;
            const marketText = String(alert.market || "");
            let betOutcome;
            if (/\bover\b/i.test(marketText) && !/corner|κόρνερ/i.test(marketText)) {
              const overLine = parseOverLine(marketText);
              if (overLine == null) continue;
              betOutcome = gradeOverMarket(outcomeScore, overLine);
            } else betOutcome = outcomeScore > startScore ? "won" : "lost";
            if (!betOutcome) continue;
            const won = betOutcome === "won", isPush = betOutcome === "push";
            // Alert evaluation and the user's Bet result are independent fields.
            // Reconcile a pending evaluation even when the Bet was already settled manually,
            // but never overwrite that existing Bet outcome or its settlement evidence.
            alert.outcome = won ? "Επιβεβαιώθηκε · επιτεύχθηκε ο στόχος γκολ" :
              isPush ? "Επιστροφή · ισοπαλία στη γραμμή Over" : "Δεν επιβεβαιώθηκε · δεν επιτεύχθηκε ο στόχος γκολ";
            const existingBetOutcome = String(alert.betOutcome || "").trim().toLowerCase();
            const betAlreadySettled = ["won", "lost", "void", "push"].includes(existingBetOutcome);
            if (!betAlreadySettled) {
              alert.betOutcome = betOutcome;
              alert.betSettlementLabel = won ? "Κερδισμένο" : isPush ? "Επιστροφή" : "Χαμένο";
              alert.betFinalScore = settlement.home + "-" + settlement.away;
              if (hasFullScore) alert.betMatchFinalScore = homeScore + "-" + awayScore;
              if (live.homeHtScore != null && live.awayHtScore != null &&
                  Number.isFinite(Number(live.homeHtScore)) && Number.isFinite(Number(live.awayHtScore))) {
                alert.betHalfTimeScore = Number(live.homeHtScore) + "-" + Number(live.awayHtScore);
              }
              alert.betScoreScope = settlement.scope;
              alert.betSettlementProvider = String(live.settlementProvider);
              alert.betSettlementFixtureId = String(live.settlementFixtureId);
              alert.betSettlementFixtureDate = live.settlementFixtureDate || alertDate;
              alert.betSettlementLeague = live.settlementLeague || alert.league || null;
              alert.betScoreSource = firstHalf ? "period_1_linescore" : "confirmed_full_time_score";
              alert.betSettledAt = now;
            }
            alert.evaluatedAt = now;
            alert.evaluationRule = firstHalf ? "end_of_first_half_score" : "end_of_match_score";
            await analyticsPool.query(
              "UPDATE alert_history SET payload=$2::jsonb,updated_at=NOW() WHERE alert_id=$1",
              [row.alert_id, JSON.stringify(alert)]
            );
            console.info("AI alert auto-settled:", JSON.stringify({
              alertId: row.alert_id,
              eventId: alert.eventId || null,
              market: alert.market || null,
              outcome: alert.betOutcome,
              score: alert.betFinalScore,
              scoreScope: alert.betScoreScope,
              provider: alert.betSettlementProvider,
              fixtureId: alert.betSettlementFixtureId,
              minute: alert.minute ?? null,
              rule: alert.evaluationRule
            }));
          }
          // Never leave an old alert pending forever. After 48 hours, if the
          // completed fixture/period still has no verifiable provider score,
          // close it as void (unverified), never as a win or loss.
          const staleUnverified = await analyticsPool.query(
            `UPDATE alert_history
                SET payload = payload || jsonb_build_object(
                  'betOutcome', 'void',
                  'outcome', 'Μη επαληθεύτηκε · έκλεισε χωρίς αξιόπιστο σκορ',
                  'betSettlementLabel', 'Μη επαληθευμένο · ακυρώθηκε',
                  'betSettlementReason', 'Δεν βρέθηκε επαληθεύσιμο σκορ από πάροχο εντός 48 ωρών',
                  'betSettledAt', (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
                  'evaluatedAt', (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
                  'evaluationRule', 'unverified_after_48h'
                ),
                updated_at = NOW()
              WHERE created_at < NOW() - INTERVAL '48 hours'
                AND COALESCE(payload->>'level', 'AI') IN ('AI', 'VIP')
                AND lower(trim(COALESCE(payload->>'outcome', ''))) IN ('', 'εκκρεμεί', 'pending', 'σε εκκρεμότητα', 'εκκρεμές')
                AND lower(trim(COALESCE(payload->>'betOutcome', ''))) IN ('', 'pending', 'εκκρεμεί', 'σε εκκρεμότητα')
              RETURNING alert_id`
          );
          if (staleUnverified.rowCount) {
            console.warn("[settlement] Closed stale alerts as unverified voids:", JSON.stringify({ count: staleUnverified.rowCount, ageHours: 48 }));
          }
        } catch (evaluationError) {
          console.error("AI alert halftime outcome evaluation failed:", evaluationError.message);
        }
      }
      // Automatically settle Asian Over bets from the final score. An exact integer line is a push/refund.
      if (await ensureAlertHistoryDb()) {
        try {
          const pendingAsian = await analyticsPool.query(
            "SELECT alert_id,payload FROM alert_history WHERE payload->>'lineType'='asian' AND COALESCE(payload->>'betOutcome','pending') IN ('pending','') AND created_at > NOW() - INTERVAL '30 days' ORDER BY created_at ASC LIMIT 2000"
          );
          const finalFixtures = [];
          for (const event of scoreboardEvents) {
            const competition = event.competitions?.[0];
            const competitors = competition?.competitors || [];
            const home = competitors.find(team => team.homeAway === "home") || competitors[0];
            const away = competitors.find(team => team.homeAway === "away") || competitors[1];
            const state = String(event.status?.type?.state || "").toLowerCase();
            const statusLabel = String(event.status?.type?.name || event.status?.type?.detail || event.status?.type?.shortDetail || "").toLowerCase();
            const hs = Number(home?.score), as = Number(away?.score);
            if (!home?.team?.displayName || !away?.team?.displayName || !(state === "post" || /final|full.?time|finished|ended|\bft\b/.test(statusLabel)) || !Number.isFinite(hs) || !Number.isFinite(as)) continue;
            const fixtureDate = String(event.date || "").slice(0, 10);
            const leagueName = String(competition?.name || "");
            if (!event.id || !fixtureDate) continue;
            finalFixtures.push({
              id: String(event.id), date: fixtureDate, league: leagueName,
              home: home.team.displayName, away: away.team.displayName,
              result: { homeScore: hs, awayScore: as, settlementProvider: "ESPN",
                settlementFixtureId: String(event.id), settlementFixtureDate: fixtureDate,
                settlementLeague: leagueName }
            });
          }
          let settledAsianBets = 0;
          for (const row of pendingAsian.rows) {
            const bet = row.payload || {};
            if (!bet.home || !bet.away || !Number.isFinite(Number(bet.overLine))) continue;
            const alertDate = row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : "";
            const exactFixture = findUniqueCompletedFixture(finalFixtures, {
              home: bet.home, away: bet.away, league: bet.league, date: alertDate, dateToleranceDays: 1
            });
            const final = exactFixture?.result;
            if (!final) continue;
            // Asian alerts are second-half-only. Never grade one against full-time total
            // when its period/start score metadata is missing; leave it pending for review.
            const isSecondHalfAsian = bet.lineType === "asian" && bet.asianPeriod === "second_half" &&
              bet.startScore != null && Number.isFinite(Number(bet.startScore));
            if (!isSecondHalfAsian) {              console.warn("Asian bet settlement skipped: missing second-half period/start score", JSON.stringify({alertId: row.alert_id, asianPeriod: bet.asianPeriod || null, startScore: bet.startScore ?? null}));
              continue;            }
            const finalTotal = final.homeScore + final.awayScore;
            const settledTotal = finalTotal - Number(bet.startScore);
            if (settledTotal < 0) {
              console.warn("Asian bet settlement skipped: final total below recorded start score", JSON.stringify({alertId: row.alert_id, finalTotal, startScore: bet.startScore}));
              continue;
            }
            const line = Number(bet.overLine);
            if (!Number.isFinite(line)) continue;
            const result = settledTotal > line ? "won" : settledTotal === line && Number.isInteger(line) ? "push" : "lost";
            bet.betOutcome = result;
            bet.betSettlementLabel = result === "won" ? "Κερδισμένο" : result === "lost" ? "Χαμένο" : "Επιστροφή (ασιατικό push)";
            bet.betFinalScore = final.homeScore + "-" + final.awayScore;
            bet.betScoreScope = "full_time";
            bet.betSettlementProvider = final.settlementProvider;
            bet.betSettlementFixtureId = final.settlementFixtureId;
            bet.betSettlementFixtureDate = final.settlementFixtureDate;
            bet.betSettlementLeague = final.settlementLeague || bet.league || null;
            bet.betScoreSource = "confirmed_full_time_score";
            bet.evaluationRule = "asian_over_second_half_goals_vs_line";
            bet.betSettledAt = now;
            bet.betSettlementRule = "asian_over_second_half_goals_vs_line";
            bet.betSecondHalfGoals = settledTotal;
            bet.betUpdatedAt = now;
            bet.recordUpdatedAt = now;
            await analyticsPool.query(
              "UPDATE alert_history SET payload=$2::jsonb,updated_at=NOW() WHERE alert_id=$1",
              [row.alert_id, JSON.stringify(bet)]
            );
            settledAsianBets++;
          }
          if (settledAsianBets) console.log("Asian bet history auto-settled:", JSON.stringify({settled: settledAsianBets}));
        } catch (settlementError) {
          console.error("Asian bet history auto-settlement failed:", settlementError.message);
        }
      }
      let checked = 0, sent = 0, candidates = 0, powerRankingAlerts = 0;
      let strongSignals = 0, firstHalfOddsChecks = 0, secondHalfEligible = 0, oddsVerifiedCount = 0, oddsMissingCount = 0, oddsErrors = 0;
      const aiSignalDiagnostics = [];
      // Enforce the existing maximum of four alerts separately for each AI trigger per match/half.
      // A different trigger never consumes this trigger's quota; counts survive restarts.
      const alertCountsByMatchHalf = new Map();
      try {
        if (await ensureAlertHistoryDb()) {
          const countRows = await analyticsPool.query(
            "SELECT event_id, CASE WHEN payload->>'periodAtSignal' IN ('second_half','halftime') THEN 'second_half' ELSE 'first_half' END AS alert_half, trigger_ids.trigger_id, COUNT(*)::int AS alert_count FROM alert_history CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(payload->'triggerIds')='array' THEN payload->'triggerIds' ELSE '[]'::jsonb END) AS trigger_ids(trigger_id) WHERE payload->>'source'='server-push' AND COALESCE(payload->>'level','AI')='AI' AND COALESCE(payload->>'alertType','') = trigger_ids.trigger_id AND COALESCE(payload->>'alertType','') <> 'power_ranking_signal' AND created_at > NOW() - INTERVAL '36 hours' GROUP BY event_id, CASE WHEN payload->>'periodAtSignal' IN ('second_half','halftime') THEN 'second_half' ELSE 'first_half' END, trigger_ids.trigger_id"
          );
          for (const row of countRows.rows) alertCountsByMatchHalf.set(String(row.event_id) + ":" + row.alert_half + ":" + String(row.trigger_id), Number(row.alert_count) || 0);
        }
      } catch (countError) {
        console.warn("AI per-half alert counts could not be loaded; in-memory cap remains active:", countError.message);