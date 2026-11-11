const http = require("node:http");
const webpush = require("web-push");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { getPeriodSettlementScore, parseOverLine, gradeOverMarket, canSettleOverWithoutStartScore, normalizeFixtureName, getProviderFixtureId, findUniqueCompletedFixture } = require("./settlement");
const { validateRollingSot, confirmSotSignal, readExactSotStat } = require("./sot-integrity");
const { isAiMinuteEligible, isCumulativeSotMinute, isFirstHalfSotMinute, isFirstHalfEightSotMinute } = require("./ai-minute-window");
const { createLimiter, isHistoryLeagueSupported, fetchCompetitionHistoryWindow, formatEspnMonth } = require("./competition-history");
const { createCompetitionHistoryStore } = require("./competition-history-store");
const { buildPreMatchMatchupContext, seasonBoundsForLeague, seasonEventFilterForLeague, scorePreMatchMatchupContext } = require("./pre-match-intelligence");
const { calculatePowerRankingScore, isPowerRankingMinuteEligible, shouldEmitAutonomousPowerRankingAlert } = require("./power-ranking-trigger");
const { evaluatePressureHunter } = require("./pressure-hunter");
const { settlePressureHunterRecord } = require("./pressure-hunter-settlement");
const { buildIndependentAiTriggers, sotTriggerConfirmationKey } = require("./ai-trigger-isolation");
const { summarizeEliteDataAudit } = require("./elite-data-audit");
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
const pushScanPressureHunterAlerts = new Set();
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

let pressureHunterDbInit = null;
async function ensurePressureHunterDb() {
  if (!analyticsPool) return false;
  if (!pressureHunterDbInit) pressureHunterDbInit = analyticsPool.query(
    "CREATE TABLE IF NOT EXISTS pressure_hunter_history (alert_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, level TEXT NOT NULL CHECK (level IN ('DUAL_PRESSURE','EXTREME')), created_at TIMESTAMPTZ NOT NULL, payload JSONB NOT NULL); CREATE INDEX IF NOT EXISTS pressure_hunter_history_created_at_idx ON pressure_hunter_history(created_at DESC); CREATE INDEX IF NOT EXISTS pressure_hunter_history_event_id_idx ON pressure_hunter_history(event_id)"
  ).then(() => true).catch(error => {
    pressureHunterDbInit = null;
    console.error("Pressure Hunter database unavailable:", error.message);
    return false;
  });
  return pressureHunterDbInit;
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
const sportScoreMatchDetailCache = new Map();
const sportScoreMatchDetailInflight = new Map();
let sportScoreDetailActiveRequests = 0;
const sportScoreDetailWaiters = [];
async function withSportScoreDetailSlot(task) {
  if (sportScoreDetailActiveRequests >= 2) await new Promise(resolve => sportScoreDetailWaiters.push(resolve));
  sportScoreDetailActiveRequests++;
  try { return await task(); }
  finally {
    sportScoreDetailActiveRequests--;
    const next = sportScoreDetailWaiters.shift();
    if (next) next();
  }
}
async function fetchSportScoreMatchDetail(slug) {
  const key = String(slug || "");
  const cached = sportScoreMatchDetailCache.get(key);
  if (cached && Date.now() - cached.at < 12000) return { ok: true, status: 200, payload: cached.payload, cached: true };
  if (sportScoreMatchDetailInflight.has(key)) return sportScoreMatchDetailInflight.get(key);
  const request = (async () => {
    const url = "https://sportscore.com/api/widget/match/?sport=football&slug=" + encodeURIComponent(key) + "&src=goal-pulse";
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await withSportScoreDetailSlot(() => fetch(url, {
          headers: { "Accept": "application/json" },
          signal: AbortSignal.timeout(10000)
        }));
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      lastStatus = response.status;
      if (response.ok) {
        const payload = await response.json();
        sportScoreMatchDetailCache.set(key, { at: Date.now(), payload });
        if (sportScoreMatchDetailCache.size > 240) {
          const oldest = [...sportScoreMatchDetailCache.entries()].sort((a, b) => a[1].at - b[1].at);
          for (let i = 0; i < oldest.length - 240; i++) sportScoreMatchDetailCache.delete(oldest[i][0]);
        }
        return { ok: true, status: response.status, payload, cached: false };
      }
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) {
        return { ok: false, status: response.status, payload: null, cached: false };
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      const retryDelay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(8000, retryAfter * 1000)
        : Math.min(4000, 700 * (2 ** attempt));
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
    return { ok: false, status: lastStatus, payload: null, cached: false };
  })();
  sportScoreMatchDetailInflight.set(key, request);
  try { return await request; }
  finally { sportScoreMatchDetailInflight.delete(key); }
}

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
            row.event_id === String(match.eventId) &&
            String(row.team_name).trim().toLowerCase() === String(team.team || "").trim().toLowerCase()
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
  // instead of generating a fresh from/to query (and API request) for every candidate.
  const hourMs = 60 * 60 * 1000;
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

  if (url.pathname === "/api/elite-team/data-audit" && req.method === "POST") {
    if (!isAllowedRequestOrigin(req)) return send(res, 403, { ok: false, error: "Origin not allowed" });
    const auth = await authorizePrivateAdminRequest(req);
    if (!auth.ok) return send(res, auth.status, { ok: false, error: auth.error });
    const windowDays = Math.max(1, Math.min(180, Math.floor(Number(auth.body.windowDays || 180))));
    if (!analyticsPool) return send(res, 503, { ok: false, error: "Persistent audit database unavailable" });
    try {
      // Read-only coverage query. It never updates alert history or live snapshots.
      const result = await analyticsPool.query(
        `WITH scoped_alerts AS (
           SELECT alert_id, event_id, created_at, payload
             FROM alert_history
            WHERE payload->>'source' = 'server-push'
              AND COALESCE(payload->>'level', 'AI') = 'AI'
              AND created_at > NOW() - ($1::int * INTERVAL '1 day')
            ORDER BY created_at DESC
            LIMIT 10000
         )
         SELECT a.alert_id, a.event_id, a.created_at, a.payload,
                COUNT(s.id) FILTER (WHERE s.id IS NOT NULL)::int AS snapshot_rows,
                COUNT(s.id) FILTER (WHERE s.shots_on_target IS NOT NULL)::int AS sot_snapshot_rows,
                COUNT(s.id) FILTER (WHERE s.id IS NOT NULL AND s.observed_at <= a.created_at)::int AS snapshots_before_signal,
                COUNT(s.id) FILTER (WHERE s.shots_on_target IS NOT NULL AND s.observed_at <= a.created_at)::int AS sot_snapshots_before_signal,
                COUNT(s.id) FILTER (WHERE s.id IS NOT NULL AND s.observed_at > a.created_at)::int AS snapshots_after_signal,
                COUNT(s.id) FILTER (WHERE s.shots_on_target IS NOT NULL AND s.observed_at > a.created_at)::int AS sot_snapshots_after_signal,
                COUNT(DISTINCT s.team_name) FILTER (WHERE s.id IS NOT NULL)::int AS snapshot_teams
           FROM scoped_alerts a
           LEFT JOIN live_stat_snapshots s
             ON s.event_id = a.event_id
            AND s.observed_at >= a.created_at - INTERVAL '15 minutes'
            AND s.observed_at <= a.created_at + INTERVAL '2 minutes'
          GROUP BY a.alert_id, a.event_id, a.created_at, a.payload
          ORDER BY a.created_at DESC`,
        [windowDays]
      );
      const report = summarizeEliteDataAudit(result.rows, { windowDays });
      return send(res, 200, report);
    } catch (error) {
      console.error("Elite team data audit failed:", String(error.message || error));
      return send(res, 503, { ok: false, error: "Could not build read-only Elite data audit" });
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
        "SELECT alert_id, event_id, created_at, payload FROM alert_history WHERE payload->>'source'='server-push' AND COALESCE(payload->>'level','AI')='AI' AND COALESCE(payload->>'alertType','') NOT LIKE 'power_ranking_%' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(payload->'triggerIds')='array' THEN payload->'triggerIds' ELSE '[]'::jsonb END) AS t(trigger_id) WHERE t.trigger_id LIKE 'power_ranking_%') AND payload->>'betOutcome' IN ('won','lost') AND payload->>'betSettlementProvider' IS NOT NULL AND payload->>'betSettlementFixtureId' IS NOT NULL AND payload->>'betScoreScope' IN ('first_half','full_time') AND payload->>'betFinalScore' IS NOT NULL AND payload->>'betFinalScore' <> '' AND (payload->>'betScoreScope' <> 'first_half' OR (NULLIF(payload->>'betHalfTimeScore','') IS NOT NULL AND payload->>'betHalfTimeScore'=payload->>'betFinalScore')) AND created_at > NOW() - INTERVAL '180 days' ORDER BY created_at DESC LIMIT 10000"
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
          alertType: p.alertType || null,
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
      }).filter(row => !String(row.alertType || "").startsWith("power_ranking_") && !row.triggerIds.some(id => id.startsWith("power_ranking_")) && row.verifiedScore && row.period === "second_half" && Number.isInteger(row.minute) && row.minute >= 46 && row.minute <= 88);
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

  if (url.pathname === "/api/hunter/history" && req.method === "GET") {
    if (!isAllowedRequestOrigin(req)) return send(res, 403, { error: "Origin not allowed" });
    if (!await ensurePressureHunterDb()) return send(res, 503, { error: "Pressure Hunter history unavailable" });
    try {
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 50)));
      const result = await analyticsPool.query(
        "SELECT payload FROM pressure_hunter_history ORDER BY created_at DESC LIMIT $1",
        [limit]
      );
      return send(res, 200, { ok: true, autonomous: true, alerts: result.rows.map(row => row.payload) });
    } catch (error) {
      console.error("Pressure Hunter history request failed:", error.message);
      return send(res, 503, { error: "Could not load Pressure Hunter history" });
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
            'evaluationRule', COALESCE(NULLIF(EXCLUDED.payload->'evaluationRule','null'::jsonb), alert_history.payload->'evaluationRule'),
            'betSettlementLabel', COALESCE(NULLIF(EXCLUDED.payload->'betSettlementLabel','null'::jsonb), alert_history.payload->'betSettlementLabel'),
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
                  if (state === "post" || /final|full.?time|finished|ended|\bft\b/.test(label)) {
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
      // Pressure Hunter settlement is deliberately outside the AI/VIP settlement block.
      // It reads and writes only its own history table.
      if (await ensurePressureHunterDb()) {
        try {
          const pendingHunterRows = (await analyticsPool.query(
            "SELECT alert_id,event_id,payload,created_at FROM pressure_hunter_history WHERE lower(trim(COALESCE(payload->>'outcome',''))) IN ('','εκκρεμεί','pending') AND created_at > NOW() - INTERVAL '30 days' ORDER BY created_at ASC LIMIT 1000"
          )).rows;
          const todayHunterUtc = new Date().toISOString().slice(0, 10).replace(/-/g, "");
          const hunterDates = new Set();
          for (const row of pendingHunterRows) {
            if (!row.created_at) continue;
            const date = new Date(row.created_at).toISOString().slice(0, 10);
            for (const offset of [0, -1, 1]) {
              const lookupDate = new Date(Date.parse(date + "T00:00:00Z") + offset * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
              if (lookupDate <= todayHunterUtc && lookupDate !== todayHunterUtc) hunterDates.add(lookupDate);
            }
          }
          for (const date of hunterDates) {
            try {
              const response = await fetch(base + "/api/scoreboard?date=" + date, { signal: AbortSignal.timeout(15000) });
              if (!response.ok) continue;
              const historical = await response.json();
              for (const feed of (historical.feeds || [])) {
                for (const event of (feed.events || [])) {
                  const state = String(event.status?.type?.state || "").toLowerCase();
                  const label = String(event.status?.type?.name || event.status?.type?.detail || event.status?.type?.shortDetail || "").toLowerCase();
                  if (state === "post" || /final|full.?time|finished|ended|\bft\b/.test(label)) {
                    scoreboardEvents.push({ ...event, __goalPulseLeagueCode: feed.code || "" });
                  }
                }
              }
            } catch (historyError) {
              console.warn("[pressure-hunter] Historical scoreboard lookup skipped:", JSON.stringify({ date, error: historyError.message }));
            }
          }
          const hunterCompletedFixtures = [];
          for (const event of scoreboardEvents) {
            const competition = event.competitions?.[0];
            const competitors = competition?.competitors || [];
            const home = competitors.find(team => team.homeAway === "home") || competitors[0];
            const away = competitors.find(team => team.homeAway === "away") || competitors[1];
            const state = String(event.status?.type?.state || competition?.status?.type?.state || "").toLowerCase();
            const statusText = [event.status?.type?.name, event.status?.type?.detail, event.status?.type?.shortDetail,
              competition?.status?.type?.name, competition?.status?.type?.detail, competition?.status?.type?.shortDetail].filter(Boolean).join(" ").toLowerCase();
            if (!home?.team?.displayName || !away?.team?.displayName ||
                !(state === "post" || /final|full.?time|finished|ended|\bft\b/.test(statusText))) continue;
            hunterCompletedFixtures.push({
              id: event.id == null ? "" : String(event.id),
              date: String(event.date || "").slice(0, 10),
              league: String(competition?.name || ""),
              home: home.team.displayName,
              away: away.team.displayName,
              result: {
                status: "post", statusText: "finished",
                homeScore: home.score, awayScore: away.score,
                settlementProvider: "ESPN", settlementFixtureId: String(event.id || ""),
                settlementFixtureDate: String(event.date || "").slice(0, 10),
                settlementLeague: String(competition?.name || "")
              }
            });
          }
          for (const row of pendingHunterRows) {
            const hunter = row.payload || {};
            const date = row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : "";
            if (!date || !hunter.home || !hunter.away) continue;
            const matched = findUniqueCompletedFixture(hunterCompletedFixtures, {
              eventId: row.event_id || hunter.eventId, home: hunter.home, away: hunter.away,
              league: hunter.league, date, dateToleranceDays: 1
            });
            if (!matched?.result) continue;
            const settled = settlePressureHunterRecord(hunter, matched.result, now);
            if (!settled) continue;
            const updated = await analyticsPool.query(
              "UPDATE pressure_hunter_history SET payload=$2::jsonb WHERE alert_id=$1 AND lower(trim(COALESCE(payload->>'outcome',''))) IN ('','εκκρεμεί','pending') RETURNING alert_id",
              [row.alert_id, JSON.stringify(settled)]
            );
            if (updated.rowCount) console.info("[pressure-hunter] Signal settled:", JSON.stringify({
              alertId: row.alert_id, outcome: settled.outcomeStatus,
              goalsAfterSignal: settled.goalsAfterSignal, finalScore: settled.finalScore
            }));
          }
        } catch (hunterSettlementError) {
          console.error("[pressure-hunter] Independent settlement cycle failed:", hunterSettlementError.message);
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
      }
      const parseLiveMinute = value => {
        const raw = String(value ?? "").trim();
        if (!raw || /half|period|not started|finished|full.?time|ημίχρονο|τέλος/i.test(raw)) return NaN;
        const numeric = Number(raw);
        if (Number.isFinite(numeric)) return numeric;
        const clock = raw.match(/^([0-9]{1,3})(?::[0-9]{1,2})?\s*['′’]?$/);
        return clock ? Number(clock[1]) : NaN;
      };
      // Some feeds put a status label such as "1st half" in match.minute while
      // the actual numeric clock is in live_minute. Prefer a parseable clock.
      const getMatchMinute = match => {
        const candidates = [match.live_minute, match.liveMinute, match.elapsed, match.time?.elapsed, match.minute, match.time?.minute];
        for (const candidate of candidates) {
          if (candidate == null || String(candidate).trim() === "") continue;
          if (Number.isFinite(parseLiveMinute(candidate))) return candidate;
        }
        return null;
      };
      const formatPushMinute = match => {
        const rawMinute = getMatchMinute(match);
        if (rawMinute != null && String(rawMinute).trim() !== "") {
          const numericMinute = parseLiveMinute(rawMinute);
          if (Number.isFinite(numericMinute) && numericMinute >= 0) return String(Math.floor(numericMinute)) + "′";
          return String(rawMinute).trim().slice(0, 24);
        }
        const statusText = String(match.status_text || match.statusText || match.status || "").trim();
        return statusText || "LIVE";
      };
      for (const match of (metrics.matches || [])) {
        if (!Array.isArray(match.teams) || match.teams.length < 2) continue;
        // A persisted rolling SOT window can remain valid when the provider's
        // current snapshot has no stats. Do not let statsAvailable=false hide
        // an otherwise qualifying 5m/10m SOT signal after a transient feed gap.
        const hasPersistedSotWindow = [match.trend?.window5m, match.trend?.window10m].some(window =>
          Array.isArray(window?.teams) && window.teams.some(team =>
            team?.shotsOnTarget != null && Number.isFinite(Number(team.shotsOnTarget))
          )
        );
        if (!match.statsAvailable && !hasPersistedSotWindow) continue;
        const teams = match.teams;
        const total = key => teams.every(team => team[key] != null)
          ? teams.reduce((sum, team) => sum + Number(team[key] || 0), 0) : null;
        const minuteRawForEligibility = getMatchMinute(match);
        const minuteForEligibility = parseLiveMinute(minuteRawForEligibility);
        const statusForEligibility = String(match.statusText || match.status || match.status_text || "").toLowerCase();
        const goalsForEligibility = Number(match.homeScore) + Number(match.awayScore);
        const validSecondHalfMinute = Number.isFinite(minuteForEligibility) && minuteForEligibility >= 46 && minuteForEligibility <= 84;
        if (validSecondHalfMinute && /second half|2nd half|2ο ημίχρονο|δεύτερο ημίχρονο/.test(statusForEligibility) && Number.isFinite(goalsForEligibility) && goalsForEligibility < 2) secondHalfEligible++;
        // xG alternative: both teams must qualify, one at >= 3.50 and the other at >= 2.50.
        // Missing/invalid xG cannot qualify this trigger, but does not block independent SOT triggers.
        const teamXGValues = teams.map(team =>
          team.xG == null || !Number.isFinite(Number(team.xG)) ? null : Number(team.xG)
        );
        // Aggregate xG is display/history context only; it is not an alert trigger.
        // Require both team values so missing xG remains neutral and is never imputed.
        const totalXG = teamXGValues.length === 2 && teamXGValues.every(value => value != null)
          ? teamXGValues.reduce((sum, value) => sum + value, 0)
          : null;
        const validTeamXGValues = teamXGValues.filter(value => value != null);
        const qualifyingTeamXG = validTeamXGValues.length ? Math.max(...validTeamXGValues) : null;
        // xG support is available only when both teams meet the 3.50 / 2.50 thresholds.
        // Missing xG never qualifies the xG trigger; independent SOT triggers remain unaffected.
        const bothTeamsXGQualified = teamXGValues.length >= 2 &&
          ((teamXGValues[0] != null && teamXGValues[0] >= 3.5 && teamXGValues[1] != null && teamXGValues[1] >= 2.5) ||
           (teamXGValues[1] != null && teamXGValues[1] >= 3.5 && teamXGValues[0] != null && teamXGValues[0] >= 2.5));
        const teamSOTValues = teams
          .map(team => team.shotsOnTarget == null ? null : Number(team.shotsOnTarget))
          .filter(value => value != null && Number.isFinite(value));
        const maxTeamSOT = teamSOTValues.length ? Math.max(...teamSOTValues) : null;
        const current = {
          at: now,
          minute: parseLiveMinute(getMatchMinute(match)),
          redCardIncidents: Array.isArray(match.redCardIncidents) ? match.redCardIncidents : [],
          onTarget: total("shotsOnTarget"),
          // Preserve each team's SOT independently; a missing value for one side
          // must not erase the other side's valid rolling SOT measurement.
          sotByTeam: teams.map(team => ({
            team: String(team.team || "").trim().toLowerCase(),
            value: team.shotsOnTarget == null || !Number.isFinite(Number(team.shotsOnTarget))
              ? null : Number(team.shotsOnTarget)
          })),
          shotsInBoxByTeam: teams.map(team => ({ team: String(team.team || "").trim().toLowerCase(), value: team.shotsInBox == null || !Number.isFinite(Number(team.shotsInBox)) ? null : Number(team.shotsInBox) })),
          bigChancesByTeam: teams.map(team => ({ team: String(team.team || "").trim().toLowerCase(), value: team.bigChances == null || !Number.isFinite(Number(team.bigChances)) ? null : Number(team.bigChances) })),
          dangerousByTeam: teams.map(team => ({
            team: String(team.team || "").trim().toLowerCase(),
            value: team.dangerousAttacks == null || !Number.isFinite(Number(team.dangerousAttacks)) ? null : Number(team.dangerousAttacks)
          })),
          redCardsByTeam: teams.map(team => ({
            team: String(team.team || "").trim().toLowerCase(),
            value: team.redCards == null || !Number.isFinite(Number(team.redCards)) ? null : Number(team.redCards)
          })),
          shotsOnTargetInsideBox: total("shotsOnTargetInsideBox"),
          bigChances: total("bigChances"),
          maxTeamSOT,
          corners: total("corners"),
          attacks: total("attacks"),
          dangerous: total("dangerousAttacks"),
          xG: qualifyingTeamXG,
          bothTeamsXGQualified
        };
        const id = String(match.eventId);
        // Keep a rolling five-minute window so activity spread across scanner cycles
        // is measured together, instead of comparing only with the immediately prior scan.
        const snapshots = pushScanSnapshots.get(id) || [];
        const priorScan = snapshots.length ? snapshots[snapshots.length - 1] : null;
        if (priorScan && Array.isArray(priorScan.redCardsByTeam) && Array.isArray(current.redCardsByTeam)) {
          for (const side of current.redCardsByTeam) {
            const priorSide = priorScan.redCardsByTeam.find(item => item.team === side.team);
            if (now - priorScan.at <= 2 * 60 * 1000 && side.value != null && priorSide?.value != null && side.value > priorSide.value) {
              const sideIndex = current.redCardsByTeam.indexOf(side), advantageIndex = 1 - sideIndex;
              pushScanRedCardSince.set(id, {
                team: side.team, at: now,
                advantagedTeam: current.sotByTeam[advantageIndex]?.team || null,
                sotAtCard: current.sotByTeam[advantageIndex]?.value ?? null,
                dangerousAtCard: current.dangerousByTeam[advantageIndex]?.value ?? null
              });
            }
          }
        }
        snapshots.push(current);
        // Keep 11 minutes of snapshots: the 10-minute SOT baseline accepts snapshots
        // aged 9.5–11 minutes, so a 10-minute retention window silently discarded
        // much of the valid baseline range and made the 10m trigger unreliable.
        const windowStart = now - 11 * 60 * 1000;
        const rollingSnapshots = snapshots.filter(snapshot => snapshot.at >= windowStart);
        pushScanSnapshots.set(id, rollingSnapshots);
        const previous = [...rollingSnapshots].reverse().find(snapshot => now - snapshot.at >= 4.5 * 60 * 1000 && now - snapshot.at <= 6 * 60 * 1000) || null;
        const previous10 = [...rollingSnapshots].reverse().find(snapshot => now - snapshot.at >= 9.5 * 60 * 1000 && now - snapshot.at <= 11 * 60 * 1000) || null;
        checked++;
        // Prefer PostgreSQL-persisted rolling baselines attached to the default
        // live-metrics response. They survive scanner restarts; use RAM only as fallback.
        const persistedSotDelta = window => {
          const rows = window?.teams;
          if (!Array.isArray(rows) || !rows.length) return null;
          // A known team's SOT delta can qualify when it alone reaches the
          // combined threshold. Missing opponent data must not erase it.
          // Unknown values are ignored, never fabricated as zero.
          const values = rows
            .map(team => team.shotsOnTarget)
            .filter(value => value != null && Number.isFinite(Number(value)));
          if (!values.length) return null;
          return values.reduce((sum, value) => sum + Math.max(0, Number(value)), 0);
        };
        const persisted5mSot = persistedSotDelta(match.trend?.window5m);
        const persisted10mSot = persistedSotDelta(match.trend?.window10m);
        // Missing rolling SOT baselines disable only the SOT trigger for this scan.
        // They must never skip the independent two-team xG alternative below.
        const delta = key => current[key] == null || previous?.[key] == null ? 0 : Math.max(0, current[key] - previous[key]);
        // Compare SOT per team, not the combined current total. This allows a
        // valid team's SOT delta to count when the opponent's SOT is unavailable,
        // while never treating an unknown value as zero.
        const memorySotDelta = baseline => {
          if (!Array.isArray(current.sotByTeam) || !Array.isArray(baseline?.sotByTeam)) return null;
          const previousByTeam = new Map(baseline.sotByTeam
            .filter(side => side?.team && side.value != null && Number.isFinite(Number(side.value)))
            .map(side => [side.team, Number(side.value)]));
          let comparableTeams = 0;
          const delta = current.sotByTeam.reduce((sum, side) => {
            if (!side?.team || side.value == null || !Number.isFinite(Number(side.value))) return sum;
            const oldValue = previousByTeam.get(side.team);
            if (oldValue == null) return sum;
            comparableTeams++;
            return sum + Math.max(0, Number(side.value) - oldValue);
          }, 0);
          return comparableTeams ? delta : null;
        };
        const memory5mSot = memorySotDelta(previous);
        const memory10mSot = memorySotDelta(previous10);
        // Require independent agreement when both rolling baselines exist.
        // Never allow a rolling delta to exceed the current match-wide cumulative SOT.
        const sot5Validation = validateRollingSot({
          memoryDelta: memory5mSot, persistedDelta: persisted5mSot, cumulativeTotal: current.onTarget
        });
        const sot10Validation = validateRollingSot({
          memoryDelta: memory10mSot, persistedDelta: persisted10mSot, cumulativeTotal: current.onTarget
        });
        const onTarget = sot5Validation.value;
        const onTarget10m = sot10Validation.value;
        const perTeamMetricWindow = (currentRows, memoryBaseline, trend, metric, minAge, maxAge) => {
          let values = null;
          if (Array.isArray(currentRows) && Array.isArray(memoryBaseline) && currentRows.length >= 2) {
            const prior = new Map(memoryBaseline.filter(row => row?.team && row.value != null && Number.isFinite(Number(row.value))).map(row => [row.team, Number(row.value)]));
            const deltas = currentRows.slice(0, 2).map(row => {
              const old = prior.get(row.team);
              return row?.team && row.value != null && old != null && Number.isFinite(Number(row.value)) ? Math.max(0, Number(row.value) - old) : null;
            });
            if (deltas.some(value => value !== null)) values = deltas;
          }
          const age = Number(trend?.sampleMinutes);
          if (trend?.available && Array.isArray(trend.teams) && trend.teams.length >= 2 && Number.isFinite(age) && age >= minAge && age <= maxAge) {
            const trendMap = new Map(trend.teams.filter(row => row?.team).map(row => [String(row.team).trim().toLowerCase(), row[metric]]));
            const trendValues = currentRows.slice(0, 2).map(row => {
              const value = trendMap.get(row.team);
              return value == null || !Number.isFinite(Number(value)) ? null : Math.max(0, Number(value));
            });
            if (trendValues.some(value => value !== null)) values = !values ? trendValues : values.map((value, index) => trendValues[index] === null ? value : value === null ? trendValues[index] : Math.max(value, trendValues[index]));
          }
          return values;
        };
        const sotPressure5 = perTeamMetricWindow(current.sotByTeam, previous?.sotByTeam, match.trend?.window5m, "shotsOnTarget", 4.5, 8);
        const sotPressure10 = perTeamMetricWindow(current.sotByTeam, previous10?.sotByTeam, match.trend?.window10m, "shotsOnTarget", 8, 13);
        const dangerousAttacks5 = perTeamMetricWindow(current.dangerousByTeam, previous?.dangerousByTeam, match.trend?.window5m, "dangerousAttacks", 4.5, 8);
        const dangerousAttacks10 = perTeamMetricWindow(current.dangerousByTeam, previous10?.dangerousByTeam, match.trend?.window10m, "dangerousAttacks", 8, 13);
        const hunterBox5 = perTeamMetricWindow(current.shotsInBoxByTeam, previous?.shotsInBoxByTeam, match.trend?.window5m, "shotsInBox", 4.5, 8);
        const hunterBox10 = perTeamMetricWindow(current.shotsInBoxByTeam, previous10?.shotsInBoxByTeam, match.trend?.window10m, "shotsInBox", 8, 13);
        const hunterChances5 = perTeamMetricWindow(current.bigChancesByTeam, previous?.bigChancesByTeam, match.trend?.window5m, "bigChances", 4.5, 8);
        const hunterChances10 = perTeamMetricWindow(current.bigChancesByTeam, previous10?.bigChancesByTeam, match.trend?.window10m, "bigChances", 8, 13);
        // SOT alone controls activation. Shots in the Box and Big Chances only add score.
        const hunterWindow = (values, boxValues, chanceValues, baseline, trend, minAge, maxAge) => {
          const age = baseline ? (now - baseline.at) / 60000 : Number(trend?.sampleMinutes);
          const fresh = Number.isFinite(age) && age >= minAge && age <= maxAge;
          const rows = Array.isArray(values) ? values.slice(0, 2).map((value, index) => ({
            team: current.sotByTeam[index]?.team || "",
            shotsOnTarget: value,
            shotsInBox: Array.isArray(boxValues) ? boxValues[index] ?? null : null,
            bigChances: Array.isArray(chanceValues) ? chanceValues[index] ?? null : null
          })) : [];
          return {
            available: Boolean(fresh && rows.length === 2 && rows.every(row => row.shotsOnTarget != null && Number.isFinite(Number(row.shotsOnTarget)))),
            sampleMinutes: age,
            teams: rows
          };
        };
        const hunterEvaluation = evaluatePressureHunter({
          minute: current.minute,
          status: statusForEligibility,
          teams: current.sotByTeam.map(side => ({ shotsOnTarget: side.value })),
          windows: {
            last5m: hunterWindow(sotPressure5, hunterBox5, hunterChances5, previous, match.trend?.window5m, 4.5, 8),
            last10m: hunterWindow(sotPressure10, hunterBox10, hunterChances10, previous10, match.trend?.window10m, 8, 13)
          }
        });
        if (hunterEvaluation.triggered && hunterEvaluation.level) {
          const hunterKey = id + ":" + hunterEvaluation.level;
          if (!pushScanPressureHunterAlerts.has(hunterKey)) {
            const hunterAlertId = "hunter:" + id + ":" + hunterEvaluation.level;
            try {
              if (await ensurePressureHunterDb()) {
                const hunterRecord = {
                  alertId: hunterAlertId,
                  source: "pressure-hunter",
                  eventId: id,
                  level: hunterEvaluation.level,
                  createdAt: now,
                  home: match.home || match.homeTeam || "",
                  away: match.away || match.awayTeam || "",
                  league: match.league || match.competition || "",
                  country: match.country || match.countryName || null,
                  minute: formatPushMinute(match),
                  minuteNumber: current.minute,
                  score: hunterEvaluation.score,
                  reason: hunterEvaluation.reason,
                  statsAtSignal: hunterEvaluation.evidence,
                  scoreAtSignal: {
                    home: match.homeScore != null && Number.isFinite(Number(match.homeScore)) ? Number(match.homeScore) : null,
                    away: match.awayScore != null && Number.isFinite(Number(match.awayScore)) ? Number(match.awayScore) : null
                  },
                  settlementRule: "goal_after_signal_until_full_time",
                  outcome: "εκκρεμεί"
                };
                const saved = await analyticsPool.query(
                  "INSERT INTO pressure_hunter_history(alert_id,event_id,level,created_at,payload) VALUES($1,$2,$3,to_timestamp($4/1000.0),$5::jsonb) ON CONFLICT(alert_id) DO NOTHING RETURNING alert_id",
                  [hunterAlertId, id, hunterEvaluation.level, now, JSON.stringify(hunterRecord)]
                );
                pushScanPressureHunterAlerts.add(hunterKey);
                if (saved.rows.length) {
                  try {
                    const hunterPush = await sendPushToSubscribers({
                      title: "GoalMatrix · PRESSURE HUNTER",
                      body: (hunterEvaluation.level === "EXTREME" ? "🔥 EXTREME DUAL PRESSURE" : "🎯 DUAL TEAM PRESSURE") + " · " + hunterRecord.home + " – " + hunterRecord.away + " · " + hunterRecord.minute,
                      tag: "goal-matrix-pressure-hunter-" + id + "-" + hunterEvaluation.level.toLowerCase(),
                      url: "/"
                    });
                    sent += Number(hunterPush?.sent || 0);
                  } catch (hunterPushError) {
                    console.warn("Pressure Hunter push failed; dedicated history remains saved:", hunterPushError.message);
                  }
                  console.info("Pressure Hunter alert saved:", JSON.stringify({ eventId: id, level: hunterEvaluation.level, alertId: hunterAlertId }));
                }
              } else {
                console.error("Pressure Hunter alert not saved: dedicated persistent history unavailable", id);
              }
            } catch (hunterError) {
              console.error("Pressure Hunter dispatch failed:", hunterError.message);
            }
          }
        }
        const redCardCountsKnown = current.redCardsByTeam.length >= 2 && current.redCardsByTeam.slice(0, 2).every(side => side.value != null && Number.isFinite(Number(side.value)));
        const redCardSideIndex = redCardCountsKnown
          ? current.redCardsByTeam[0].value > current.redCardsByTeam[1].value ? 0
            : current.redCardsByTeam[1].value > current.redCardsByTeam[0].value ? 1 : -1
          : -1;
        let redCardInfo = pushScanRedCardSince.get(id) || null;
        // Prefer the provider's dated red-card incident when available. This fixes
        // the first-snapshot gap: if scanning starts after the card, there is no
        // red-card count transition to observe, even though the dismissal is real.
        if (redCardSideIndex >= 0) {
          const latestCardIncident = current.redCardIncidents
            .filter(incident => incident?.sideIndex === redCardSideIndex && Number.isFinite(incident.minute))
            .sort((a, b) => a.minute - b.minute)
            .slice(-1)[0] || null;
          if (latestCardIncident && Number.isFinite(current.minute)) {
            const minutesSinceCard = Math.max(0, current.minute - latestCardIncident.minute);
            const incidentAt = now - minutesSinceCard * 60 * 1000;
            // Use the first observed snapshot strictly after the dismissal.
            // This avoids counting pre-card SOT / dangerous attacks in the trigger.
            const baselineAtCard = snapshots.find(snapshot =>
              Number.isFinite(snapshot.minute) &&
              snapshot.minute > latestCardIncident.minute &&
              snapshot.minute - latestCardIncident.minute <= 2
            ) || null;
            redCardInfo = {
              team: current.redCardsByTeam[redCardSideIndex].team,
              at: incidentAt,
              advantagedTeam: current.sotByTeam[1 - redCardSideIndex]?.team || null,
              sotAtCard: baselineAtCard?.sotByTeam?.[1 - redCardSideIndex]?.value ?? null,
              dangerousAtCard: baselineAtCard?.dangerousByTeam?.[1 - redCardSideIndex]?.value ?? null
            };
            pushScanRedCardSince.set(id, redCardInfo);
          }
        }
        // Conservative fallback for feeds that expose red-card counts but no
        // incident timeline. Start the post-card evidence clock at first detection.
        if (redCardSideIndex >= 0 && !redCardInfo) {
          redCardInfo = {
            team: current.redCardsByTeam[redCardSideIndex].team,
            at: now,
            advantagedTeam: current.sotByTeam[1 - redCardSideIndex]?.team || null,
            sotAtCard: current.sotByTeam[1 - redCardSideIndex]?.value ?? null,
            dangerousAtCard: current.dangerousByTeam[1 - redCardSideIndex]?.value ?? null
          };
          pushScanRedCardSince.set(id, redCardInfo);
        }
        const redCardRecent = redCardSideIndex >= 0 && redCardInfo &&
          redCardInfo.team === current.redCardsByTeam[redCardSideIndex].team &&
          now - redCardInfo.at >= 0 && now - redCardInfo.at <= 15 * 60 * 1000;
        const advantagedSideIndex = redCardSideIndex >= 0 ? 1 - redCardSideIndex : -1;
        const redCardAge = redCardInfo ? now - redCardInfo.at : Infinity;
        const manAdvantageSot5 = redCardAge < 5 * 60 * 1000
          ? (redCardInfo?.sotAtCard == null || current.sotByTeam[advantagedSideIndex]?.value == null ? null : Math.max(0, current.sotByTeam[advantagedSideIndex].value - redCardInfo.sotAtCard))
          : sotPressure5?.[advantagedSideIndex] ?? null;
        const manAdvantageSot10 = redCardAge < 10 * 60 * 1000
          ? (redCardInfo?.sotAtCard == null || current.sotByTeam[advantagedSideIndex]?.value == null ? null : Math.max(0, current.sotByTeam[advantagedSideIndex].value - redCardInfo.sotAtCard))
          : sotPressure10?.[advantagedSideIndex] ?? null;
        const manAdvantageDanger5 = redCardAge < 5 * 60 * 1000
          ? (redCardInfo?.dangerousAtCard == null || current.dangerousByTeam[advantagedSideIndex]?.value == null ? null : Math.max(0, current.dangerousByTeam[advantagedSideIndex].value - redCardInfo.dangerousAtCard))
          : dangerousAttacks5?.[advantagedSideIndex] ?? null;
        const manAdvantageDanger10 = redCardAge < 10 * 60 * 1000
          ? (redCardInfo?.dangerousAtCard == null || current.dangerousByTeam[advantagedSideIndex]?.value == null ? null : Math.max(0, current.dangerousByTeam[advantagedSideIndex].value - redCardInfo.dangerousAtCard))
          : dangerousAttacks10?.[advantagedSideIndex] ?? null;
        const manAdvantagePressure = Boolean(redCardRecent && advantagedSideIndex >= 0 &&
          redCardInfo?.advantagedTeam === current.sotByTeam[advantagedSideIndex]?.team &&
          current.sotByTeam[advantagedSideIndex]?.value != null && current.sotByTeam[advantagedSideIndex].value >= 4 &&
          manAdvantageSot5 != null && manAdvantageSot5 >= 1 &&
          manAdvantageSot10 != null && manAdvantageSot10 >= 2 &&
          manAdvantageDanger5 != null && manAdvantageDanger5 >= 3 &&
          manAdvantageDanger10 != null && manAdvantageDanger10 >= 10);
        // AI trigger: recent SOT threshold OR the strict two-team xG alternative:
        // one team with xG >= 3.50 and the other with xG >= 2.50. Both values are required.
        const xGQualifies = teamXGValues.length >= 2 &&
          ((teamXGValues[0] != null && teamXGValues[0] >= 3.5 && teamXGValues[1] != null && teamXGValues[1] >= 2.5) ||
           (teamXGValues[1] != null && teamXGValues[1] >= 3.5 && teamXGValues[0] != null && teamXGValues[0] >= 2.5));
        const recentSotQualifies = onTarget >= 3 || onTarget10m >= 6;
        const corners = delta("corners");
        const attacks = delta("attacks"), dangerous = delta("dangerous");
        // Reuse the strict two-team xG qualification computed above.
        const xGDelta = xGQualifies && previous?.xG != null
          ? Math.max(0, Number(current.xG) - Number(previous.xG)) : null;
        const xGSupport = xGDelta == null ? 0 : Math.min(2, xGDelta * 2);
        // Only the strict two-team xG threshold can add xG support.
        const xGTotalSupport = bothTeamsXGQualified ? 2.5 : 0;
        // Match the reference pressure model: last-five-minute corners support the signal,
        // SOT and non-shot context remain the only eligible live evidence.
        const evidenceKinds = [onTarget, corners, attacks, dangerous].filter(value => value > 0).length;
        // Corners add limited supporting weight; they can never trigger an alert alone.
        // Clean-sheet history is not supplied consistently by this live feed, so it is not imputed.
        const totalOnTarget = current.onTarget == null ? 0 : Number(current.onTarget);
        const totalAttacks = current.attacks == null ? 0 : Number(current.attacks);
        const totalDangerous = current.dangerous == null ? 0 : Number(current.dangerous);
        const totalCorners = current.corners == null ? 0 : Number(current.corners);
        // Some live providers (including SportScore's current widget feed) do not publish dangerous attacks.
        // only when dangerous attacks are genuinely absent, without fabricating that statistic.
        const dangerousAvailable = current.dangerous != null && previous?.dangerous != null;
        const attacksAvailable = current.attacks != null && previous?.attacks != null;
        const scoreAvailable = match.homeScore != null && match.awayScore != null && Number.isFinite(Number(match.homeScore)) && Number.isFinite(Number(match.awayScore));
        // Independent AI trigger: use the exact weighted score displayed in the live Power Ranking.
        // It shares the approved AI time windows but does not depend on the existing SOT/xG triggers,
        // odds lookup, per-half alert cap, or their cooldowns.
        const powerRankingMinute = minuteForEligibility;
        const powerRankingEligible = isPowerRankingMinuteEligible(powerRankingMinute, statusForEligibility);
        const powerRankingScore = calculatePowerRankingScore({ teams, trend: match.trend });
        if (powerRankingEligible && powerRankingScore >= 59 && scoreAvailable && !pushScanPowerRankingAlerts.has(id)) {
          const alertId = "push:" + id + ":AI:power-ranking-59";
          try {
            if (await ensureAlertHistoryDb()) {
              const periodAtSignal = powerRankingMinute <= 35 ? "first_half" : "second_half";
              const homeScore = Number(match.homeScore), awayScore = Number(match.awayScore);
              const overLine = (homeScore + awayScore + 0.5).toFixed(1);
              const rawMinute = String(formatPushMinute(match));
              const alertRecord = {
                alertId, source: "server-push", eventId: id, level: "AI", createdAt: now,
                home: match.home || match.homeTeam || "", away: match.away || match.awayTeam || "",
                league: match.league || match.competition || "", country: match.country || match.countryName || null,
                minute: rawMinute, minuteNumber: powerRankingMinute,
                market: "Over " + overLine,
                alertType: "power_ranking_signal",
                odds: null, oddsVerifiedAt: null, periodAtSignal, reason: "Power Ranking " + powerRankingScore + "/100 · όριο 59+",
                outcome: "εκκρεμεί", betOutcome: "pending", evaluationRule: "end_of_relevant_half",
                startScore: homeScore + awayScore, startHomeScore: homeScore, startAwayScore: awayScore,
                triggerIds: ["power_ranking_59"], supportSignalIds: [],
                statsAtSignal: { powerRankingScore, powerRankingThreshold: 59, powerRankingWindow: periodAtSignal === "first_half" ? "1′–35′" : "46′–84′" }
              };
              const saved = await analyticsPool.query(
                "INSERT INTO alert_history(alert_id,event_id,level,created_at,payload,updated_at) VALUES($1,$2,'AI',to_timestamp($3/1000.0),$4::jsonb,NOW()) ON CONFLICT(alert_id) DO NOTHING RETURNING alert_id",
                [alertId, id, now, JSON.stringify(alertRecord)]
              );
              // The stable primary key makes the one-alert-per-match rule survive process restarts.
              pushScanPowerRankingAlerts.add(id);
              if (saved.rows.length) {
                powerRankingAlerts++;
                candidates++;
                try {
                  const pushResult = await sendPushToSubscribers({
                    title: "GoalMatrix · AI ALERT",
                    body: "🏆 POWER RANKING " + powerRankingScore + "/100 · " + (match.home || "Γηπεδούχος") + " – " + (match.away || "Φιλοξενούμενος") + " · Over " + overLine + " · " + (periodAtSignal === "first_half" ? "1ο ΗΜΙΧΡΟΝΟ" : "ΤΕΛΙΚΟ ΣΥΝΟΛΟ") + " · " + rawMinute,
                    tag: "goal-pulse-bg-ai-power-ranking-" + id, url: "/"
                  });
                  sent += Number(pushResult?.sent || 0);
                } catch (pushError) {
                  console.warn("Power Ranking AI push delivery failed; in-app alert remains saved:", pushError.message);
                }
                console.info("Power Ranking 59+ AI alert saved:", JSON.stringify({ eventId: id, minute: powerRankingMinute, period: periodAtSignal, score: powerRankingScore, alertId }));
              }
            } else {
              console.error("Power Ranking 59+ alert skipped: persistent history unavailable; one-per-match deduplication cannot be guaranteed", id);
            }
          } catch (powerRankingError) {
            console.error("Power Ranking 59+ AI alert failed:", powerRankingError.message);
          }
        }
        // Autonomous Power Ranking is a separate protocol: it does not depend on AI trigger 59+,
        // SOT/xG triggers, their cooldowns, or the AI Power Ranking deduplication state.
        const autonomousPowerRankingQualified = shouldEmitAutonomousPowerRankingAlert({
          score: powerRankingScore,
          eligible: powerRankingEligible,
          scoreAvailable
        });
        if (autonomousPowerRankingQualified && !pushScanAutonomousPowerRankingAlerts.has(id)) {
          const autonomousAlertId = "push:" + id + ":POWER_RANKING:autonomous-65";
          try {
            if (await ensureAlertHistoryDb()) {
              const autonomousPeriod = powerRankingMinute <= 35 ? "first_half" : "second_half";
              const autonomousHomeScore = Number(match.homeScore), autonomousAwayScore = Number(match.awayScore);
              const autonomousOverLine = (autonomousHomeScore + autonomousAwayScore + 0.5).toFixed(1);
              const autonomousRawMinute = String(formatPushMinute(match));
              const autonomousRecord = {
                alertId: autonomousAlertId, source: "server-push", eventId: id, level: "AI", createdAt: now,
                home: match.home || match.homeTeam || "", away: match.away || match.awayTeam || "",
                league: match.league || match.competition || "", country: match.country || match.countryName || null,
                minute: autonomousRawMinute, minuteNumber: powerRankingMinute,
                market: "Over " + autonomousOverLine,
                alertType: "power_ranking_autonomous_signal",
                odds: null, oddsVerifiedAt: null, periodAtSignal: autonomousPeriod,
                reason: "Αυτόνομο Power Ranking " + powerRankingScore + "/100 · όριο 65+",
                outcome: "εκκρεμεί", betOutcome: "pending", evaluationRule: "end_of_relevant_half",
                startScore: autonomousHomeScore + autonomousAwayScore,
                startHomeScore: autonomousHomeScore, startAwayScore: autonomousAwayScore,
                triggerIds: ["power_ranking_autonomous_65"], supportSignalIds: [],
                statsAtSignal: {
                  powerRankingScore,
                  powerRankingThreshold: 65,
                  powerRankingMode: "autonomous",
                  powerRankingWindow: autonomousPeriod === "first_half" ? "1′–35′" : "46′–84′"
                }
              };
              const autonomousSaved = await analyticsPool.query(
                "INSERT INTO alert_history(alert_id,event_id,level,created_at,payload,updated_at) VALUES($1,$2,'AI',to_timestamp($3/1000.0),$4::jsonb,NOW()) ON CONFLICT(alert_id) DO NOTHING RETURNING alert_id",
                [autonomousAlertId, id, now, JSON.stringify(autonomousRecord)]
              );
              // Stable unique alert_id prevents duplicates across scanner/process restarts.
              pushScanAutonomousPowerRankingAlerts.add(id);
              if (autonomousSaved.rows.length) {
                powerRankingAlerts++;
                candidates++;
                try {
                  const autonomousPushResult = await sendPushToSubscribers({
                    title: "GoalMatrix · POWER RANKING",
                    body: "🏆 ΑΥΤΟΝΟΜΟ POWER RANKING " + powerRankingScore + "/100 · " +
                      (match.home || "Γηπεδούχος") + " – " + (match.away || "Φιλοξενούμενος") +
                      " · Over " + autonomousOverLine + " · " +
                      (autonomousPeriod === "first_half" ? "1ο ΗΜΙΧΡΟΝΟ" : "2ο ΗΜΙΧΡΟΝΟ") +
                      " · " + autonomousRawMinute,
                    tag: "goalmatrix-autonomous-power-ranking-" + id,
                    url: "/"
                  });
                  sent += Number(autonomousPushResult?.sent || 0);
                } catch (autonomousPushError) {
                  console.warn("Autonomous Power Ranking push delivery failed; in-app alert remains saved:", autonomousPushError.message);
                }
                console.info("Autonomous Power Ranking 65+ alert saved:", JSON.stringify({
                  eventId: id, minute: powerRankingMinute, period: autonomousPeriod,
                  score: powerRankingScore, alertId: autonomousAlertId
                }));
              }
            } else {
              console.error("Autonomous Power Ranking 65+ alert skipped: persistent history unavailable", id);
            }
          } catch (autonomousPowerRankingError) {
            console.error("Autonomous Power Ranking 65+ alert failed:", autonomousPowerRankingError.message);
          }
        }
        const recentGoalEvidence = dangerousAvailable
          ? onTarget >= 1 && evidenceKinds >= 2 && dangerous >= 3
          : attacksAvailable && onTarget >= 1 && attacks >= 5;
        const sustainedGoalEvidence = dangerousAvailable
          ? totalOnTarget >= 4 && totalDangerous >= 20
          : attacksAvailable && totalOnTarget >= 4 && totalAttacks >= 60;
        // xG strengthens the candidate when available; missing xG never blocks evaluation.
        // Current-match SOT quality is supplemental, never a standalone trigger.
        // Use goals/SOT as a conservative live conversion indicator when the feed provides valid values.
        const homeGoalsLive = Number(match.homeScore);
        const awayGoalsLive = Number(match.awayScore);
        const goalsLiveAvailable = Number.isFinite(homeGoalsLive) && Number.isFinite(awayGoalsLive);
        const teamShotProfiles = teams.map((team, index) => {
          const teamGoals = goalsLiveAvailable ? (index === 0 ? homeGoalsLive : awayGoalsLive) : null;
          const teamOnTarget = Number(team.shotsOnTarget);
          return {
            onTarget: Number.isFinite(teamOnTarget) ? teamOnTarget : null,
            goals: teamGoals,
            conversionOnTarget: teamGoals != null && Number.isFinite(teamOnTarget) && teamOnTarget > 0
              ? Math.min(1, teamGoals / teamOnTarget) : null
          };
        });
        const liveConversionSupport = teamShotProfiles.reduce((sum, profile) => {
          if (profile.conversionOnTarget == null || profile.onTarget < 2) return sum;
          // Cap this bonus and require at least two SOT to reduce tiny-sample noise.
          return sum + Math.min(1, profile.conversionOnTarget * 1.5);
        }, 0);
        const shotQualitySupport = (current.shotsOnTargetInsideBox == null ? 0 : Math.min(2, current.shotsOnTargetInsideBox * 0.5)) + (current.bigChances == null ? 0 : Math.min(2, current.bigChances * 0.75));
        const basePoints = onTarget * 2 + Math.min(corners * 0.5, 2) + Math.min(attacks * 0.25, 3) + Math.min(dangerous * 0.75, 5) + xGSupport + xGTotalSupport + shotQualitySupport;
        const baseSustainedPoints = Math.min(totalOnTarget * 1.5, 9) + Math.min(totalCorners * 0.15, 2) + Math.min(totalDangerous * 0.05, 3) + (dangerousAvailable ? 0 : Math.min(totalAttacks * 0.025, 2)) + xGTotalSupport + shotQualitySupport;
        // Historical Dirty Sheet = percentage of recent completed matches in which a team conceded at least one goal.
        // Only fetch history for live-pressure candidates; unavailable history contributes zero, not invented data.
        const livePressureCandidate = scoreAvailable && ((recentGoalEvidence && basePoints + liveConversionSupport >= 5.5) || (sustainedGoalEvidence && baseSustainedPoints + liveConversionSupport >= 8));
        let dirtySheet = { support: 0, homeRate: null, awayRate: null, sample: 0 };
        if (livePressureCandidate) {
          try { dirtySheet = await getDirtySheetSupport(match.leagueCode, match.home, match.away); }
          catch (error) { console.warn("Optional Dirty Sheet support failed; AI triggers continue independently:", error.message); }
        }
        const dirtySheetSupport = Number(dirtySheet.support || 0);
        // Evaluate the exact Over line implied by the live score; one team's recent
        // league Over record can add support, but never blocks or triggers an alert.
        const liveGoalsForLine = Number(match.homeScore) + Number(match.awayScore);
        const supportingOverLine = Number.isFinite(liveGoalsForLine) ? Number((liveGoalsForLine + 0.5).toFixed(1)) : null;
        let historicalOver = { support: 0, homeRate: null, awayRate: null, homeSample: 0, awaySample: 0, line: supportingOverLine };
        if (livePressureCandidate && supportingOverLine != null) {
          try { historicalOver = await getHistoricalOverSupport(match.leagueCode, match.home, match.away, supportingOverLine); }
          catch (error) { console.warn("Optional historical Over support failed; AI triggers continue independently:", error.message); }
        }
        // Historical and conversion signals remain supporting context only.
        let preMatchSeason = { support: 0, homeRate: null, awayRate: null, homeSample: 0, awaySample: 0, season: null };
        if (livePressureCandidate && supportingOverLine != null) {
          try { preMatchSeason = await getPreMatchSeasonSupport(match.leagueCode, match.home, match.away, supportingOverLine); }
          catch (error) { console.warn("Optional pre-match season support failed; AI triggers continue independently:", error.message); }
        }
        // Historical context can adjust evidence ranking only; independent SOT/xG
        // trigger qualification below remains unchanged and history cannot create/veto alerts.
        const matchupEvidence = scorePreMatchMatchupContext(preMatchSeason.context);
        const supportingCriteriaScore = dirtySheetSupport + Number(historicalOver.support || 0) +
          Number(preMatchSeason.support || 0) + Number(matchupEvidence.score || 0) + liveConversionSupport;
        const points = basePoints + supportingCriteriaScore;
        const sustainedPoints = baseSustainedPoints + supportingCriteriaScore;
        // Updated second-half AI protocol window: 46′–84′ for every second-half trigger.
        // Independent first-half exception: 8+ combined match SOT by minute 34.
        const aiMinute = parseLiveMinute(getMatchMinute(match));
        const eligibleMinute = isAiMinuteEligible(aiMinute, statusForEligibility);
        const firstHalfSotWindow = isFirstHalfSotMinute(aiMinute, statusForEligibility);
        // The 3+ SOT / 5m and 6+ SOT / 10m triggers are independent OR conditions
        // in both halves. Previously the shared rolling signal was calculated but
        // the first-half decision path admitted only the separate 8+ cumulative trigger.
        const firstHalfRecentSotQualifies = firstHalfSotWindow && recentSotQualifies;
        const firstHalfEightSotWindow = isFirstHalfEightSotMinute(aiMinute, statusForEligibility);
        const firstHalfEightSotQualifies = firstHalfEightSotWindow &&
          current.onTarget != null && Number(current.onTarget) >= 8;
        const cumulativeSotWindow = isCumulativeSotMinute(aiMinute, statusForEligibility);
        const combined20SotQualifies = cumulativeSotWindow && current.onTarget != null && Number(current.onTarget) >= 20;
        const cumulativeSotQualifies = combined20SotQualifies;
        // Every SOT-derived trigger must survive a second provider sample with
        // non-decreasing per-team cumulative SOT. This is separate from xG,
        // which remains an independent alternative trigger.
        // Confirm each SOT trigger against its own state. A sample qualifying one
        // trigger can never confirm, reset, or suppress another trigger.
        const sotTriggerConditions = [
          ["recent_sot_pressure", recentSotQualifies && (eligibleMinute || firstHalfSotWindow)],
          ["cumulative_20_sot", cumulativeSotQualifies],
          ["first_half_8_sot", firstHalfEightSotQualifies],
          ["man_advantage_pressure", eligibleMinute && manAdvantagePressure]
        ];
        // Keep one fixture-wide provider-integrity guard in addition to per-trigger
        // confirmations. A provider correction must quarantine every SOT trigger,
        // including a trigger whose own confirmation state did not observe the regression.
        let providerSotIntegrity = { confirmed: false, reason: "provider_integrity_unchecked", regression: false };
        try {
          providerSotIntegrity = confirmSotSignal({
            stateMap: pushScanSotConfirmations,
            eventId: id,
            now,
            qualifies: true,
            cumulativeByTeam: current.sotByTeam
          });
        } catch (error) {
          providerSotIntegrity = { confirmed: false, reason: "provider_integrity_error", regression: false };
          console.error("Fixture-wide SOT provider integrity check failed closed:", JSON.stringify({ eventId: id, error: String(error.message || error).slice(0, 160) }));
        }
        const confirmedSotTriggerIds = [];
        const sotConfirmationReasons = {};
        const sotConfirmationRegressions = {};
        for (const [triggerId, triggerQualifies] of sotTriggerConditions) {
          try {
            const confirmation = confirmSotSignal({
              stateMap: pushScanSotConfirmations,
              eventId: sotTriggerConfirmationKey(id, triggerId),
              now,
              qualifies: Boolean(providerSotIntegrity.confirmed && triggerQualifies),
              cumulativeByTeam: current.sotByTeam
            });
            sotConfirmationReasons[triggerId] = confirmation.reason;
            sotConfirmationRegressions[triggerId] = confirmation.regression;
            if (confirmation.confirmed) confirmedSotTriggerIds.push(triggerId);
          } catch (error) {
            sotConfirmationReasons[triggerId] = "trigger_confirmation_error";
            sotConfirmationRegressions[triggerId] = false;
            console.error("SOT confirmation failed for one trigger only:", JSON.stringify({ eventId: id, triggerId, error: String(error.message || error).slice(0, 160) }));
          }
        }
        const sotSignalQualifies = sotTriggerConditions.some(([, qualifies]) => qualifies);
        const confirmedSotSignal = confirmedSotTriggerIds.length > 0;
        const qualifiedAiTriggers = buildIndependentAiTriggers({
          eligibleMinute,
          firstHalfSotWindow,
          recentSotQualifies,
          cumulativeSotQualifies,
          firstHalfEightSotQualifies,
          manAdvantagePressure,
          xGQualifies,
          confirmedSotTriggerIds
        });
        const secondHalfAiQualifies = eligibleMinute && qualifiedAiTriggers.some(trigger => trigger.id !== "first_half_8_sot");
        const firstHalfSotAiQualifies = firstHalfSotWindow && qualifiedAiTriggers.some(trigger => trigger.id === "recent_sot_pressure" || trigger.id === "first_half_8_sot");
        const isAiGoal = scoreAvailable && qualifiedAiTriggers.length > 0;
        // Keep the first 16 general samples, but never omit an eligible 46′–84′ second-half match.
        // This makes the scanner diagnostics useful when late matches dominate feed ordering.
        if (eligibleMinute || firstHalfSotWindow || aiSignalDiagnostics.length < 16) aiSignalDiagnostics.push({
          home: String(match.home || ""),
          away: String(match.away || ""),
          minute: Number.isFinite(aiMinute) ? aiMinute : null,
          status: String(match.statusText || match.status || match.status_text || ""),
          scoreAvailable,
          statsAvailable: Boolean(match.statsAvailable),
          sot5m: onTarget,
          sot10m: onTarget10m,
          sotCumulativeTotal: current.onTarget,
          sot5mValidation: sot5Validation,
          sot10mValidation: sot10Validation,
          xGHome: teamXGValues[0],
          xGAway: teamXGValues[1],
          recentSotQualifies,
          sotSignalQualifies,
          sotSignalConfirmed: confirmedSotSignal,
          sotSignalConfirmationReason: sotConfirmationReasons,
          sotProviderRegression: sotConfirmationRegressions,
          fixtureSotProviderIntegrity: { confirmed: providerSotIntegrity.confirmed, reason: providerSotIntegrity.reason, regression: providerSotIntegrity.regression },
          firstHalfSotWindow,
          firstHalfRecentSotQualifies,
          firstHalfEightSotQualifies,
          xGQualifies,
          combined20SotQualifies,
          cumulativeSotQualifies,
          manAdvantagePressure,
          redCardsByTeam: current.redCardsByTeam,
          redCardCountsKnown,
          redCardSideIndex,
          redCardRecent: Boolean(redCardRecent),
          redCardAgeSeconds: Number.isFinite(redCardAge) ? Math.round(redCardAge / 1000) : null,
          redCardIncidentMinutes: current.redCardIncidents.map(incident => incident.minute),
          manAdvantageSot5,
          manAdvantageSot10,
          manAdvantageDanger5,
          manAdvantageDanger10,
          dangerousAttacks5,
          dangerousAttacks10,
          eligibleMinute,
          qualifies: isAiGoal,
          qualifiedTriggerIds: qualifiedAiTriggers.map(trigger => trigger.id),
          rejection: !scoreAvailable ? "score_missing" : qualifiedAiTriggers.length ? "qualified_independent_triggers" : sotSignalQualifies && !confirmedSotSignal ? "awaiting_independent_sot_confirmation" : !eligibleMinute && !firstHalfSotWindow ? "minute_outside_approved_ai_window" : "no_independent_trigger_qualified"
        });
        const isVip = false; // VIP alerts are selected manually from HI ACTIVITY in the frontend.
        const levels = isAiGoal ? qualifiedAiTriggers.map(trigger => ({ level: "AI", triggerId: trigger.id })) : [];
        if (isAiGoal) strongSignals++;
        // Dispatch each qualifying AI trigger independently; no trigger shares another's cap or cooldown.
        for (const { level, triggerId } of levels) {
          try {
          // Final fail-closed guard immediately before any AI push work.
          // Do not rely only on the earlier candidate calculation: the exact displayed
          // minute is checked again at dispatch so stale/mismatched clock fields cannot
          // send an alert after the agreed window.
          const dispatchMinute = parseLiveMinute(getMatchMinute(match));
          const dispatchMinuteAllowed = Number.isFinite(dispatchMinute) &&
            ((dispatchMinute >= 1 && dispatchMinute <= 40) || (dispatchMinute >= 46 && dispatchMinute <= 84));
          if (level === "AI" && !dispatchMinuteAllowed) {
            console.warn("[AI push blocked: minute outside protocol window]", JSON.stringify({
              eventId: String(match.eventId),
              minute: getMatchMinute(match),
              parsedMinute: Number.isFinite(dispatchMinute) ? dispatchMinute : null,
              status: String(match.statusText || match.status || match.status_text || "")
            }));
            continue;
          }
          // Prefer a verified, active quote for the exact score-derived line and period.
          // If the provider has no licensed live-bookmaker coverage, keep the qualified
          // pressure signal but label the missing price explicitly; never invent odds.
          let verifiedOdds = null;
          // Compare the stats-feed score with the freshest joined scoreboard before
          // issuing a market. If the sources disagree, skip this scan rather than
          // sending a stale Over line after the target may already have been reached.
          const scoreValueForAlert = value => {
            if (value === null || value === undefined || value === "") return null;
            const n = Number(value);
            return Number.isFinite(n) ? n : null;
          };
          const scoreEventForAlert = scoreboardEvents.find(event => String(event.id || "") === id);
          const competitorsForAlert = scoreEventForAlert?.competitions?.[0]?.competitors || [];
          const homeCompetitorForAlert = competitorsForAlert.find(team => team.homeAway === "home") || competitorsForAlert[0];
          const awayCompetitorForAlert = competitorsForAlert.find(team => team.homeAway === "away") || competitorsForAlert[1];
          const statsHomeScore = scoreValueForAlert(match.homeScore);
          const statsAwayScore = scoreValueForAlert(match.awayScore);
          const boardHomeScore = scoreValueForAlert(homeCompetitorForAlert?.score);
          const boardAwayScore = scoreValueForAlert(awayCompetitorForAlert?.score);
          if (statsHomeScore !== null && statsAwayScore !== null &&
              boardHomeScore !== null && boardAwayScore !== null &&
              (statsHomeScore !== boardHomeScore || statsAwayScore !== boardAwayScore)) {
            console.info("AI alert skipped: live score sources disagree", JSON.stringify({
              eventId: id, match: match.home + " – " + match.away,
              statsScore: statsHomeScore + "-" + statsAwayScore,
              scoreboardScore: boardHomeScore + "-" + boardAwayScore
            }));
            continue;
          }
          const currentHomeScore = statsHomeScore ?? boardHomeScore;
          const currentAwayScore = statsAwayScore ?? boardAwayScore;
          if (currentHomeScore === null || currentAwayScore === null) continue;
          const currentGoalsForMarketCheck = currentHomeScore + currentAwayScore;
          // Query real live Over odds for the exact score-derived line and period.
          // If no trustworthy quote is available, keep odds unknown rather than inventing a price.
          const targetOverLine = Number((currentGoalsForMarketCheck + 0.5).toFixed(1));
          const oddsMinute = parseLiveMinute(getMatchMinute(match));
          const oddsStatus = String(match.statusText || match.status || match.status_text || "").toLowerCase();
          // At HT the first-half market has ended; use the full-match market for the second-half remainder.
          const isHalfTime = /\bht\b|half.?time|halftime|ανάπαυλα/.test(oddsStatus) ||
            String(getMatchMinute(match) || "").trim().toLowerCase() === "ht";
          const oddsPeriod = (Number.isFinite(oddsMinute) && oddsMinute > 45) ||
            /second half|2nd half|2ο ημίχρονο/.test(oddsStatus) || isHalfTime
            ? "second_half" : "first_half";
          if (oddsPeriod === "first_half") firstHalfOddsChecks++;
          try {
            verifiedOdds = await getVerifiedOver(match, targetOverLine, oddsPeriod);
            if (verifiedOdds && Number.isFinite(Number(verifiedOdds.price)) && Number(verifiedOdds.price) > 1) oddsVerifiedCount++;
            else oddsMissingCount++;
          } catch (oddsError) {
            oddsErrors++;
            oddsMissingCount++;
            console.warn("Verified live odds lookup failed:", String(oddsError.message || oddsError).slice(0, 180));
          }
          const hasOddsQuote = Boolean(verifiedOdds);
          const validOddsQuote = hasOddsQuote &&
            Number.isFinite(Number(verifiedOdds.price)) && Number(verifiedOdds.price) > 1 &&
            Number.isFinite(Number(verifiedOdds.line)) &&
            Math.abs(Number(verifiedOdds.line) - targetOverLine) <= 0.001;
          if (hasOddsQuote && !validOddsQuote) {
            // Odds are display context, never a trigger gate. Discard only the bad quote;
            // keep this independently qualified AI trigger eligible for dispatch.
            console.info("AI alert quote discarded without suppressing trigger", JSON.stringify({
              eventId: id, triggerId, match: (match.home || "") + " – " + (match.away || ""),
              period: oddsPeriod, targetLine: targetOverLine,
              verifiedPrice: verifiedOdds?.price ?? null,
              reason: "invalid_or_mismatched_market"
            }));
            verifiedOdds = null;
          }
          const cooldownKey = id + ":" + level + ":" + triggerId;
          const alertHalf = oddsPeriod === "second_half" ? "second_half" : "first_half";
          const perHalfCountKey = id + ":" + alertHalf + ":" + triggerId;
          if ((alertCountsByMatchHalf.get(perHalfCountKey) || 0) >= 4) {
            console.info("AI trigger alert skipped: its own per-half limit reached", JSON.stringify({ eventId: id, triggerId, half: alertHalf, limit: 4 }));
            continue;
          }
          const lastAlert = pushScanLastAlert.get(cooldownKey);
          if (lastAlert && now - Number(lastAlert.at || 0) < 8 * 60 * 1000) {
            const onTargetSinceLast = current.onTarget != null && lastAlert.onTarget != null ? Number(current.onTarget) - Number(lastAlert.onTarget) : 0;
            const cornersSinceLast = current.corners != null && lastAlert.corners != null ? Number(current.corners) - Number(lastAlert.corners) : 0;
            const xGSinceLast = current.xG != null && lastAlert.xG != null ? Number(current.xG) - Number(lastAlert.xG) : 0;
            const oddsImproved = Boolean(verifiedOdds && Number.isFinite(Number(verifiedOdds.price)) && Number(verifiedOdds.price) >= Number(lastAlert.price || 0) + 0.05);
            // Re-alert only when the match adds new SOT/xG evidence.
            if (onTargetSinceLast < 1 && cornersSinceLast < 2 && xGSinceLast < 0.2 && !oddsImproved) continue;
          }
          const reason = [
            triggerId,
            onTarget ? onTarget + " νέα σουτ στην εστία στο 5λεπτο" : "",
            onTarget10m >= 6 ? onTarget10m + " σουτ στην εστία στα τελευταία 10′" : "",
            corners ? corners + " νέα κόρνερ" : "",
            totalXG != null && Number.isFinite(totalXG) ? "xG " + totalXG.toFixed(2) : "",
            attacks ? attacks + " νέες επιθέσεις" : "",
            dangerous ? dangerous + " νέες επικίνδυνες επιθέσεις" : "",
            current.shotsOnTargetInsideBox != null ? current.shotsOnTargetInsideBox + " σουτ εντός εστίας από την περιοχή" : "",
            current.bigChances != null ? current.bigChances + " μεγάλες ευκαιρίες" : "",
            cumulativeSotQualifies ? "20+ συνολικά SOT πριν από το 75′" : "",
            manAdvantagePressure ? "MAN ADVANTAGE PRESSURE (κόκκινη κάρτα + 4+ SOT, 2+/10′, 1+/5′, 10+/3+ επικίνδυνες επιθέσεις)" : "",
            dirtySheetSupport > 0 ? "Dirty Sheet +" + dirtySheetSupport.toFixed(1) : "",
            historicalOver.support > 0 ? "Ιστορικό Over " + supportingOverLine + " +" + Number(historicalOver.support).toFixed(1) : "",
            preMatchSeason.context?.home?.goalsForAvg != null ? "Home GF/GA " + preMatchSeason.context.home.goalsForAvg.toFixed(2) + "/" + (preMatchSeason.context.home.goalsAgainstAvg == null ? "—" : preMatchSeason.context.home.goalsAgainstAvg.toFixed(2)) : "",
            preMatchSeason.context?.away?.goalsForAvg != null ? "Away GF/GA " + preMatchSeason.context.away.goalsForAvg.toFixed(2) + "/" + (preMatchSeason.context.away.goalsAgainstAvg == null ? "—" : preMatchSeason.context.away.goalsAgainstAvg.toFixed(2)) : "",
            preMatchSeason.context?.home?.cleanSheetRate != null ? "Home clean sheets " + Math.round(preMatchSeason.context.home.cleanSheetRate * 100) + "%" : "",
            preMatchSeason.context?.away?.cleanSheetRate != null ? "Away clean sheets " + Math.round(preMatchSeason.context.away.cleanSheetRate * 100) + "%" : "",
            preMatchSeason.context?.expectedGoals?.total != null ? "Season goal estimate " + preMatchSeason.context.expectedGoals.total.toFixed(2) + " (heuristic)" : "",
            preMatchSeason.context?.headToHead?.available ? "H2H " + preMatchSeason.context.headToHead.sample + " αγώνες" : "",
            ...matchupEvidence.reasons,
            liveConversionSupport > 0 ? "Αποτελεσματικότητα SOT +" + liveConversionSupport.toFixed(1) : ""
          ].filter(Boolean).join(" · ");
          // Store a price only when the exact active market quote was verified.
          const hasVerifiedOdds = Boolean(verifiedOdds && Number.isFinite(Number(verifiedOdds.price)) && Number(verifiedOdds.price) > 1 && Number.isFinite(Number(verifiedOdds.line)) && Math.abs(Number(verifiedOdds.line) - targetOverLine) <= 0.001);
          // Reuse the same validated score snapshot for the alert line and history.
          const overLine = targetOverLine.toFixed(1);
          const alertTitle = level === "VIP" ? "GoalMatrix · ◆ VIP ALERT" : "GoalMatrix · AI ALERT";
          const notificationMinute = parseLiveMinute(getMatchMinute(match));
          const minutePrefix = Number.isFinite(notificationMinute) ? notificationMinute + "′ " : "";
          const marketLabel = oddsPeriod === "second_half" ? "Τελικό σύνολο Over " : "1ο ημίχ. Over ";
          const priceSuffix = hasVerifiedOdds
            ? " @" + Number(verifiedOdds.price).toFixed(2)
            : " (χωρίς επιβεβαιωμένη απόδοση)";
          const activatedSotRule = onTarget >= 3 ? "SOT 3+/5′" : onTarget10m >= 6 ? "SOT 6+/10′" : "SOT signal";
          const alertBody = minutePrefix + (match.home || "Γηπεδούχος") + " – " + (match.away || "Φιλοξενούμενος") + ", " + marketLabel + overLine + " · " + String(match.country || match.countryName || match.league || match.competition || "Live");
          const volatileAlertId = "push:" + id + ":" + level + ":" + triggerId + ":" + now;
          saveVolatileRecord(volatileAlertHistory, volatileAlertId, {
            alertId: volatileAlertId, source: "server-push", eventId: id, level, alertType: triggerId, triggerIds: [triggerId], createdAt: now,
            home: match.home || match.homeTeam || "", away: match.away || match.awayTeam || "",
            league: match.league || match.competition || "", country: match.country || match.countryName || null, minute: formatPushMinute(match),
            market: "Over " + overLine, odds: hasVerifiedOdds ? verifiedOdds.price : null,
            bookmaker: hasVerifiedOdds ? verifiedOdds.bookmaker : null,
            periodAtSignal: oddsPeriod, reason, outcome: "εκκρεμεί", betOutcome: "pending",
            evaluationRule: "end_of_relevant_half",
            ...(currentHomeScore != null && currentAwayScore != null ? { startScore: Number(currentHomeScore) + Number(currentAwayScore), startHomeScore: Number(currentHomeScore), startAwayScore: Number(currentAwayScore) } : {}),
            statsAtSignal: { onTarget, onTarget10m, totalOnTarget, manAdvantagePressure, redCardTeam: redCardInfo?.team || null, advantagedTeam: redCardInfo?.advantagedTeam || null, manAdvantageSot5, manAdvantageSot10, manAdvantageDanger5, manAdvantageDanger10, sotPressure5, sotPressure10, dangerousAttacks5, dangerousAttacks10, corners, attacks, dangerous, preMatchHistory: preMatchSeason.context || null, ...(totalXG != null ? { xG: totalXG } : {}) }
          }, ["betOutcome", "outcome", "betSettlementLabel", "betFinalScore", "betSettledAt", "evaluatedAt", "evaluationRule"]);
          // Persist every protocol-qualified AI alert independently of push delivery.
          // Push subscriptions are optional; an empty subscriber list must not hide alerts in-app.
          {
            alertCountsByMatchHalf.set(perHalfCountKey, (alertCountsByMatchHalf.get(perHalfCountKey) || 0) + 1);
            pushScanLastAlert.set(cooldownKey, {
              at: now,
              onTarget: current.onTarget,
              corners: current.corners,
              xG: current.xG,
              price: hasVerifiedOdds ? Number(verifiedOdds.price) : null
            });
            // Persist the server-generated AI alert, whether or not any browser push subscriber exists.
            // This record is also the source of truth for later outcome evaluation.
            try {
              if (await ensureAlertHistoryDb()) {
                const alertId = "push:" + id + ":" + level + ":" + triggerId + ":" + now;
                const scoreValue = value => {
                  const n = Number(value);
                  return value !== null && value !== undefined && value !== "" && Number.isFinite(n) ? n : null;
                };
                const scoreEvent = scoreboardEvents.find(event => String(event.id || "") === id);
                const competitors = scoreEvent?.competitions?.[0]?.competitors || [];
                const homeCompetitor = competitors.find(team => team.homeAway === "home") || competitors[0];
                const awayCompetitor = competitors.find(team => team.homeAway === "away") || competitors[1];
                const homeScore = currentHomeScore;
                const awayScore = currentAwayScore;
                const rawMinute = String(formatPushMinute(match));
                const minuteMatch = rawMinute.match(/(\d{1,3})(?:\s*\+\s*\d{1,2})?/);
                const minuteNumber = minuteMatch ? Number(minuteMatch[1]) : null;
                const statusDetail = String(match.statusText || match.status || scoreEvent?.competitions?.[0]?.status?.type?.detail || scoreEvent?.status?.type?.detail || "").toLowerCase();
                const statusClock = String(match.minute || scoreEvent?.competitions?.[0]?.status?.displayClock || scoreEvent?.status?.displayClock || "");
                const halfTime = /half.?time|halftime|ημίχρονο/.test(statusDetail);
                const secondHalf = /second half|2nd half|2ο ημίχρονο/.test(statusDetail) || (minuteNumber !== null && minuteNumber > 45) || /second half|2nd half/i.test(statusClock);
                const alertRecord = {
                  alertId, source: "server-push", eventId: id, level,
                  createdAt: now, home: homeCompetitor?.team?.displayName || match.home || match.homeTeam || "",
                  away: awayCompetitor?.team?.displayName || match.away || match.awayTeam || "",
                  league: scoreEvent?.competitions?.[0]?.name || match.league || match.competition || "",
                  country: match.country || match.countryName || scoreEvent?.competitions?.[0]?.country?.name || scoreEvent?.leagues?.[0]?.name || null,
                  minute: rawMinute, minuteNumber,
                  market: "Over " + overLine,
                  odds: hasVerifiedOdds ? verifiedOdds.price : null,
                  bookmaker: hasVerifiedOdds ? verifiedOdds.bookmaker : null,
                  alertType: triggerId,
                  ...(hasVerifiedOdds ? { oddsVerifiedAt: new Date(now).toISOString() } : { oddsVerifiedAt: null }),
                  periodAtSignal: halfTime ? "halftime" : secondHalf ? "second_half" : "first_half",
                  reason, outcome: "εκκρεμεί", evaluationRule: "end_of_relevant_half",
                  ...(homeScore !== null && awayScore !== null ? { startScore: homeScore + awayScore, startHomeScore: homeScore, startAwayScore: awayScore } : {}),
                  triggerIds: [triggerId],
                  supportSignalIds: [
                    ...(Array.isArray(dangerousAttacks5) && dangerousAttacks5.some(value => value != null && value >= 3) ||
                       Array.isArray(dangerousAttacks10) && dangerousAttacks10.some(value => value != null && value >= 10)
                      ? ["dangerous_attacks_pressure"] : [])
                  ],
                  statsAtSignal: { onTarget, onTarget10m, totalOnTarget, xGQualifies, recentSotQualifies, cumulativeSotQualifies, manAdvantagePressure, manAdvantageSot5, manAdvantageSot10, manAdvantageDanger5, manAdvantageDanger10, dangerousAttacks5, dangerousAttacks10, teamShotProfiles, liveConversionSupport, ...(current.shotsOnTargetInsideBox != null ? { shotsOnTargetInsideBox: current.shotsOnTargetInsideBox } : {}), ...(current.bigChances != null ? { bigChances: current.bigChances } : {}), corners, attacks, dangerous, ...(totalXG != null && Number.isFinite(totalXG) ? { xG: totalXG } : {}), ...(xGDelta != null ? { xGDelta } : {}), dirtySheetSupport, dirtySheetHomeRate: dirtySheet.homeRate, dirtySheetAwayRate: dirtySheet.awayRate, dirtySheetSample: dirtySheet.sample, historicalOverLine: historicalOver.line, historicalOverSupport: historicalOver.support, historicalOverHomeRate: historicalOver.homeRate, historicalOverAwayRate: historicalOver.awayRate, historicalOverHomeSample: historicalOver.homeSample, historicalOverAwaySample: historicalOver.awaySample, preMatchHistory: preMatchSeason.context || null, preMatchHistoryScore: matchupEvidence.score, preMatchHistoryReasons: matchupEvidence.reasons, supportingCriteriaScore, evidenceKinds, points }
                };
                await analyticsPool.query(
                  "INSERT INTO alert_history(alert_id,event_id,level,created_at,payload,updated_at) VALUES($1,$2,$3,to_timestamp($4/1000.0),$5::jsonb,NOW()) ON CONFLICT(alert_id) DO NOTHING",
                  [alertId, id, level, now, JSON.stringify(alertRecord)]
                );
                console.log("AI alert history saved independently of push delivery:", JSON.stringify({ alertId, eventId: id, level, alertType: alertRecord.alertType || "verified_odds" }));
              } else {
                console.error("Qualified AI alert could not be saved because persistent history database is unavailable:", id);
              }
            } catch (historyError) {
              console.error("Qualified AI alert history save failed:", historyError.message);
            }
          }
          try {
            const pushResult = await sendPushToSubscribers({
              title: alertTitle,
              body: alertBody.slice(0, 240),
              tag: "goal-pulse-bg-" + level.toLowerCase() + "-" + id + "-" + triggerId,
              url: "/"
            });
            sent += Number(pushResult?.sent || 0);
          } catch (pushError) {
            console.warn("AI alert push delivery failed; in-app alert remains saved:", pushError.message);
          }
          candidates++;
          } catch (triggerDispatchError) {
            console.error("Independent AI trigger dispatch failed:", JSON.stringify({ eventId: id, triggerId, error: String(triggerDispatchError.message || triggerDispatchError).slice(0, 180) }));
            continue;
          }
        }
      }
      // Each map value is an array of snapshots; inspect the newest snapshot when pruning stale matches.
      for (const [id, snapshots] of pushScanSnapshots) {
        const latest = Array.isArray(snapshots) && snapshots.length ? snapshots[snapshots.length - 1] : null;
        if (!latest || now - latest.at > 15 * 60 * 1000) {
          pushScanSnapshots.delete(id);
          pushScanSotConfirmations.delete(String(id));
          for (const confirmationKey of pushScanSotConfirmations.keys()) {
            if (confirmationKey.startsWith(String(id) + "::")) pushScanSotConfirmations.delete(confirmationKey);
          }
          pushScanRedCardSince.delete(id);
          pushScanPowerRankingAlerts.delete(id);
          pushScanAutonomousPowerRankingAlerts.delete(id);
          for (const hunterKey of pushScanPressureHunterAlerts) if (hunterKey.startsWith(id + ":")) pushScanPressureHunterAlerts.delete(hunterKey);
        }
      }
      const liveMatches = Number(metrics.totalLive || 0);
      const statsMatches = (metrics.matches || []).filter(match => match.statsAvailable).length;
      let subscribers = pushSubscriptions.size;
      if (await ensurePushDb()) {
        try {
          const subscriberResult = await analyticsPool.query("SELECT COUNT(*)::int AS count FROM push_subscriptions");
          subscribers = subscriberResult.rows[0].count;
        } catch {}
      }
      const liveMatchSamples = (metrics.matches || []).filter(match => match.statsAvailable).slice(0, 5).map(match => ({ home: match.home || "", away: match.away || "", minute: match.minute ?? match.elapsed ?? match.liveMinute ?? match.live_minute ?? match.time?.elapsed ?? match.time?.minute ?? null, status: String(match.statusText || match.status || match.status_text || ""), homeScore: match.homeScore ?? null, awayScore: match.awayScore ?? null }));
      return send(res, 200, { ok: true, liveMatches, statsMatches, checked, candidates, deliveries: sent, subscribers, date, pushConfigured: Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY), diagnostics: { oddsProviderConfigured: Boolean(getOddsPapiApiKey() || getApiFootballKey()), powerRankingAlerts, scoreboardJoinedMatches, scoreboardJoinSamples, liveMatchSamples, statsDiagnostics: (metrics.matches || []).filter(match => match.statsAvailable).slice(0, 8).map(match => ({ home: match.home || "", away: match.away || "", minute: getMatchMinute(match), statsSource: match.statsSource || "unknown", statsAvailable: Boolean(match.statsAvailable), teams: (match.teams || []).map(team => ({ team: team.team || "", shotsOnTarget: team.shotsOnTarget ?? null, xG: team.xG ?? null })) })),  statsMissingSOT: (metrics.matches || []).filter(match => match.statsAvailable && (!Array.isArray(match.teams) || match.teams.length < 2 || match.teams.some(team => team.shotsOnTarget == null))).length, secondHalfEligible, strongSignals, aiSignalDiagnostics, firstHalfOddsChecks, oddsVerified: oddsVerifiedCount, oddsMissing: oddsMissingCount, oddsErrors } });
    } catch (error) {
      console.error("Background push scan failed:", error.message);
      return send(res, 503, { error: "Background scan failed", detail: error.message });
    }
  }

  if (url.pathname === "/api/health") {
    let databaseConnected = false;
    if (analyticsPool) {
      try { await analyticsPool.query("SELECT 1"); databaseConnected = true; }
      catch (error) { console.error("Health check database query failed:", error.code || error.message); }
    }
    return send(res, databaseConnected ? 200 : 503, {
      ok: databaseConnected,
      pitchApiConfigured: Boolean(process.env.PITCH_API_KEY),
      persistentAnalyticsConfigured: Boolean(analyticsPool),
      databaseConnected,
      pushConfigured: Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY),
      oddsProviderConfigured: Boolean(getOddsPapiApiKey() || getApiFootballKey()),
      oddsPapiKeyConfigured: Boolean(getOddsPapiApiKey()),
      apiFootballKeyConfigured: Boolean(getApiFootballKey()),
      pushScannerEnabled: Boolean(PUSH_SCAN_TOKEN && process.env.PUSH_SCAN_INTERVAL_ENABLED !== "false")
    });
  }

  if (url.pathname === "/api/league-standings" && req.method === "GET") {
    const league = String(url.searchParams.get("league") || "");
    const season = Math.round(Number(url.searchParams.get("season") || new Date().getUTCFullYear()));
    if (!SCOREBOARD_LEAGUES.includes(league)) return send(res, 400, { error: "Unsupported league", standings: [] });
    if (!Number.isInteger(season) || season < 2000 || season > new Date().getUTCFullYear() + 1) return send(res, 400, { error: "Invalid season", standings: [] });
    const key = "league-standings:" + league + ":" + season;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < 30 * 60 * 1000) return send(res, 200, cached.body);
    try {
      const response = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/" + league + "/standings?season=" + season, {
        headers: ESPN_HEADERS,
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error("Standings provider unavailable");
      const body = await response.json();
      const allGroups = [];
      const walk = node => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node.entries)) allGroups.push({ name: node.name || node.abbreviation || "", entries: node.entries });
        if (Array.isArray(node.children)) node.children.forEach(walk);
        if (node.standings && typeof node.standings === "object") walk(node.standings);
        if (Array.isArray(node.groups)) node.groups.forEach(walk);
      };
      walk(body);
      const getStat = (entry, names) => {
        const stats = Array.isArray(entry.stats) ? entry.stats : [];
        const item = stats.find(stat => names.includes(String(stat.name || "").toLowerCase()) || names.includes(String(stat.abbreviation || "").toLowerCase()));
        return item ? (item.value ?? item.displayValue ?? null) : null;
      };
      const standings = allGroups.flatMap(group => group.entries.map(entry => {
        const team = entry.team || {};
        const rank = getStat(entry, ["rank", "playoffseed", "seed"]);
        return {
          group: group.name,
          rank: rank == null ? null : Number(rank),
          team: team.displayName || team.name || "—",
          played: getStat(entry, ["gamesplayed", "played", "gp"]),
          wins: getStat(entry, ["wins", "w"]),
          draws: getStat(entry, ["ties", "draws", "d"]),
          losses: getStat(entry, ["losses", "l"]),
          goalsFor: getStat(entry, ["pointsfor", "goalsfor", "gf"]),
          goalsAgainst: getStat(entry, ["pointsagainst", "goalsagainst", "ga"]),
          goalDiff: getStat(entry, ["pointdifferential", "goaldifference", "gd"]),
          points: getStat(entry, ["points", "pts"]),
          form: getStat(entry, ["form", "streak"])
        };
      })).filter(item => item.team && item.team !== "—");
      const result = { league, season, standings, fetchedAt: new Date().toISOString() };
      cache.set(key, { at: Date.now(), body: result });
      return send(res, 200, result);
    } catch (error) {
      return send(res, 502, { error: "Standings temporarily unavailable", standings: [] });
    }
  }

  if (url.pathname === "/api/competition-fixtures" && req.method === "GET") {
    const league = String(url.searchParams.get("league") || "");
    const startRaw = String(url.searchParams.get("start") || "");
    const endRaw = String(url.searchParams.get("end") || "");
    const validDate = value => {
      if (!/^\d{8}$/.test(value)) return false;
      const year = Number(value.slice(0,4)), month = Number(value.slice(4,6)), day = Number(value.slice(6,8));
      const parsed = new Date(Date.UTC(year, month - 1, day));
      return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
    };
    if (!SCOREBOARD_LEAGUES.includes(league)) return send(res, 400, { error: "Unsupported league", matches: [] });
    if (!validDate(startRaw) || !validDate(endRaw)) return send(res, 400, { error: "start and end must be YYYYMMDD", matches: [] });
    const startDate = new Date(Date.UTC(Number(startRaw.slice(0,4)),Number(startRaw.slice(4,6))-1,Number(startRaw.slice(6,8))));
    const endDate = new Date(Date.UTC(Number(endRaw.slice(0,4)),Number(endRaw.slice(4,6))-1,Number(endRaw.slice(6,8))));
    const days = Math.round((endDate-startDate)/86400000);
    if (days < 0 || days > 31) return send(res, 400, { error: "Date range must be within 32 days", matches: [] });
    try {
      const pitchLeague = process.env.PITCH_API_KEY ? await findPitchLeague(league) : null;
      if (pitchLeague && pitchLeague.id) {
        const seasonYear = Number(startRaw.slice(0,4));
        const pitchSeason = pitchSeasonForCode(league, seasonYear, pitchLeague.seasons);
        const pitchData = await pitchGet("/v1/leagues/" + encodeURIComponent(pitchLeague.id) + "/matches?season=" + encodeURIComponent(pitchSeason) + "&status=all");
        const sourceMatches = pitchData?.data?.matches || [];
        if (sourceMatches.length) {
          const matches = sourceMatches.map(event => {
            const status = String(event.status || "").toLowerCase();
            const state = /finished|full.?time|ft/.test(status) ? "post" : /live|in.?play|half.?time|paused/.test(status) ? "in" : "pre";
            const hs = event.score_home == null ? null : Number(event.score_home);
            const as = event.score_away == null ? null : Number(event.score_away);
            return { id:String(event.id||""), leagueCode:league, league:pitchLeague.name, state, clock:event.minute!=null?String(event.minute)+"'":(event.status||""), date:event.time_utc||event.date||"", home:{name:event.home_team?.name||"Home",score:Number.isFinite(hs)?hs:null}, away:{name:event.away_team?.name||"Away",score:Number.isFinite(as)?as:null} };
          }).filter(match => {
            const day = String(match.date||"").slice(0,10).replace(/-/g,"");
            return day >= startRaw && day <= endRaw && match.id && match.home.name !== "Home" && match.away.name !== "Away";
          }).sort((a,b)=>String(a.date).localeCompare(String(b.date)));
          if (matches.length) return send(res, 200, { league, start:startRaw, end:endRaw, matches, fetchedAt:new Date().toISOString(), source:"PitchAPI" });
        }
      }
    } catch (providerError) {
      console.error("PitchAPI competition fixtures fallback:", league, providerError.message);
    }
    const key = "competition-fixtures:" + league + ":" + startRaw + ":" + endRaw;
    const cached = cache.get(key);
    if (cached && Date.now()-cached.at < 5*60*1000) return send(res, 200, cached.body);
    try {
      const response = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/" + league + "/scoreboard?limit=1000&dates=" + startRaw + "-" + endRaw, {
        headers: ESPN_HEADERS, signal: AbortSignal.timeout(18000)
      });
      if (!response.ok) throw new Error("Fixtures provider unavailable");
      const body = await response.json();
      const matches = (Array.isArray(body.events) ? body.events : []).map(event => {
        const competition = (event.competitions || [])[0] || {};
        const teams = competition.competitors || [];
        const home = teams.find(team => team.homeAway === "home") || teams[0] || {};
        const away = teams.find(team => team.homeAway === "away") || teams[1] || {};
        const status = (competition.status && competition.status.type) || (event.status && event.status.type) || {};
        const hs = home.score == null ? null : Number(home.score);
        const as = away.score == null ? null : Number(away.score);
        return {
          id: String(event.id || ""), leagueCode: league, league: event.league && event.league.name || league,
          state: status.state || "pre", clock: status.shortDetail || status.detail || "",
          date: event.date || "", home: { name: home.team && (home.team.displayName || home.team.name) || "Home", score: Number.isFinite(hs) ? hs : null },
          away: { name: away.team && (away.team.displayName || away.team.name) || "Away", score: Number.isFinite(as) ? as : null }
        };
      }).filter(match => match.id && match.home.name !== "Home" && match.away.name !== "Away")
        .sort((a,b)=>String(a.date).localeCompare(String(b.date)));
      const result = { league, start: startRaw, end: endRaw, matches, fetchedAt: new Date().toISOString() };
      cache.set(key, { at: Date.now(), body: result });
      return send(res, 200, result);
    } catch (error) {
      return send(res, 502, { error: "Competition fixtures temporarily unavailable", matches: [] });
    }
  }

  if (url.pathname === "/api/competition-history" && req.method === "GET") {
    const league = String(url.searchParams.get("league") || "");
    const seasonRaw = Number(url.searchParams.get("season") || new Date().getUTCFullYear());
    const season = Math.round(seasonRaw);
    if (!isHistoryLeagueSupported(league, SCOREBOARD_LEAGUES)) return send(res, 400, { error: "Unsupported league", matches: [] });
    if (!Number.isInteger(season) || season < 2000 || season > new Date().getUTCFullYear() + 1) return send(res, 400, { error: "Invalid season", matches: [] });
    const historyKey = "competition-history:" + league + ":" + season;
    try {
      const pitchLeague = process.env.PITCH_API_KEY ? await findPitchLeague(league) : null;
      if (pitchLeague && pitchLeague.id) {
        const pitchSeason = pitchSeasonForCode(league, season, pitchLeague.seasons);
        const pitchData = await pitchGet("/v1/leagues/" + encodeURIComponent(pitchLeague.id) + "/matches?season=" + encodeURIComponent(pitchSeason) + "&status=all");
        const sourceMatches = pitchData?.data?.matches || [];
        if (sourceMatches.length) {
          const matches = sourceMatches.map(event => {
            const status = String(event.status || "").toLowerCase();
            const state = /finished|full.?time|ft/.test(status) ? "post" : /live|in.?play|half.?time|paused/.test(status) ? "in" : "pre";
            const hs = event.score_home == null ? null : Number(event.score_home);
            const as = event.score_away == null ? null : Number(event.score_away);
            return { id:String(event.id||""), leagueCode:league, season, state, date:event.time_utc||event.date||"", home:{name:event.home_team?.name||"Home",score:Number.isFinite(hs)?hs:null}, away:{name:event.away_team?.name||"Away",score:Number.isFinite(as)?as:null} };
          }).filter(match => match.state === "post" && match.home.score !== null && match.away.score !== null && match.home.name !== "Home" && match.away.name !== "Away");
          // Only accept PitchAPI as the history source when it actually contains
          // completed, scored matches. A season response containing only scheduled
          // fixtures must fall through to the ESPN historical fallback.
          if (matches.length) {
            const result = { league, season, seasonStart: "", seasonEnd: "", matches, fetchedAt: new Date().toISOString(), source: "PitchAPI" };
            cache.set(historyKey, { at: Date.now(), body: result });
            await competitionHistoryStore.save(league, season, result).catch(storeError => {
              console.warn("[GoalMatrix competition history] persistent cache write failed:", league, season, storeError.message || storeError);
            });
            return send(res, 200, result);
          }
        }
      }
    } catch (providerError) {
      console.error("PitchAPI competition history fallback:", league, season, providerError.message);
    }
    const historyCached = cache.get(historyKey);
    if (historyCached && Date.now() - historyCached.at < 30 * 60 * 1000) return send(res, 200, historyCached.body);
    const calendarSeason = ["bra.1", "arg.1", "usa.1", "bra.copa_do_brazil", "arg.copa", "conmebol.libertadores", "conmebol.sudamericana"].includes(league);
    const splitSeason = ["mex.1", "aus.1"].includes(league);
    const start = calendarSeason ? new Date(Date.UTC(season, 0, 1)) : splitSeason ? new Date(Date.UTC(season, 6, 1)) : new Date(Date.UTC(season, 7, 1));
    const end = calendarSeason ? new Date(Date.UTC(season, 11, 31)) : splitSeason ? new Date(Date.UTC(season + 1, 5, 30)) : new Date(Date.UTC(season + 1, 5, 30));
    const compactDate = date => date.toISOString().slice(0, 10).replace(/-/g, "");
    try {
      // ESPN can return incomplete/empty results for a full-season date range.
      // Fetch bounded monthly windows and merge by event id instead.
      const windows = [];
      let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
      while (cursor <= end) {
        const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
        const windowStart = cursor < start ? start : cursor;
        const windowEnd = monthEnd > end ? end : monthEnd;
        windows.push({ start: windowStart, end: windowEnd });
        cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
      }
      // Fetch month windows concurrently and tolerate isolated provider failures.
      // A single bad month must not erase every completed result for the season.
      const windowResults = await Promise.allSettled(windows.map(async window => {
        // ESPN scoreboard season-month selectors use YYYYMM. Date-range
        // selectors (YYYYMMDD-YYYYMMDD) are rejected with HTTP 400 by ESPN.
        const month = formatEspnMonth(window.start);
        const endpoint = "https://site.api.espn.com/apis/site/v2/sports/soccer/" + league + "/scoreboard?dates=" + month + "&limit=500";
        const fallbackEndpoint = "https://site.web.api.espn.com/apis/site/v2/sports/soccer/" + league + "/scoreboard?dates=" + month + "&limit=500";
        // Bound concurrent history requests across all leagues and retry the
        // alternate ESPN hostname even when the primary request times out or
        // fails at the network layer.
        return competitionHistoryLimiter(() => fetchCompetitionHistoryWindow({
          endpoint,
          fallbackEndpoint,
          headers: ESPN_HEADERS,
          timeoutMs: 15000
        }));
      }));
      const successfulWindows = windowResults.filter(result => result.status === "fulfilled");
      const failedWindows = windowResults
        .map((result, index) => result.status === "rejected"
          ? { range: compactDate(windows[index].start) + "-" + compactDate(windows[index].end), error: String(result.reason && result.reason.message || result.reason || "unknown provider error") }
          : null)
        .filter(Boolean);
      if (!successfulWindows.length) {
        throw new Error("No competition history windows available; " + failedWindows.map(item => item.range + ": " + item.error).join(" | "));
      }
      const events = successfulWindows.flatMap(result => result.value);
      const uniqueEvents = new Map(events.map(event => [String(event.id || event.date + ":" + event.name), event]));
      const matches = [...uniqueEvents.values()].map(event => {
        const competition = (event.competitions || [])[0] || {};
        const teams = competition.competitors || [];
        const home = teams.find(team => team.homeAway === "home") || teams[0] || {};
        const away = teams.find(team => team.homeAway === "away") || teams[1] || {};
        const state = (competition.status && competition.status.type && competition.status.type.state) || (event.status && event.status.type && event.status.type.state) || "pre";
        const hs = home.score == null ? null : Number(home.score);
        const as = away.score == null ? null : Number(away.score);
        return {
          id: String(event.id || ""),
          leagueCode: league,
          season,
          state,
          date: event.date || "",
          home: { name: home.team && (home.team.displayName || home.team.name) || "Home", score: Number.isFinite(hs) ? hs : null },
          away: { name: away.team && (away.team.displayName || away.team.name) || "Away", score: Number.isFinite(as) ? as : null }
        };
      }).filter(match => match.state === "post" && match.home.score !== null && match.away.score !== null && match.home.name !== "Home" && match.away.name !== "Away");
      const result = { league, season, seasonStart: start.toISOString().slice(0,10), seasonEnd: end.toISOString().slice(0,10), matches, fetchedAt: new Date().toISOString(), partial: successfulWindows.length < windows.length, successfulWindows: successfulWindows.length, totalWindows: windows.length };
      cache.set(historyKey, { at: Date.now(), body: result });
      // Persist only non-empty verified history. Database failures never turn a
      // successful provider response into an API failure.
      await competitionHistoryStore.save(league, season, result).catch(storeError => {
        console.warn("[GoalMatrix competition history] persistent cache write failed:", league, season, storeError.message || storeError);
      });
      return send(res, 200, result);
    } catch (error) {
      // Prefer the in-process verified cache, then recover the last verified
      // season from PostgreSQL so a restart does not erase the fallback.
      const lastKnownHistory = cache.get(historyKey);
      if (lastKnownHistory && lastKnownHistory.body && Array.isArray(lastKnownHistory.body.matches)) {
        console.warn("Competition history serving stale in-memory cache:", league, season, error.message || "provider unavailable");
        return send(res, 200, {
          ...lastKnownHistory.body,
          stale: true,
          staleSince: new Date(lastKnownHistory.at).toISOString(),
          staleSource: "memory"
        });
      }
      try {
        const persistedHistory = await competitionHistoryStore.load(league, season);
        if (persistedHistory && persistedHistory.body && Array.isArray(persistedHistory.body.matches)) {
          console.warn("Competition history serving stale PostgreSQL cache:", league, season, error.message || "provider unavailable");
          return send(res, 200, {
            ...persistedHistory.body,
            stale: true,
            staleSince: persistedHistory.fetchedAt,
            staleSource: "postgres"
          });
        }
      } catch (storeError) {
        console.error("[GoalMatrix competition history] persistent cache read failed:", league, season, storeError.message || storeError);
      }
      console.error("[GoalMatrix competition history] ESPN season fetch failed:", league, season, error.message || "unknown provider error");
      return send(res, 502, { error: "Competition season request failed", matches: [] });
    }
  }

  try {
    if (url.pathname === "/api/scoreboard") {
      const date = url.searchParams.get("date") || "";
      if (!/^\d{8}$/.test(date)) return send(res, 400, { error: "date must be YYYYMMDD" });
      const cached = scoreboardCache.get(date);
      if (cached && Date.now() - cached.at < SCOREBOARD_TTL_MS) {
        res.setHeader("X-Goal-Pulse-Cache", "HIT");
        return send(res, 200, cached.body);
      }

      let sharedRequest = scoreboardInflight.get(date);
      if (!sharedRequest) {
        sharedRequest = (async () => {
          const feeds = [];
          const espnLeagues = SCOREBOARD_LEAGUES.filter(code => !ESPN_UNSUPPORTED_LEAGUES.has(code));
          // Bound concurrency: the previous nested Promise.all launched every
          // league request at once (up to ~150 simultaneous calls), which can trigger
          // provider throttling and leave the scoreboard with almost no successful feeds.
          // Run groups of 50 in sequence so no more than 50 ESPN requests are in flight.
          const espnBatchSize = 50;
          const espnBatches = Array.from({ length: Math.ceil(espnLeagues.length / espnBatchSize) }, (_, index) =>
            espnLeagues.slice(index * espnBatchSize, (index + 1) * espnBatchSize)
          );
          const batchResults = [];
          for (const batch of espnBatches) {
            const results = await Promise.all(batch.map(async code => {
              try {
                let response = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/" + code + "/scoreboard?dates=" + date, {
                  headers: { "Accept": "application/json" },
                  signal: AbortSignal.timeout(6000)
                });
                // ESPN may reject one public hostname from a hosting region. Retry the
                // equivalent public scoreboard endpoint on its web API hostname before
                // marking this competition unavailable.
                if (response.status === 403 || response.status === 429 || response.status >= 500) {
                  response = await fetch("https://site.web.api.espn.com/apis/site/v2/sports/soccer/" + code + "/scoreboard?dates=" + date, {
                    headers: { "Accept": "application/json" },
                    signal: AbortSignal.timeout(6000)
                  });
                }
                if (!response.ok) { if (response.status === 400) ESPN_UNSUPPORTED_LEAGUES.add(code); return { code, events: [], ok: false, error: "HTTP " + response.status }; }
                const body = await response.json();
                return { code, events: Array.isArray(body.events) ? body.events : [], ok: true };
              } catch (error) {
                return { code, events: [], ok: false, error: error.message || "request failed" };
              }
            }));
            batchResults.push(results);
          }
          feeds.push(...batchResults.flat());
          let finalFeeds = feeds;
          let successfulFeeds = feeds.filter(feed => feed.ok).length;
          if (process.env.PITCH_API_KEY && process.env.PITCH_API_SCOREBOARD_FALLBACK_ENABLED === "true") {
            // Supplement partial ESPN coverage with PitchAPI fixtures; merge by team pair to avoid duplicates.
            try {
              const isoDate = date.slice(0,4) + "-" + date.slice(4,6) + "-" + date.slice(6,8);
              const directory = (await pitchGet("/v1/leagues"))?.data?.leagues || [];
              const normal = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
              const countryCodes = {
                eng:["ENG","GB","GBR","UK"],esp:["ESP"],ita:["ITA"],ger:["DEU","GER","DE"],fra:["FRA"],
                por:["PRT","POR","PT"],ned:["NLD","NED","NL"],sco:["SCO","GB","GBR","UK"],gre:["GRC","GRE","GR"],
                tur:["TUR"],bra:["BRA"],arg:["ARG"],usa:["USA"],mex:["MEX"],aus:["AUS"],bel:["BEL"],aut:["AUT"],
                sui:["CHE","SUI","CH"],den:["DNK","DEN","DK"],nor:["NOR"],swe:["SWE"],pol:["POL"],jpn:["JPN"],
                kor:["KOR"],sau:["SAU"],irn:["IRN","IR"],irq:["IRQ","IQ"],aze:["AZE","AZ"],arm:["ARM","AM"],
                int:["INT","UKR","UA","UKRAINE"]
              };
              const idToCode = new Map();
              for (const code of SCOREBOARD_LEAGUES) {
                const aliases = pitchLeagueAliases(code).map(normal);
                if (!aliases.length) continue;
                const allowed = countryCodes[code.split(".")[0]] || [];
                const chosen = directory.find(item =>
                  aliases.includes(normal(item.name)) &&
                  allowed.length > 0 &&
                  allowed.includes(String(item.country_code || "").toUpperCase())
                );
                // No country match means no mapping; avoid assigning another country's league.
                if (chosen?.id) idToCode.set(String(chosen.id), code);
              }
              const pitchBody = await pitchGet("/v1/date/" + isoDate + "?status=all");
              const sourceMatches = pitchBody?.data?.matches || [];
              const byCode = new Map();
              const aliasesByCode = new Map(SCOREBOARD_LEAGUES.map(code => [code, pitchLeagueAliases(code).map(normal)]));
              for (const match of sourceMatches) {
                const matchLeagueName = normal(match.league?.name || "");
                const matchCountry = String(match.league?.country_code || match.league?.country || "").toUpperCase();
                let code = idToCode.get(String(match.league?.id || ""));
                if (!code && matchLeagueName) {
                  const candidates = SCOREBOARD_LEAGUES.filter(candidate =>
                    (aliasesByCode.get(candidate) || []).includes(matchLeagueName)
                  );
                  code = candidates.find(candidate => {
                    const allowed = countryCodes[candidate.split(".")[0]] || [];
                    return allowed.length > 0 && matchCountry.length > 0 && allowed.some(value => matchCountry === value);
                  });
                }
                // Do not discard a real fixture just because its competition is not in our curated alias list.
                // The UI can display these as an additional PitchAPI competition instead of silently losing live games.
                if (!code) {
                  const leagueId = String(match.league?.id || "");
                  const leagueSlug = normal(match.league?.name || "other").replace(/\s+/g, "-").slice(0, 36) || "other";
                  code = "pitch." + (leagueId || leagueSlug).replace(/[^a-zA-Z0-9-]/g, "-");
                }
                const rawStatus = match.status;
                const statusParts = typeof rawStatus === "string"
                  ? [rawStatus]
                  : rawStatus && typeof rawStatus === "object"
                    ? Object.entries(rawStatus).filter(([key, value]) => /status|name|description|short|long|type|state|period|phase|elapsed|minute|live|code|abbrev/i.test(key) && value != null).map(([, value]) => typeof value === "object" ? JSON.stringify(value) : String(value))
                    : [];
                const nestedStatus = rawStatus && typeof rawStatus === "object"
                  ? [rawStatus.code, rawStatus.short_name, rawStatus.shortName, rawStatus.abbreviation, rawStatus.description, rawStatus.name, rawStatus.state, rawStatus.type?.name, rawStatus.type?.shortName, rawStatus.type?.state]
                  : [];
                const statusText = [...statusParts, ...nestedStatus, match.status_name, match.status_short, match.status_long, match.status_code, match.period, match.phase, match.live_status, match.time?.status, match.time?.period]
                  .filter(value => value != null).map(value => typeof value === "object" ? JSON.stringify(value) : String(value)).join(" ").toLowerCase().replace(/[_-]+/g, " ");
                const isFinished = /finished|full\s*time|after\s*extra|ended|complete|\bft\b|\baet\b|\bpen\b/.test(statusText);
                const isNotStarted = /not\s*started|not\s*begin|scheduled|upcoming|fixture|to\s*be\s*played|kick\s*off|tbd|postponed|cancelled|abandoned/.test(statusText);
                const explicitLive = /live|in\s*play|inplay|in\s*progress|inprogress|playing|started|first\s*half|second\s*half|1st\s*half|2nd\s*half|half\s*time|half\s*ended|extra\s*time|penalt|\b1h\b|\b2h\b|\bht\b|\bint\b|\bperiod\s*[12]\b/.test(statusText);
                const minuteValue = match.minute ?? match.elapsed ?? match.time?.elapsed ?? match.time?.minute ?? null;
                const hasElapsedMinute = minuteValue != null && String(minuteValue).trim() !== "" && Number.isFinite(Number(minuteValue)) && Number(minuteValue) > 0;
                const truthyLive = value => value === true || value === 1 || /^(true|1|yes|live)$/i.test(String(value ?? "").trim());
                const liveFlag = truthyLive(match.is_live) || truthyLive(match.live) || truthyLive(match.in_play) || truthyLive(rawStatus?.is_live) || truthyLive(rawStatus?.live);
                // Explicit scheduled/not-started status must win over inconsistent live flags from the provider.
                const state = isFinished ? "post" : isNotStarted ? "pre" : (explicitLive || liveFlag || hasElapsedMinute) ? "in" : "pre";
                const status = { type: { state, completed: state === "post" }, displayClock: match.minute != null ? String(match.minute) + "'" : String(match.status || "") };
                const homeName = match.home_team?.name || "";
                const awayName = match.away_team?.name || "";
                const event = {
                  id: String(match.id || ""), date: match.time_utc || match.date || "",
                  name: homeName + " vs " + awayName, leagueName: String(match.league?.name || "Άλλη διοργάνωση"), status,
                  competitions: [{ status, competitors: [
                    { homeAway: "home", team: { displayName: homeName }, score: match.score_home == null ? undefined : String(match.score_home) },
                    { homeAway: "away", team: { displayName: awayName }, score: match.score_away == null ? undefined : String(match.score_away) }
                  ] }]
                };
                if (!event.id || !homeName || !awayName) continue;
                if (!byCode.has(code)) byCode.set(code, []);
                byCode.get(code).push(event);
              }
              if (sourceMatches.length) {
                const normalizeTeam = value => normal(value).replace(/\b(fc|cf|sc|afc|club|football|soccer)\b/g, " ").replace(/\s+/g, " ").trim();
                const teamPair = event => {
                  const comp = (event.competitions || [])[0] || {};
                  const teams = comp.competitors || [];
                  const home = teams.find(team => team.homeAway === "home") || teams[0] || {};
                  const away = teams.find(team => team.homeAway === "away") || teams[1] || {};
                  const homeName = normalizeTeam(home.team?.displayName || home.team?.name || "");
                  const awayName = normalizeTeam(away.team?.displayName || away.team?.name || "");
                  return homeName && awayName ? homeName + "||" + awayName : "";
                };
                const knownFeeds = SCOREBOARD_LEAGUES.map(code => {
                  const existing = feeds.find(feed => feed.code === code);
                  const events = [];
                  const ids = new Set();
                  const pairs = new Set();
                  const add = event => {
                    const id = String(event.id || "");
                    const pair = teamPair(event);
                    if ((id && ids.has(id)) || (pair && pairs.has(pair))) return;
                    events.push(event);
                    if (id) ids.add(id);
                    if (pair) pairs.add(pair);
                  };
                  for (const event of existing?.events || []) add(event);
                  for (const event of byCode.get(code) || []) add(event);
                  return { code, events, ok: Boolean(existing?.ok || events.length) };
                });
                const knownCodes = new Set(SCOREBOARD_LEAGUES);
                const extraFeeds = [...byCode.entries()]
                  .filter(([code, events]) => !knownCodes.has(code) && events.length)
                  .map(([code, events]) => ({ code, events, ok: true }));
                finalFeeds = knownFeeds.concat(extraFeeds);
                successfulFeeds = finalFeeds.filter(feed => feed.ok).length;
                const mappedMatches = finalFeeds.reduce((n, feed) => n + feed.events.length, 0);
                const mappedEvents = [...byCode.values()].flat();
                const rawStatusCounts = sourceMatches.reduce((acc, match) => { const raw = match.status; const key = typeof raw === "string" ? raw : raw == null ? "(missing)" : JSON.stringify(raw); const label = String(key).slice(0, 100); acc[label] = (acc[label] || 0) + 1; return acc; }, {});
                const mergedEvents = finalFeeds.flatMap(feed => feed.events || []);
                const scoreboardLogSource = feeds.some(feed => feed.ok && feed.events.length) ? "ESPN+PitchAPI" : sourceMatches.length ? "PitchAPI" : "unavailable";
                console.log("Scoreboard using " + scoreboardLogSource + ":", JSON.stringify({ date, espn: { requested: feeds.length, successful: feeds.filter(feed => feed.ok).length, nonEmpty: feeds.filter(feed => feed.ok && feed.events.length).length, eventCount: feeds.reduce((n, feed) => n + (feed.events || []).length, 0), sampleStates: feeds.flatMap(feed => (feed.events || []).map(event => ({ code: feed.code, name: event.name, state: event.status?.type?.state, detail: event.status?.type?.detail, clock: event.status?.displayClock, completed: event.status?.type?.completed }))).slice(0, 12), emptyCodes: feeds.filter(feed => feed.ok && !feed.events.length).slice(0, 20).map(feed => feed.code), failed: feeds.filter(feed => !feed.ok).slice(0, 12).map(feed => ({ code: feed.code, error: feed.error })) }, sourceMatches: sourceMatches.length, mappedMatches, pitchStates: mappedEvents.reduce((acc, event) => { const state = event.status?.type?.state || "unknown"; acc[state] = (acc[state] || 0) + 1; return acc; }, {}), mergedStates: mergedEvents.reduce((acc, event) => { const state = event.status?.type?.state || "unknown"; acc[state] = (acc[state] || 0) + 1; return acc; }, {}), rawStatusCounts, sample: sourceMatches.slice(0, 8).map(match => ({ league: match.league?.name, home: match.home_team?.name, away: match.away_team?.name, status: match.status, status_name: match.status_name, minute: match.minute, is_live: match.is_live, live: match.live, in_play: match.in_play })), mappedSample: mappedEvents.slice(0, 4).map(event => ({ name: event.name, state: event.status?.type?.state, clock: event.status?.displayClock })) }));
              }
            } catch (error) {
              console.error("PitchAPI scoreboard fallback failed:", error.message);
            }
          }

          // SportScore's documented fixtures endpoint supports explicit live/upcoming filters.
          // Use it for broader coverage; stats still must come from verified metrics providers.
          try {
            const requestedIsoDate = date.slice(0, 4) + "-" + date.slice(4, 6) + "-" + date.slice(6, 8);
            const sportScoreResponses = await Promise.all(["live", "upcoming", "finished"].map(async status => {
              const endpoint = "https://sportscore.com/api/v1/fixtures/?sport=football" +
                (status === "live" ? "" : "&date=" + encodeURIComponent(requestedIsoDate)) + "&status=" + status + "&limit=200&src=goal-pulse";
              try {
                const response = await fetch(endpoint, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(9000) });
                if (!response.ok) return { status, ok: false, httpStatus: response.status, matches: [] };
                const body = await response.json();
                const matches = extractFixtureArray(body);
                return { status, ok: true, matches };
              } catch (error) {
                return { status, ok: false, error: error.message || "request failed", matches: [] };
              }
            }));
            const sportScoreEvents = [];
            const seenSportScore = new Set();
            for (const result of sportScoreResponses) {
              for (const match of result.matches) {
                const matchTime = match.time || match.start_time || match.starting_at || match.date || match.kickoff;
                let matchDate = matchTime ? new Date(matchTime) : null;
                const requestedDateIsToday = requestedIsoDate === new Date().toISOString().slice(0, 10);
                // Live-only provider responses can omit kickoff timestamps; do not discard a verified live fixture for that reason.
                // Only apply this fallback to the current UTC date, never to historical scoreboard requests.
                if (result.status === "live" && requestedDateIsToday && (!matchDate || !Number.isFinite(matchDate.getTime()))) matchDate = new Date();
                if (!matchDate || !Number.isFinite(matchDate.getTime())) continue;
                if (result.status !== "live" && matchDate.toISOString().slice(0, 10) !== requestedIsoDate) continue;
                const homeName = String(match.home?.name || match.home_team?.name || match.homeTeam?.name || match.home_name || (typeof match.home === "string" ? match.home : "") || match.participants?.find(p => p.meta?.location === "home")?.name || "").trim();
                const awayName = String(match.away?.name || match.away_team?.name || match.awayTeam?.name || match.away_name || (typeof match.away === "string" ? match.away : "") || match.participants?.find(p => p.meta?.location === "away")?.name || "").trim();
                if (!homeName || !awayName) continue;
                const rawStatus = String(match.status_text || match.status || match.state || result.status || "").toLowerCase();
                const state = result.status === "live" || /live|in play|in-play|playing|1st half|2nd half|half time|extra time|penalt|in_progress/.test(rawStatus)
                  ? "in"
                  : result.status === "finished" || /finished|full time|ended|complete|after extra|\bft\b|\baet\b|\bpen\b/.test(rawStatus)
                    ? "post" : "pre";
                if (result.status === "live" && state !== "in") continue;
                const toScore = value => value == null || value === "" || !Number.isFinite(Number(value)) ? undefined : String(Number(value));
                const homeScore = match.home_score ?? match.homeScore ?? match.scores?.home ?? match.score?.home;
                const awayScore = match.away_score ?? match.awayScore ?? match.scores?.away ?? match.score?.away;
                const normalizeSlugPart = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\b(fc|cf|sc|afc|club|football|soccer)\b/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
                let matchSlug = match.slug || match.match_slug || match.matchSlug || "";
                if (!matchSlug && (match.url || match.match_url || match.href)) {
                  try {
                    const pathname = new URL(String(match.url || match.match_url || match.href), "https://sportscore.com").pathname;
                    const segments = pathname.split("/").filter(Boolean);
                    const matchIndex = segments.indexOf("match");
                    matchSlug = matchIndex >= 0 ? (segments[matchIndex + 2] || segments[matchIndex + 1] || "") : (segments[segments.length - 1] || "");
                  } catch {}
                }
                const slugOrId = matchSlug || match.id || match.fixture_id || (normalizeSlugPart(homeName) + "-vs-" + normalizeSlugPart(awayName));
                const eventId = "sportscore:" + String(slugOrId);
                if (seenSportScore.has(eventId)) continue;
                seenSportScore.add(eventId);
                const rawLiveMinute = match.minute ?? match.elapsed ?? match.liveMinute ?? match.live_minute ?? match.time?.elapsed ?? match.time?.minute;
                const normalizedLiveMinute = rawLiveMinute != null && /^(?:\d{1,3})(?:\s*[+’′]\s*\d{0,2})?$/.test(String(rawLiveMinute).trim()) ? String(rawLiveMinute).trim() : null;
                const liveTime = normalizedLiveMinute ?? match.status_text ?? match.statusText ?? (state === "in" ? "LIVE" : "");
                const status = { type: { state, completed: state === "post" }, displayClock: String(liveTime) };
                sportScoreEvents.push({
                  id: eventId, date: matchDate.toISOString(), name: homeName + " vs " + awayName,
                  leagueName: String((typeof match.competition === "string" ? match.competition : match.competition?.name) || (typeof match.league === "string" ? match.league : match.league?.name) || match.competition_name || match.league_name || "Football"),
                  status, competitions: [{ status, competitors: [
                    { homeAway: "home", team: { displayName: homeName }, score: toScore(homeScore) },
                    { homeAway: "away", team: { displayName: awayName }, score: toScore(awayScore) }
                  ] }]
                });
              }
            }
            if (sportScoreEvents.length) {
              const normalizeSportScoreTeam = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\b(fc|cf|sc|afc|club|football|soccer)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
              const existingPairs = new Set(finalFeeds.flatMap(feed => feed.events || []).map(event => {
                const teams = (event.competitions || [])[0]?.competitors || [];
                const home = teams.find(team => team.homeAway === "home") || teams[0] || {};
                const away = teams.find(team => team.homeAway === "away") || teams[1] || {};
                const h = normalizeSportScoreTeam(home.team?.displayName || home.team?.name);
                const a = normalizeSportScoreTeam(away.team?.displayName || away.team?.name);
                return h && a ? h + "||" + a : "";
              }).filter(Boolean));
              const missingSportScoreEvents = sportScoreEvents.filter(event => {
                const teams = event.competitions[0].competitors;
                const pair = normalizeSportScoreTeam(teams[0].team.displayName) + "||" + normalizeSportScoreTeam(teams[1].team.displayName);
                return pair !== "||" && !existingPairs.has(pair);
              });
              if (missingSportScoreEvents.length) {
                finalFeeds = finalFeeds.concat([{ code: "sportscore", events: missingSportScoreEvents, ok: true }]);
                successfulFeeds = finalFeeds.filter(feed => feed.ok).length;
              }
              console.log("SportScore live/upcoming/finished fixtures:", JSON.stringify({
                date, liveReceived: sportScoreResponses.find(x => x.status === "live")?.matches.length || 0,
                upcomingReceived: sportScoreResponses.find(x => x.status === "upcoming")?.matches.length || 0,
                finishedReceived: sportScoreResponses.find(x => x.status === "finished")?.matches.length || 0,
                mapped: sportScoreEvents.length, added: missingSportScoreEvents.length,
                errors: sportScoreResponses.filter(x => !x.ok).map(x => ({ status: x.status, httpStatus: x.httpStatus, error: x.error }))
              }));
            } else {              console.warn("SportScore returned no mappable fixtures:", JSON.stringify(sportScoreResponses.map(x => ({ status: x.status, ok: x.ok, received: x.matches.length, httpStatus: x.httpStatus, error: x.error }))));
            }          } catch (error) {
            console.warn("SportScore scoreboard unavailable; keeping existing feeds:", error.message || "request failed");
          }

          // Removed the redundant recent-match widget request: verified logs show it maps zero live fixtures and only adds up to 9 seconds of latency.

          // Dedicated live-only endpoint: unlike the recent-match widget, this explicitly filters status=live.
          try {
            const liveDate = date.length === 8 ? date.slice(0, 4) + "-" + date.slice(4, 6) + "-" + date.slice(6, 8) : new Date().toISOString().slice(0, 10);
            const response = await fetch("https://sportscore.com/api/v1/fixtures/?sport=football&date=" + liveDate + "&status=live&limit=200", {
              headers: { "Accept": "application/json" },
              signal: AbortSignal.timeout(9000)
            });
            if (response.ok) {
              const payload = await response.json();
              const liveFixtures = extractFixtureArray(payload);
              const normalizeLiveTeam = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\b(fc|cf|sc|afc|club|football|soccer)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
              const liveEventsFromApi = [];
              let replacedLive = 0;
              for (const match of liveFixtures) {
                const homeName = String(match.home?.name || match.home_team?.name || match.home_name || (typeof match.home === "string" ? match.home : "") || "").trim();
                const awayName = String(match.away?.name || match.away_team?.name || match.away_name || (typeof match.away === "string" ? match.away : "") || "").trim();
                if (!homeName || !awayName) continue;
                const statusValue = match.status;
                const statusText = [typeof statusValue === "object" ? JSON.stringify(statusValue) : statusValue, match.status_text, match.status_name, match.state, match.minute, match.elapsed].filter(v => v != null).map(String).join(" ").toLowerCase();
                if (/finished|full time|ended|complete|not started|upcoming|scheduled|postponed|cancelled/.test(statusText)) continue;
                const matchUrlSlug = (() => { try { const segments = new URL(String(match.url || ""), "https://sportscore.com").pathname.split("/").filter(Boolean); const matchIndex = segments.indexOf("match"); return matchIndex >= 0 ? (segments[matchIndex + 2] || segments[matchIndex + 1] || "") : ""; } catch { return ""; } })();
                const slug = String(match.slug || match.match_slug || match.matchSlug || match.id || match.event_id || matchUrlSlug || (normalizeLiveTeam(homeName) + "-vs-" + normalizeLiveTeam(awayName)));
                const liveClock = match.live_minute ?? match.liveMinute ?? match.elapsed ?? match.time?.elapsed ?? match.minute ?? match.time?.minute;
                const status = { type: { state: "in", completed: false }, displayClock: String(liveClock ?? match.status_text ?? "LIVE") };
                const score = value => value == null || value === "" || !Number.isFinite(Number(value)) ? undefined : String(Number(value));
                const homeScore = score(match.home_score ?? match.score_home ?? match.home?.score ?? match.home_team?.score ?? match.scores?.home);
                const awayScore = score(match.away_score ?? match.score_away ?? match.away?.score ?? match.away_team?.score ?? match.scores?.away);
                const event = {
                  id: "sportscore:" + slug,
                  date: match.time_utc || match.time || match.date || new Date().toISOString(),
                  name: homeName + " vs " + awayName,
                  leagueName: String(match.competition?.name || match.competition || match.league?.name || match.league_name || "Football"),
                  status,
                  competitions: [{ status, competitors: [
                    { homeAway: "home", team: { displayName: homeName }, score: homeScore },
                    { homeAway: "away", team: { displayName: awayName }, score: awayScore }
                  ] }]
                };
                const pair = normalizeLiveTeam(homeName) + "||" + normalizeLiveTeam(awayName);
                let replaced = false;
                for (const feed of finalFeeds) {
                  const index = (feed.events || []).findIndex(existing => {
                    const teams = existing.competitions?.[0]?.competitors || [];
                    const home = teams.find(team => team.homeAway === "home") || teams[0] || {};
                    const away = teams.find(team => team.homeAway === "away") || teams[1] || {};
                    return normalizeLiveTeam(home.team?.displayName || home.team?.name) + "||" + normalizeLiveTeam(away.team?.displayName || away.team?.name) === pair;
                  });
                  if (index >= 0) { feed.events[index] = event; replaced = true; replacedLive++; break; }
                }
                if (!replaced) liveEventsFromApi.push(event);
              }
              if (liveEventsFromApi.length) {
                finalFeeds = finalFeeds.concat([{ code: "sportscore-v1-live", events: liveEventsFromApi, ok: true }]);
                successfulFeeds = finalFeeds.filter(feed => feed.ok).length;
              }
              console.log("SportScore dedicated live endpoint:", JSON.stringify({
                checkedAt: new Date().toISOString(), httpStatus: response.status, rootKeys: Object.keys(payload || {}),
                count: liveFixtures.length, mappedLive: liveEventsFromApi.length + replacedLive,
                addedLive: liveEventsFromApi.length, replacedLive,
                sample: liveFixtures.slice(0, 3).map(match => ({ keys: Object.keys(match || {}), id: match.id, slug: match.slug, status: match.status, status_text: match.status_text, home: match.home, away: match.away, minute: match.minute, elapsed: match.elapsed, liveMinute: match.liveMinute, live_minute: match.live_minute, time: match.time, tracker: match.tracker }))
              }));
            } else console.warn("SportScore dedicated live endpoint HTTP:", response.status);
          } catch (error) { console.warn("SportScore dedicated live endpoint unavailable:", error.message || "request failed"); }

          const scoreboardSource = feeds.some(feed => feed.ok && feed.events.length)
            ? (finalFeeds.some(feed => feed.code === "sportscore" || feed.code === "sportscore-v1-live") ? "ESPN+PitchAPI+SportScore" : "ESPN+PitchAPI")
            : finalFeeds.some(feed => feed.events.length)
              ? (finalFeeds.some(feed => feed.code === "sportscore" || feed.code === "sportscore-v1-live") ? "PitchAPI+SportScore" : "PitchAPI")
              : "unavailable";
          if (successfulFeeds === 0) {
            console.error("All scoreboard feeds failed:", JSON.stringify(feeds.slice(0, 6).map(feed => ({ code: feed.code, error: feed.error || "unknown" }))));
          }
          // Read-only per-competition coverage audit. Does not alter feed selection or alert logic.
          console.log("[GoalMatrix ESPN competition coverage]", JSON.stringify({
            date,
            configured: SCOREBOARD_LEAGUES.length,
            attempted: feeds.length,
            skippedAfterHttp400: SCOREBOARD_LEAGUES.filter(code => ESPN_UNSUPPORTED_LEAGUES.has(code)),
            nonEmpty: feeds.filter(feed => feed.ok && (feed.events || []).length > 0).map(feed => ({ code: feed.code, events: feed.events.length })),
            empty: feeds.filter(feed => feed.ok && !(feed.events || []).length).map(feed => feed.code),
            failed: feeds.filter(feed => !feed.ok).map(feed => ({ code: feed.code, error: feed.error || "unknown" }))
          }));
          const body = { date, successfulFeeds, totalFeeds: SCOREBOARD_LEAGUES.length, feeds: finalFeeds.map(({code,events,ok,error}) => ({code,events,ok,...(error ? {error} : {})})), source: successfulFeeds ? scoreboardSource : "unavailable" };
          if (successfulFeeds > 0) {
            scoreboardCache.set(date, { at: Date.now(), body });
            return { status: 200, body, cache: "MISS" };
          }
          if (cached && Date.now() - cached.at < SCOREBOARD_TTL_MS + SCOREBOARD_STALE_TTL_MS) {
            return { status: 200, body: cached.body, cache: "STALE" };
          }
          return { status: 502, body, cache: "MISS" };
        })();
        scoreboardInflight.set(date, sharedRequest);
      }

      try {
        const result = await sharedRequest;
        const resultFeeds = Array.isArray(result.body?.feeds) ? result.body.feeds : [];
        console.log("Scoreboard response delivered:", JSON.stringify({
          date,
          status: result.status,
          cache: result.cache,
          successfulFeeds: result.body?.successfulFeeds || 0,
          totalEvents: resultFeeds.reduce((count, feed) => count + (Array.isArray(feed.events) ? feed.events.length : 0), 0),
          liveEvents: resultFeeds.reduce((count, feed) => count + (Array.isArray(feed.events) ? feed.events.filter(event => (event.status?.type?.state || event.competitions?.[0]?.status?.type?.state) === "in").length : 0), 0)
        }));
        res.setHeader("X-Goal-Pulse-Cache", result.cache);
        return send(res, result.status, result.body);
      } finally {
        if (scoreboardInflight.get(date) === sharedRequest) scoreboardInflight.delete(date);
      }
    }

    if (url.pathname === "/api/live-metrics") {
      const date = url.searchParams.get("date") || "";
      if (!/^\d{8}$/.test(date)) return send(res, 400, { error: "date must be YYYYMMDD" });
      // High Activity uses an isolated cache and broader LIVE-state recognition.
      // The default endpoint remains unchanged for AI/VIP scanners.
      const highActivityOnly = url.searchParams.get("scope") === "high-activity";
      const cacheKey = (highActivityOnly ? "high-activity-metrics:" : "live-metrics:") + date;
      const cachedMetrics = cache.get(cacheKey);
      if (cachedMetrics && Date.now() - cachedMetrics.at < 15000) return send(res, 200, cachedMetrics.body);
      let scoreboard = scoreboardCache.get(date);
      // Prime the scoreboard cache after a cold boot instead of returning 503 until the browser calls /api/scoreboard first.
      if (!scoreboard || !Array.isArray(scoreboard.body?.feeds)) {
        try {
          const primeResponse = await fetch("http://127.0.0.1:" + PORT + "/api/scoreboard?date=" + date, {
            headers: { "Accept": "application/json" },
            signal: AbortSignal.timeout(20000)
          });
          if (primeResponse.ok) scoreboard = scoreboardCache.get(date);
        } catch (error) {
          console.error("Could not prime scoreboard for live metrics:", error.message);
        }
      }
      if (!scoreboard || !Array.isArray(scoreboard.body?.feeds)) {
        return send(res, 503, { error: "Live scoreboard feed unavailable; retry shortly", matches: [] });
      }
      const isHighActivityLiveEvent = event => {
        // ESPN/provider payloads can contain both event-level and competition-level
        // status objects. The event-level value is sometimes stale ("pre") while
        // the competition-level value already says "in"; inspect both instead of
        // letting the first non-empty object mask the actual live state.
        const competitions = Array.isArray(event.competitions) ? event.competitions : [];
        const statusTypes = [
          event.status?.type,
          ...competitions.map(competition => competition?.status?.type)
        ].filter(status => status && typeof status === "object");
        const states = statusTypes.map(status => String(status.state || "").trim().toLowerCase());
        const labels = [
          ...statusTypes.flatMap(status => [status.name, status.description, status.detail, status.shortDetail]),
          event.status?.displayClock,
          ...competitions.map(competition => competition?.status?.displayClock)
        ].filter(value => value != null).join(" ").trim().toLowerCase();
        return states.some(state => /^(?:in|live|1h|2h|first_half|second_half|playing|inplay|in_play|in_progress|in-progress|in progress)$/.test(state))
          || /\b(?:live|playing|in progress|first half|second half|half time|1st half|2nd half)\b/.test(labels);
      };
      const liveEvents = scoreboard.body.feeds.flatMap(feed => (feed.events || [])
        .filter(event => {
          // Keep the AI/VIP default feed's exact original state check unchanged.
          const state = String(event.status?.type?.state || event.competitions?.[0]?.status?.type?.state || "").trim().toLowerCase();
          return highActivityOnly ? isHighActivityLiveEvent(event) : state === "in";
        })
        .map(event => ({ event, leagueCode: feed.code })));
      const sportScoreLiveExists = liveEvents.some(item => String(item.event.id).startsWith("sportscore:"));
      const sportScoreLiveStatsByPair = new Map();
      // Load direct live stats for every live scoreboard, not only SportScore-ID fixtures.
      // This is a fallback when another provider's summary omits SOT/corners.
      if (liveEvents.length) {
        try {
          const liveDate = date.slice(0, 4) + "-" + date.slice(4, 6) + "-" + date.slice(6, 8);
          const liveResponse = await fetch("https://sportscore.com/api/v1/fixtures/?sport=football&date=" + liveDate + "&status=live&limit=200", {
            headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(9000)
          });
          if (liveResponse.ok) {
            const livePayload = await liveResponse.json();
            const liveFixtures = extractFixtureArray(livePayload);
            const normalizeDirectTeam = value => String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\b(fc|cf|sc|afc|club|football|soccer)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
            for (const fixture of liveFixtures) {
              const statusText = [fixture.status, fixture.status_text, fixture.status_name, fixture.state, fixture.minute, fixture.elapsed].filter(v => v != null).map(v => typeof v === "object" ? JSON.stringify(v) : String(v)).join(" ").toLowerCase();
              if (/finished|full time|ended|complete|not started|upcoming|scheduled|postponed|cancelled/.test(statusText)) continue;
              const home = fixture.home?.name || fixture.home_team?.name || fixture.home_name || (typeof fixture.home === "string" ? fixture.home : "");
              const away = fixture.away?.name || fixture.away_team?.name || fixture.away_name || (typeof fixture.away === "string" ? fixture.away : "");
              const h = normalizeDirectTeam(home), a = normalizeDirectTeam(away);
              if (h && a && Array.isArray(fixture.stats)) {
                sportScoreLiveStatsByPair.set(h + "|" + a, fixture);
                sportScoreLiveStatsByPair.set(a + "|" + h, fixture);
              }
            }
            console.log("SportScore direct live stats feed:", JSON.stringify({ httpStatus: liveResponse.status, fixtures: liveFixtures.length, fixturesWithStats: sportScoreLiveStatsByPair.size / 2 }));
          }
        } catch (error) { console.warn("SportScore direct live stats feed unavailable:", error.message || "request failed"); }
      }
      if (liveEvents.length && Date.now() - sportScoreWidgetSlugCache.at > 45000) {
        try {
          const liveDateForSlugMap = date.slice(0, 4) + "-" + date.slice(4, 6) + "-" + date.slice(6, 8);
          const response = await fetch("https://sportscore.com/api/v1/fixtures/?sport=football&date=" + liveDateForSlugMap + "&status=live&limit=200", {
            headers: { "Accept": "application/json" },
            signal: AbortSignal.timeout(8000)
          });
          if (response.ok) {
            const payload = await response.json();
            const normalizeTeam = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\b(fc|cf|sc|afc|club|football|soccer)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
            const map = new Map();
            const liveSlugFixtures = extractFixtureArray(payload);
            for (const match of liveSlugFixtures) {
              const homeName = match.home?.name || match.home_team?.name || match.home_name || (typeof match.home === "string" ? match.home : "");
              const awayName = match.away?.name || match.away_team?.name || match.away_name || (typeof match.away === "string" ? match.away : "");
              if (!homeName || !awayName) continue;
              let matchSlug = match.slug || match.match_slug || match.matchSlug || "";
              if (!matchSlug && match.url) {
                try {
                  const pathname = new URL(String(match.url), "https://sportscore.com").pathname;
                  const segments = pathname.split("/").filter(Boolean);
                  const matchIndex = segments.indexOf("match");
                  matchSlug = matchIndex >= 0 ? (segments[matchIndex + 1] || segments[matchIndex + 2] || "") : (segments[segments.length - 1] || "");
                } catch {}
              }
              if (!matchSlug) continue;
              const home = normalizeTeam(homeName), away = normalizeTeam(awayName);
              if (home && away) {
                map.set(home + "|" + away, String(matchSlug));
                map.set(away + "|" + home, String(matchSlug));
              }
            }
            sportScoreWidgetSlugCache.map = map;
            sportScoreWidgetSlugCache.at = Date.now();
            console.log("SportScore detail slug map refreshed:", JSON.stringify({ rootKeys: Object.keys(payload || {}), matches: liveSlugFixtures.length, slugs: map.size, firstMatchKeys: Object.keys(liveSlugFixtures[0] || {}), firstMatch: liveSlugFixtures.slice(0, 2).map(match => ({ home: match.home?.name || match.home, away: match.away?.name || match.away, slug: match.slug, id: match.id, url: match.url, status: match.status })) }));
          }
        } catch (error) {
          console.warn("SportScore detail slug map refresh failed:", error.message || "unknown error");
        }
      }
      const work = liveEvents.slice(0, 60);
      let cursor = 0;
      const matches = [];
      const sportScoreDetailDiagnostics = { ok: 0, notFound: 0, otherErrors: 0, statuses: {}, slugSamples: [], minuteSamples: [], sample: null };
      const espnSummaryDiagnostics = { attempted: 0, httpOk: 0, httpErrors: {}, timeoutErrors: 0, missingBoxscoreTeams: 0, teamsFound: 0, teamsWithShotStats: 0 };
      const workers = Array.from({ length: Math.min(8, work.length) }, async () => {
        while (cursor < work.length) {
          const item = work[cursor++];
          const event = item.event;
          try {
            const eventId = String(event.id);
            if (eventId.startsWith("sportscore:") || eventId.startsWith("sportscore-widget:")) {
              const suffix = eventId.startsWith("sportscore-widget:")
                ? eventId.slice("sportscore-widget:".length)
                : eventId.slice("sportscore:".length);
              const homeName = event.competitions?.[0]?.competitors?.find(team => team.homeAway === "home")?.team?.displayName || "";
              const awayName = event.competitions?.[0]?.competitors?.find(team => team.homeAway === "away")?.team?.displayName || "";
              const normalizeTeam = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\b(fc|cf|sc|afc|club|football|soccer)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
              const pair = normalizeTeam(homeName) + "|" + normalizeTeam(awayName);
              const reversePair = normalizeTeam(awayName) + "|" + normalizeTeam(homeName);
              let slug = sportScoreWidgetSlugCache.map.get(pair) || sportScoreWidgetSlugCache.map.get(reversePair) || (/^\d+$/.test(suffix) || suffix.includes(":") ? "" : suffix);
              if (!slug) {
                sportScoreDetailDiagnostics.noSlug = (sportScoreDetailDiagnostics.noSlug || 0) + 1;
                continue;
              }
              if (sportScoreDetailDiagnostics.slugSamples.length < 5) sportScoreDetailDiagnostics.slugSamples.push({ home: homeName, away: awayName, slug });
              let detail;
              const directLiveMatch = sportScoreLiveStatsByPair.get(pair) || sportScoreLiveStatsByPair.get(reversePair);
              if (directLiveMatch && Array.isArray(directLiveMatch.stats) && directLiveMatch.stats.length) {
                detail = directLiveMatch;
                sportScoreDetailDiagnostics.ok++;
              } else {
                let detailResult = await fetchSportScoreMatchDetail(slug);
                if (detailResult.status === 404 && slug.includes("-vs-")) {
                  const parts = slug.split("-vs-");
                  if (parts.length === 2) {
                    const reverseSlug = parts[1] + "-vs-" + parts[0];
                    const reverseResult = await fetchSportScoreMatchDetail(reverseSlug);
                    if (reverseResult.ok) { slug = reverseSlug; detailResult = reverseResult; }
                    else {
                      const statusKey = String(reverseResult.status);
                      sportScoreDetailDiagnostics.statuses[statusKey] = (sportScoreDetailDiagnostics.statuses[statusKey] || 0) + 1;
                    }
                  }
                }
                if (!detailResult.ok) {
                  const statusKey = String(detailResult.status);
                  sportScoreDetailDiagnostics.statuses[statusKey] = (sportScoreDetailDiagnostics.statuses[statusKey] || 0) + 1;
                  if (detailResult.status === 404) sportScoreDetailDiagnostics.notFound++;
                  else sportScoreDetailDiagnostics.otherErrors++;
                  continue;
                }
                detail = detailResult.payload;
                sportScoreDetailDiagnostics.ok++;
              }
              const root = detail.match || detail.data || detail.fixture || detail;
              if (sportScoreDetailDiagnostics.minuteSamples.length < 8) sportScoreDetailDiagnostics.minuteSamples.push({ home: root.home || homeName, away: root.away || awayName, live_minute: root.live_minute ?? null, minute: root.minute ?? null, elapsed: root.elapsed ?? null, status_text: root.status_text ?? null, time: root.time ?? null, trackerKeys: root.tracker && typeof root.tracker === "object" ? Object.keys(root.tracker).slice(0, 10) : [], statsCount: Array.isArray(root.stats) ? root.stats.length : null, statsSample: Array.isArray(root.stats) ? root.stats.length : null });
              if (!sportScoreDetailDiagnostics.sample) {
                const paths = [];
                const inspect = (node, path = "", depth = 0) => {
                  if (!node || typeof node !== "object" || depth > 5 || paths.length >= 50) return;
                  if (Array.isArray(node)) {
                    if (node.length) inspect(node[0], path + "[0]", depth + 1);
                    return;
                  }
                  for (const [key, value] of Object.entries(node)) {
                    const next = path ? path + "." + key : key;
                    if (/stat|corner|attack|possession|expected|home|away|slug|match/i.test(key)) {
                      paths.push({ path: next, type: Array.isArray(value) ? "array" : typeof value, sample: value == null || typeof value !== "object" ? value : undefined });
                    }
                    if (value && typeof value === "object") inspect(value, next, depth + 1);
                  }
                };
                inspect(root);
                sportScoreDetailDiagnostics.sample = { eventId: String(event.id), rootKeys: Object.keys(root || {}), minuteCandidates: { live_minute: root.live_minute ?? null, minute: root.minute ?? null, elapsed: root.elapsed ?? null, status_text: root.status_text ?? null, time: root.time ?? null, trackerType: Array.isArray(root.tracker) ? "array" : typeof root.tracker, trackerKeys: root.tracker && typeof root.tracker === "object" ? Object.keys(root.tracker).slice(0, 20) : [], incidentKeys: Array.isArray(root.incidents) && root.incidents[0] && typeof root.incidents[0] === "object" ? Object.keys(root.incidents[0]).slice(0, 20) : [] }, paths: paths.slice(0, 40) };
              }
              const statsRows = [];
              const visited = new Set();
              const walk = (node, depth = 0) => {
                if (!node || typeof node !== "object" || depth > 8 || visited.has(node)) return;
                visited.add(node);
                if (Array.isArray(node)) {
                  for (const item of node) walk(item, depth + 1);
                  return;
                }
                const label = String(node.name || node.key || node.title || node.label || node.stat || node.type || node.stat_name || node.statName || node.short_name || node.shortName || node.abbreviation || node.abbr || node.display_name || node.displayName || node.description || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
                const home = node.home ?? node.home_value ?? node.homeValue ?? node.home_team ?? node.homeTeam ?? node.value_home ?? node.home_score;
                const away = node.away ?? node.away_value ?? node.awayValue ?? node.away_team ?? node.awayTeam ?? node.value_away ?? node.away_score;
                const relevantLiveMetric = /^(shots_on_target|shots_on_goal|shots_on_target_total|sot|on_target|total_shots|shots_total|shot_attempts|shots_off_target|off_target_shots|shots_off_goal|shots_in_box|shots_inside_box|shots_in_penalty_area|shots_inside_penalty_area|total_shots_inside_box|total_shots_in_box|shots_on_target_inside_box|shots_on_target_in_box|shots_on_target_inside_penalty_area|shots_on_target_in_penalty_area|shots_on_target_from_inside_box|on_target_inside_box|big_chances|big_chance|big_chances_created|big_chance_created|corners|corner|corner_kicks|corner_kick|cornerkicks|cornerkick|won_corners|corners_won|corner_kicks_won|corner_kicks_total|total_corners|corners_total|total_corner_kicks|total_corner_kicks_won|attacks|total_attacks|attacks_for|total_attacks_for|dangerous_attacks|dangerous_attacks_for|dangerous_attacks_created|red_cards|red_card|red_cards_total|red_card_total|possession|ball_possession|possession_percentage|possession_pct|ball_possession_percentage|expected_goals|xg|x_goals|x_goal|xgoals|expected_goals_xg|expected_goals_for|expected_goals_total|expected_goals_scored)$/.test(label);
                if (relevantLiveMetric && home != null && away != null && (typeof home !== "object") && (typeof away !== "object")) statsRows.push({ label, home, away });
                for (const [key, value] of Object.entries(node)) {
                  if (["home","away","home_value","away_value","homeValue","awayValue","value_home","value_away"].includes(key)) continue;
                  walk(value, depth + 1);
                }
              };
              walk(root);
              if (sportScoreDetailDiagnostics.sample?.eventId === String(event.id)) {
                sportScoreDetailDiagnostics.sample.statLabels = statsRows.slice(0, 30).map(row => ({ label: row.label, home: row.home, away: row.away }));
              }
              const readStat = (side, aliases, exactOnly = false) => {
                                let found = null;
                for (const alias of aliases) {
                  found = statsRows.find(row => row.label === alias);
                  if (found) break;
                }
                // Providers often append qualifiers such as "(including penalties)" to a
                // stat label. Keep exact alias priority, then accept a qualified version
                // of a known label while rejecting percentages/rates.
                if (!found && !exactOnly) {
                  const qualifiedAliases = aliases.filter(alias => String(alias).length >= 5);
                  found = statsRows.find(row =>
                    qualifiedAliases.some(alias => row.label.startsWith(alias + "_")) &&
                    !/(percentage|percent|rate|per_game|average)/.test(row.label)
                  ) || null;
                }
                if (!found) return null;
                const raw = found[side];
                const n = Number.parseFloat(String(raw).replace("%", "").replace(",", "."));
                return Number.isFinite(n) ? n : null;
              };
              // SportScore exposes red cards in the match incident timeline as well as
              // (on some fixtures) a statistics row. Use the incident timeline as a
              // fallback so a card already present on the first scan is not missed.
              const redCardIncidents = (Array.isArray(root.incidents) ? root.incidents : [])
                .map(incident => {
                  const incidentType = String(incident?.type ?? incident?.name ?? incident?.description ?? "").toLowerCase();
                  const incidentTypeId = Number(incident?.type_id ?? incident?.typeId);
                  const isRedCard = /red.?card|second.?yellow|yellow.?red/.test(incidentType) || incidentTypeId === 418;
                  if (!isRedCard) return null;
                  const rawSide = String(incident?.side ?? "").toLowerCase().trim();
                  const sideIndex = incident?.is_home === true || /^(home|host|h|1)$/.test(rawSide) ? 0
                    : incident?.is_home === false || /^(away|guest|a|2)$/.test(rawSide) ? 1 : -1;
                  if (sideIndex < 0) return null;
                  const rawMinute = String(incident?.time ?? incident?.minute ?? incident?.elapsed ?? "").trim();
                  const minuteMatch = rawMinute.match(/^([0-9]{1,3})/);
                  const minute = minuteMatch ? Number(minuteMatch[1]) : NaN;
                  return { sideIndex, minute: Number.isFinite(minute) ? minute : null };
                })
                .filter(Boolean);
              const incidentRedCardCounts = [
                redCardIncidents.filter(incident => incident.sideIndex === 0).length,
                redCardIncidents.filter(incident => incident.sideIndex === 1).length
              ];
              const hasIncidentTimeline = Array.isArray(root.incidents);
              const values = [
                { team: homeName, homeAway: "home", shotsOnTarget: readStat("home", ["shots_on_target","shots_on_goal","shots_on_target_total","sot","on_target"], true), shotsInBox: readStat("home", ["shots_in_box","shots_inside_box","shots_in_penalty_area","shots_inside_penalty_area","total_shots_inside_box","total_shots_in_box"]), totalShots: readStat("home", ["total_shots","shots_total","shots","shot_attempts","total_shots_for"]), shotsOffTarget: readStat("home", ["shots_off_target","off_target_shots","shots_off_goal","shots_off_target_total"]), shotsOnTargetInsideBox: readStat("home", ["shots_on_target_inside_box","shots_on_target_in_box","shots_on_target_inside_penalty_area","shots_on_target_in_penalty_area","shots_on_target_from_inside_box","on_target_inside_box"]), bigChances: readStat("home", ["big_chances","big_chance","big_chances_created","big_chance_created"]), corners: readStat("home", ["corners","corner","corner_kicks","corner_kick","cornerkicks","cornerkick","won_corners","corners_won","corner_kicks_won","corner_kicks_total","total_corners","corners_total","total_corner_kicks","total_corner_kicks_won"]), attacks: readStat("home", ["attacks","total_attacks","attacks_for","total_attacks_for"]), dangerousAttacks: readStat("home", ["dangerous_attacks","dangerous_attacks_for","dangerous_attacks_created"]), redCards: readStat("home", ["red_cards","red_card","red_cards_total","red_card_total"]) ?? (hasIncidentTimeline ? incidentRedCardCounts[0] : null), possession: readStat("home", ["possession","ball_possession","possession_percentage","possession_pct","ball_possession_percentage"]), xG: readStat("home", ["expected_goals","xg","x_goals","x_goal","xgoals","expected_goals_xg","expected_goals_for","expected_goals_total","expected_goals_scored"]) },
                { team: awayName, homeAway: "away", shotsOnTarget: readStat("away", ["shots_on_target","shots_on_goal","shots_on_target_total","sot","on_target"], true), shotsInBox: readStat("away", ["shots_in_box","shots_inside_box","shots_in_penalty_area","shots_inside_penalty_area","total_shots_inside_box","total_shots_in_box"]), totalShots: readStat("away", ["total_shots","shots_total","shots","shot_attempts","total_shots_for"]), shotsOffTarget: readStat("away", ["shots_off_target","off_target_shots","shots_off_goal","shots_off_target_total"]), shotsOnTargetInsideBox: readStat("away", ["shots_on_target_inside_box","shots_on_target_in_box","shots_on_target_inside_penalty_area","shots_on_target_in_penalty_area","shots_on_target_from_inside_box","on_target_inside_box"]), bigChances: readStat("away", ["big_chances","big_chance","big_chances_created","big_chance_created"]), corners: readStat("away", ["corners","corner","corner_kicks","corner_kick","cornerkicks","cornerkick","won_corners","corners_won","corner_kicks_won","corner_kicks_total","total_corners","corners_total","total_corner_kicks","total_corner_kicks_won"]), attacks: readStat("away", ["attacks","total_attacks","attacks_for","total_attacks_for"]), dangerousAttacks: readStat("away", ["dangerous_attacks","dangerous_attacks_for","dangerous_attacks_created"]), redCards: readStat("away", ["red_cards","red_card","red_cards_total","red_card_total"]) ?? (hasIncidentTimeline ? incidentRedCardCounts[1] : null), possession: readStat("away", ["possession","ball_possession","possession_percentage","possession_pct","ball_possession_percentage"]), xG: readStat("away", ["expected_goals","xg","x_goals","x_goal","xgoals","expected_goals_xg","expected_goals_for","expected_goals_total","expected_goals_scored"]) }
              ];
                            const scoreboardCompetition = event.competitions?.[0] || {};
              const scoreboardCompetitors = Array.isArray(scoreboardCompetition.competitors) ? scoreboardCompetition.competitors : [];
              const scoreboardHome = scoreboardCompetitors.find(team => team?.homeAway === "home") || null;
              const scoreboardAway = scoreboardCompetitors.find(team => team?.homeAway === "away") || null;
              const scoreValue = value => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
              const liveMinute = root.live_minute ?? root.liveMinute ?? root.elapsed ?? root.time?.elapsed ??
                root.time?.minute ?? root.status?.minute ?? root.status?.elapsed ??
                event.live_minute ?? event.status?.displayClock ?? scoreboardCompetition.status?.displayClock ?? event.time ?? "";
              matches.push({
                eventId: String(event.id), home: homeName, away: awayName, statsSource: "SportScore",
                minute: liveMinute,
                homeScore: scoreValue(event.home_score ?? event.homeScore ?? scoreboardHome?.score ?? scoreboardHome?.displayValue),
                awayScore: scoreValue(event.away_score ?? event.awayScore ?? scoreboardAway?.score ?? scoreboardAway?.displayValue),
                status: event.status?.type?.state ?? event.status ?? scoreboardCompetition.status?.type?.state ?? "",
                statusText: event.status_text ?? event.statusText ?? event.status?.type?.detail ?? event.status?.type?.shortDetail ?? "",
                homeHtScore: scoreValue(event.home_ht_score ?? scoreboardHome?.linescores?.[0]?.value ?? scoreboardHome?.linescores?.[0]?.displayValue),
                awayHtScore: scoreValue(event.away_ht_score ?? scoreboardAway?.linescores?.[0]?.value ?? scoreboardAway?.linescores?.[0]?.displayValue),
                statsAvailable: values.some(value => ["shotsOnTarget","shotsInBox","shotsOnTargetInsideBox","bigChances","corners","possession","xG"].some(key => value[key] !== null)),
                teams: values,
                redCardIncidents
              });
              continue;
            }
            if (String(event.id).startsWith("m_")) {
              const pitchStats = await pitchGet("/v1/matches/" + encodeURIComponent(event.id) + "/stats");
              const periods = pitchStats?.data?.periods || [];
              const allPeriods = periods.filter(period => !period.period || String(period.period).trim().toLowerCase() === "all");
              // Some provider responses only expose half-by-half periods; do not silently drop all stats.
              const groups = (allPeriods.length ? allPeriods : periods).flatMap(period => period.groups || []);
              const items = groups.flatMap(group => group.items || []);
              const readStat = (side, aliases, exactOnly = false) => {
                // Resolve aliases in priority order (specific total first), not provider row order.
                let found = null;
                for (const alias of aliases) {
                  found = items.find(stat =>
                    String(stat.key || "").toLowerCase() === alias ||
                    String(stat.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") === alias
                  );
                  if (found) break;
                }
                if (!found && !exactOnly) {
                  const normalizedAliases = aliases.filter(alias => String(alias).length >= 5);
                  found = items.find(stat => {
                    const key = String(stat.key || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
                    const title = String(stat.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
                    return [key, title].some(label =>
                      normalizedAliases.some(alias => label.startsWith(alias + "_")) &&
                      !/(percentage|percent|rate|per_game|average)/.test(label)
                    );
                  }) || null;
                }
                if (!found) return null;
                const value = Number.parseFloat(String(found[side] ?? "").replace(",", "."));
                return Number.isFinite(value) ? value : null;
              };
              const homeName = event.competitions?.[0]?.competitors?.find(team => team.homeAway === "home")?.team?.displayName || "";
              const awayName = event.competitions?.[0]?.competitors?.find(team => team.homeAway === "away")?.team?.displayName || "";
              const values = [
                { team: homeName, homeAway: "home", shotsOnTarget: readExactSotStat(items, "home"), shotsInBox: readStat("home", ["shots_in_box","shots_inside_box","shots_in_penalty_area","shots_inside_penalty_area","total_shots_inside_box","total_shots_in_box"]), totalShots: readStat("home", ["total_shots","shots_total","shots","shot_attempts","total_shots_for"]), shotsOffTarget: readStat("home", ["shots_off_target","off_target_shots","shots_off_goal","shots_off_target_total"]), shotsOnTargetInsideBox: readStat("home", ["shots_on_target_inside_box","shots_on_target_in_box","shots_on_target_inside_penalty_area","shots_on_target_in_penalty_area","shots_on_target_from_inside_box","on_target_inside_box"]), bigChances: readStat("home", ["big_chances","big_chance","big_chances_created","big_chance_created"]), corners: readStat("home", ["corners","corner_kicks","won_corners","corner_kicks_total"]), attacks: readStat("home", ["attacks","total_attacks","attacks_for"]), dangerousAttacks: readStat("home", ["dangerous_attacks","dangerous_attacks_for","dangerous_attacks_created"]), redCards: readStat("home", ["red_cards","red_card","red_cards_total","red_card_total"]), possession: readStat("home", ["possession","possession_percentage","possession_pct","ball_possession"]), xG: readStat("home", ["expected_goals","expected_goals_xg","xg","expected_goals_for"]) },
                { team: awayName, homeAway: "away", shotsOnTarget: readExactSotStat(items, "away"), shotsInBox: readStat("away", ["shots_in_box","shots_inside_box","shots_in_penalty_area","shots_inside_penalty_area","total_shots_inside_box","total_shots_in_box"]), totalShots: readStat("away", ["total_shots","shots_total","shots","shot_attempts","total_shots_for"]), shotsOffTarget: readStat("away", ["shots_off_target","off_target_shots","shots_off_goal","shots_off_target_total"]), shotsOnTargetInsideBox: readStat("away", ["shots_on_target_inside_box","shots_on_target_in_box","shots_on_target_inside_penalty_area","shots_on_target_in_penalty_area","shots_on_target_from_inside_box","on_target_inside_box"]), bigChances: readStat("away", ["big_chances","big_chance","big_chances_created","big_chance_created"]), corners: readStat("away", ["corners","corner_kicks","won_corners","corner_kicks_total"]), attacks: readStat("away", ["attacks","total_attacks","attacks_for"]), dangerousAttacks: readStat("away", ["dangerous_attacks","dangerous_attacks_for","dangerous_attacks_created"]), redCards: readStat("away", ["red_cards","red_card","red_cards_total","red_card_total"]), possession: readStat("away", ["possession","possession_percentage","possession_pct","ball_possession"]), xG: readStat("away", ["expected_goals","expected_goals_xg","xg","expected_goals_for"]) }
              ];
              matches.push({
                eventId: String(event.id), home: homeName, away: awayName, statsSource: "PitchAPI",
                minute: event.status?.displayClock || "",
                statsAvailable: values.some(value => ["shotsOnTarget","shotsOnTargetInsideBox","bigChances","corners","possession","xG"].some(key => value[key] !== null)),
                teams: values
              });
              continue;
            }
            espnSummaryDiagnostics.attempted++;
            let response = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/" + item.leagueCode + "/summary?event=" + encodeURIComponent(event.id), {
              headers: { "Accept": "application/json" },
              signal: AbortSignal.timeout(8000)
            });
            // Match the proven scoreboard fallback: ESPN can deny the site.api hostname
            // from this hosting region while its equivalent site.web.api endpoint works.
            // Retry only explicit HTTP denial/throttling/server errors; do not alter
            // provider selection, match parsing, or any alert/protocol behavior.
            if (response.status === 403 || response.status === 429 || response.status >= 500) {
              response = await fetch("https://site.web.api.espn.com/apis/site/v2/sports/soccer/" + item.leagueCode + "/summary?event=" + encodeURIComponent(event.id), {
                headers: { "Accept": "application/json" },
                signal: AbortSignal.timeout(8000)
              });
            }
            if (!response.ok) {
              const statusKey = String(response.status);
              espnSummaryDiagnostics.httpErrors[statusKey] = (espnSummaryDiagnostics.httpErrors[statusKey] || 0) + 1;
              continue;
            }
            espnSummaryDiagnostics.httpOk++;
            const summary = await response.json();
            const teams = summary?.boxscore?.teams || [];
            if (!teams.length) espnSummaryDiagnostics.missingBoxscoreTeams++;
            espnSummaryDiagnostics.teamsFound += teams.length;
            const values = teams.map(team => {
              const stats = team.statistics || [];
              const get = (...names) => {
                                let found = null;
                for (const name of names) {
                  const normalizedName = String(name).toLowerCase().replace(/[^a-z]/g, "");
                  found = stats.find(stat => [stat.name, stat.abbreviation].filter(Boolean).some(value => String(value).toLowerCase().replace(/[^a-z]/g, "") === normalizedName));
                  if (found) break;
                }
                if (!found) return null;
                const n = Number(String(found.displayValue ?? found.value ?? "").replace("%", ""));
                return Number.isFinite(n) ? n : null;
              };
              return {
                team: team.team?.displayName || team.team?.name || "",
                homeAway: team.homeAway || team.team?.homeAway || "",
                    shotsOnTarget: get("shotsontarget", "shotsongoal", "sog"), shotsOffTarget: get("shotsofftarget", "offtargetshots", "shotsoffgoal"), shotsInBox: get("shotsinbox", "shotsinsidebox", "shotsinpenaltyarea", "shotsinsidepenaltyarea", "totalshotsinsidebox", "totalshotsinbox"), totalShots: get("totalshots", "shotstotal", "shots", "shotattempts", "shotsattempted", "totalshotattempts"),
                shotsOnTargetInsideBox: get("shotsontargetinsidebox", "shotsontargetinbox", "shotsontargetinsidepenaltyarea", "shotsontargetinpenaltyarea", "shotsontargetfrominsidebox", "ontargetinsidebox"),
                bigChances: get("bigchances", "bigchance", "bigchancescreated", "bigchancecreated"),
                corners: get("woncorners", "cornerkicks", "corners"),
                attacks: get("attacks", "totalattacks", "attacksfor", "totalattacksfor"),
                dangerousAttacks: get("dangerousattacks", "dangerousattacksfor", "dangerousattackscreated", "dangerousattackswon"),
                possession: get("possessionpct", "possession"),
                xG: get("expectedgoals", "xg", "expectedgoalsfor")
              };
            });
            // Ensure both scoreboard sides exist, even when ESPN omits its boxscore teams.
            const eventHomeName = event.competitions?.[0]?.competitors?.find(team => team.homeAway === "home")?.team?.displayName || "";
            const eventAwayName = event.competitions?.[0]?.competitors?.find(team => team.homeAway === "away")?.team?.displayName || "";
            const normalizeBoxscoreTeam = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\b(fc|cf|sc|afc|club|football|soccer)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
            const emptyTeamStats = { totalShots: null, shotsOnTarget: null, shotsOffTarget: null, shotsInBox: null, shotsOnTargetInsideBox: null, bigChances: null, corners: null, attacks: null, dangerousAttacks: null, possession: null, xG: null };
            if (eventHomeName && !values.some(value => value.homeAway === "home" || normalizeBoxscoreTeam(value.team) === normalizeBoxscoreTeam(eventHomeName))) values.unshift({ ...emptyTeamStats, team: eventHomeName, homeAway: "home" });
            if (eventAwayName && !values.some(value => value.homeAway === "away" || normalizeBoxscoreTeam(value.team) === normalizeBoxscoreTeam(eventAwayName))) values.push({ ...emptyTeamStats, team: eventAwayName, homeAway: "away" });
            // Keep ESPN boxscore teams in home/away order before pairing them with SportScore fallback values.
            const homeTeamIndex = values.findIndex(value => value.homeAway === "home" || normalizeBoxscoreTeam(value.team) === normalizeBoxscoreTeam(eventHomeName));
            const awayTeamIndex = values.findIndex(value => value.homeAway === "away" || normalizeBoxscoreTeam(value.team) === normalizeBoxscoreTeam(eventAwayName));
            if (homeTeamIndex >= 0 && awayTeamIndex >= 0 && homeTeamIndex > awayTeamIndex) values.reverse();
            const espnHasShotStats = values.some(v => ["shotsOnTarget", "corners"].some(key => v[key] != null));
            if (espnHasShotStats) espnSummaryDiagnostics.teamsWithShotStats += values.length;
            // Try the fallback whenever either team has a missing core SOT metric,
            // not only when ESPN returns no live SOT statistics.
            const espnNeedsFallback = values.length < 2 || values.slice(0, 2).some(v => ["shotsOnTarget", "shotsInBox", "bigChances", "corners"].some(key => v[key] == null));
            if (espnNeedsFallback) {
              const normFallbackTeam = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\b(fc|cf|sc|afc|club|football|soccer)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
              const homeName = event.competitions?.[0]?.competitors?.find(t => t.homeAway === "home")?.team?.displayName || "";
              const awayName = event.competitions?.[0]?.competitors?.find(t => t.homeAway === "away")?.team?.displayName || "";
              let direct = sportScoreLiveStatsByPair.get(normFallbackTeam(homeName) + "|" + normFallbackTeam(awayName))
                || sportScoreLiveStatsByPair.get(normFallbackTeam(awayName) + "|" + normFallbackTeam(homeName));
              // The fixtures list may not include stats. For ESPN matches, use its
              // mapped SportScore slug to request the actual match-detail payload.
              if (!direct || !Array.isArray(direct.stats) || !direct.stats.length) {
                const fallbackSlug = sportScoreWidgetSlugCache.map.get(normFallbackTeam(homeName) + "|" + normFallbackTeam(awayName))
                  || sportScoreWidgetSlugCache.map.get(normFallbackTeam(awayName) + "|" + normFallbackTeam(homeName));
                if (fallbackSlug) {
                  try {
                    const detailResponse = await fetch("https://sportscore.com/api/widget/match/?sport=football&slug=" + encodeURIComponent(fallbackSlug) + "&src=goal-pulse", {
                      headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(8000)
                    });
                    if (detailResponse.ok) {
                      const detailPayload = await detailResponse.json();
                      direct = detailPayload.match || detailPayload.data || detailPayload.fixture || detailPayload;
                    }
                  } catch (fallbackError) {
                    console.warn("SportScore per-match fallback unavailable:", JSON.stringify({ eventId: String(event.id), error: fallbackError.message || "request failed" }));
                  }
                }
              }
              if (direct && Array.isArray(direct.stats)) {
                const directHomeName = direct.home?.name || direct.home_team?.name || direct.home_name || (typeof direct.home === "string" ? direct.home : "");
                const sameOrientation = normFallbackTeam(directHomeName) === normFallbackTeam(homeName);
                const homeSide = sameOrientation ? "home" : "away";
                const awaySide = sameOrientation ? "away" : "home";
                const rows = [];
                const visited = new Set();
                const walkDirect = (node, depth = 0) => {
                  if (!node || typeof node !== "object" || depth > 7 || visited.has(node)) return;
                  visited.add(node);
                  if (Array.isArray(node)) { for (const item of node) walkDirect(item, depth + 1); return; }
                  const label = String(node.name || node.key || node.title || node.label || node.stat || node.type || node.stat_name || node.statName || node.short_name || node.shortName || node.abbreviation || node.abbr || node.display_name || node.displayName || node.description || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
                  const home = node.home ?? node.home_value ?? node.homeValue ?? node.home_team ?? node.homeTeam ?? node.value_home ?? node.home_score;
                  const away = node.away ?? node.away_value ?? node.awayValue ?? node.away_team ?? node.awayTeam ?? node.value_away ?? node.away_score;
                  const relevantLiveMetric = /^(shots_on_target|shots_on_goal|shots_on_target_total|sot|on_target|total_shots|shots_total|shot_attempts|shots_off_target|off_target_shots|shots_off_goal|shots_in_box|shots_inside_box|shots_in_penalty_area|shots_inside_penalty_area|total_shots_inside_box|total_shots_in_box|big_chances|big_chance|big_chances_created|big_chance_created|corners|corner|corner_kicks|corner_kick|cornerkicks|cornerkick|won_corners|corners_won|corner_kicks_won|corner_kicks_total|total_corners|corners_total|total_corner_kicks|total_corner_kicks_won|dangerous_attacks|dangerous_attacks_for|dangerous_attacks_created|red_cards|red_card|red_cards_total|red_card_total|possession|ball_possession|possession_percentage|possession_pct|ball_possession_percentage)$/.test(label);
                  if (relevantLiveMetric && home != null && away != null && typeof home !== "object" && typeof away !== "object") rows.push({label, home, away});
                  for (const [key, value] of Object.entries(node)) {
                    if (!["home","away","home_value","away_value","homeValue","awayValue","value_home","value_away"].includes(key)) walkDirect(value, depth + 1);
                  }
                };
                walkDirect(direct.stats);
                const readDirect = (side, aliases) => {
                  let row = null;
                  for (const alias of aliases) { row = rows.find(item => item.label === alias); if (row) break; }
                  if (!row) return null;
                  const n = Number.parseFloat(String(row[side]).replace("%", "").replace(",", "."));
                  return Number.isFinite(n) ? n : null;
                };
                const getDirect = side => ({
                  shotsOnTarget: readDirect(side, ["shots_on_target","shots_on_goal","shots_on_target_total","sot","on_target"]),
                  totalShots: readDirect(side, ["total_shots","shots_total","shots","shot_attempts","total_shots_for"]),
                  shotsOffTarget: readDirect(side, ["shots_off_target","off_target_shots","shots_off_goal","shots_off_target_total"]),
                  dangerousAttacks: readDirect(side, ["dangerous_attacks","dangerous_attacks_for","dangerous_attacks_created"]),
                  shotsInBox: readDirect(side, ["shots_in_box","shots_inside_box","shots_in_penalty_area","shots_inside_penalty_area","total_shots_inside_box","total_shots_in_box"]),
                  bigChances: readDirect(side, ["big_chances","big_chance","big_chances_created","big_chance_created"]),
                  corners: readDirect(side, ["corners","corner","corner_kicks","corner_kick","cornerkicks","cornerkick","won_corners","corners_won","corner_kicks_won","corner_kicks_total","total_corners","corners_total","total_corner_kicks","total_corner_kicks_won"]),
                  possession: readDirect(side, ["possession","ball_possession","possession_percentage","possession_pct","ball_possession_percentage"])
                });
                const fallbackValues = [getDirect(homeSide), getDirect(awaySide)];
                if (fallbackValues.some(v => ["shotsOnTarget","totalShots","shotsOffTarget","dangerousAttacks","shotsInBox","bigChances","corners","possession"].some(key => v[key] != null))) {
                  values.forEach((v, i) => {
                    const fallback = fallbackValues[i];
                    for (const key of ["shotsOnTarget","totalShots","shotsOffTarget","dangerousAttacks","shotsInBox","bigChances","corners","possession"]) if (v[key] == null && fallback[key] != null) v[key] = fallback[key];
                  });
                  console.log("SportScore fallback supplied missing ESPN live stats:", JSON.stringify({eventId:String(event.id),home:homeName,away:awayName,stats:values.map(v=>({team:v.team,shotsOnTarget:v.shotsOnTarget,shotsInBox:v.shotsInBox,bigChances:v.bigChances,corners:v.corners}))}));
                }
              }
            }
            matches.push({
              eventId: String(event.id), statsSource: values.some(v => ["shotsOnTarget","totalShots","shotsOffTarget","dangerousAttacks","shotsInBox","bigChances","corners"].some(key => v[key] != null)) ? "ESPN+SportScore" : "ESPN",
              home: event.competitions?.[0]?.competitors?.find(t => t.homeAway === "home")?.team?.displayName || "",
              away: event.competitions?.[0]?.competitors?.find(t => t.homeAway === "away")?.team?.displayName || "",
              minute: event.status?.displayClock || event.competitions?.[0]?.status?.displayClock || "",
              statsAvailable: values.length >= 2 && values.slice(0, 2).some(v => ["shotsOnTarget", "totalShots", "shotsOffTarget", "shotsInBox", "shotsOnTargetInsideBox", "bigChances", "corners", "attacks", "dangerousAttacks", "possession", "xG"].some(key => v[key] !== null)),
              teams: values
            });
          } catch (error) {
            if (!String(event.id || "").startsWith("m_") && !String(event.id || "").startsWith("sportscore:") && !String(event.id || "").startsWith("sportscore-widget:") && /abort|timeout/i.test(String(error.message || ""))) espnSummaryDiagnostics.timeoutErrors++;
            console.error("Live stats fetch failed:", JSON.stringify({ eventId: String(event.id || ""), leagueCode: item.leagueCode, provider: String(event.id || "").startsWith("m_") ? "PitchAPI" : "ESPN", error: error.message || "unknown error" }));
          }
        }
      });
      await Promise.all(workers);
      // SportAPI canary: supplement only missing cumulative match statistics.
      // It deliberately does not replace the scoreboard/clock and does not change
      // rolling-window, AI Alert, HI Activity, VIP, or settlement protocol logic.
      if (SPORTAPI_API_KEY && matches.length) {
        const now = Date.now();
        const liveDate = date.slice(0, 4) + "-" + date.slice(4, 6) + "-" + date.slice(6, 8);
        let sportApiFixtures = sportApiDateFixturesCache.get(liveDate);
        if (!sportApiFixtures || now - sportApiFixtures.at >= SPORTAPI_FIXTURE_CACHE_MS) {
          try {
            const response = await fetch("https://sportapi.ai/api/fixtures/date/" + liveDate, {
              headers: { "Accept": "application/json", "X-Api-Key": SPORTAPI_API_KEY },
              signal: AbortSignal.timeout(10000)
            });
            if (response.ok) {
              const payload = await response.json();
              const rows = Array.isArray(payload?.data) ? payload.data : extractFixtureArray(payload);
              sportApiFixtures = { at: now, rows };
              sportApiDateFixturesCache.set(liveDate, sportApiFixtures);
              console.log("[SportAPI canary] fixture list:", JSON.stringify({ date: liveDate, status: response.status, fixtures: rows.length }));
            } else {
              sportApiFixtures = { at: now, rows: [] };
              sportApiDateFixturesCache.set(liveDate, sportApiFixtures);
              console.warn("[SportAPI canary] fixture list unavailable:", JSON.stringify({ status: response.status }));
            }
          } catch (error) {
            sportApiFixtures = { at: now, rows: [] };
            sportApiDateFixturesCache.set(liveDate, sportApiFixtures);
            console.warn("[SportAPI canary] fixture list request failed:", error.message || "request failed");
          }
        }
        // The date endpoint has returned only a small partial fixture set for some
        // countries. Recover Israeli league fixtures through the documented league
        // catalogue/detail endpoints, without changing any alert or SOT rules.
        let israelLeagueFixtures = sportApiIsraelLeagueFixturesCache.get(liveDate);
        if (!israelLeagueFixtures || now - israelLeagueFixtures.at >= SPORTAPI_ISRAEL_LEAGUE_CACHE_MS) {
          try {
            const leaguesResponse = await fetch("https://sportapi.ai/api/leagues", {
              headers: { "Accept": "application/json", "X-Api-Key": SPORTAPI_API_KEY },
              signal: AbortSignal.timeout(10000)
            });
            if (leaguesResponse.ok) {
              const leaguesPayload = await leaguesResponse.json();
              const countryGroups = Array.isArray(leaguesPayload?.data) ? leaguesPayload.data : [];
              const israelGroup = countryGroups.find(group => /^(israel|il)$/i.test(String(group.country || group.name || group.geo || "")));
              const israelLeagues = Array.isArray(israelGroup?.leagues) ? israelGroup.leagues : [];
              const targetedLeagues = israelLeagues
                .filter(league => /women|female|ladies|national/i.test(String(league.name || "")))
                .slice(0, 12);
              const selectedLeagues = targetedLeagues.length ? targetedLeagues : israelLeagues.slice(0, 12);
              const detailResults = await Promise.all(selectedLeagues.map(async league => {
                if (league.id == null) return { league, fixtures: [] };
                try {
                  const detailResponse = await fetch("https://sportapi.ai/api/leagues/" + encodeURIComponent(String(league.id)), {
                    headers: { "Accept": "application/json", "X-Api-Key": SPORTAPI_API_KEY },
                    signal: AbortSignal.timeout(10000)
                  });
                  if (!detailResponse.ok) return { league, fixtures: [] };
                  const detail = await detailResponse.json();
                  const body = detail?.data && !Array.isArray(detail.data) ? detail.data : detail;
                  const arrays = ["fixtures", "matches", "upcoming_fixtures", "recent_results"];
                  const fixtures = arrays.flatMap(key => Array.isArray(body?.[key]) ? body[key] : []);
                  const todayFixtures = fixtures.filter(fixture => {
                    const fixtureDate = String(fixture.date || fixture.local_date || fixture.datetime || "").slice(0, 10);
                    const live = /^(live|ht|in play|1h|2h)$/i.test(String(fixture.status || ""));
                    return fixtureDate === liveDate || (!fixtureDate && live);
                  });
                  return { league, fixtures: todayFixtures };
                } catch (error) {
                  console.warn("[SportAPI canary] Israel league detail unavailable:", JSON.stringify({ leagueId: league.id, error: error.message || "request failed" }));
                  return { league, fixtures: [] };
                }
              }));
              const recovered = detailResults.flatMap(result => result.fixtures.map(fixture => ({
                ...fixture,
                league_name: fixture.league_name || result.league.name || "Israel"
              })));
              israelLeagueFixtures = { at: now, rows: recovered };
              sportApiIsraelLeagueFixturesCache.set(liveDate, israelLeagueFixtures);
              console.log("[SportAPI canary] Israel league recovery:", JSON.stringify({
                leaguesChecked: selectedLeagues.length,
                targetedWomenLeagues: targetedLeagues.length,
                fixturesRecovered: recovered.length,
                leagueNames: selectedLeagues.map(league => league.name).slice(0, 12)
              }));
            } else {
              israelLeagueFixtures = { at: now, rows: [] };
              sportApiIsraelLeagueFixturesCache.set(liveDate, israelLeagueFixtures);
              console.warn("[SportAPI canary] Israel league catalogue unavailable:", JSON.stringify({ status: leaguesResponse.status }));
            }
          } catch (error) {
            israelLeagueFixtures = { at: now, rows: [] };
            sportApiIsraelLeagueFixturesCache.set(liveDate, israelLeagueFixtures);
            console.warn("[SportAPI canary] Israel league recovery failed:", error.message || "request failed");
          }
        }
        const baseFixtureRows = sportApiFixtures?.rows || [];
        const mergedFixtureRows = [...baseFixtureRows, ...(israelLeagueFixtures?.rows || [])];
        const uniqueFixtureRows = Array.from(new Map(mergedFixtureRows.filter(fixture => fixture?.id != null).map(fixture => [String(fixture.id), fixture])).values());
        sportApiFixtures = { ...(sportApiFixtures || {}), rows: uniqueFixtureRows };
        const normalizeSportApiTeam = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\b(fc|cf|sc|afc|club|football|soccer|women|woman|ladies|female|w)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
        const fixtureByPair = new Map();
        for (const fixture of sportApiFixtures?.rows || []) {
          const home = normalizeSportApiTeam(fixture.home_team || fixture.home || fixture.home_short);
          const away = normalizeSportApiTeam(fixture.away_team || fixture.away || fixture.away_short);
          if (home && away && fixture.id != null) {
            fixtureByPair.set(home + "|" + away, fixture);
            fixtureByPair.set(away + "|" + home, fixture);
          }
        }
        const matched = matches.map(match => {
          const home = normalizeSportApiTeam(match.home);
          const away = normalizeSportApiTeam(match.away);
          return { match, fixture: fixtureByPair.get(home + "|" + away) || fixtureByPair.get(away + "|" + home) || null };
        }).filter(item => item.fixture);
        const applySportApiStats = (match, fixture, cached) => {
          if (!cached?.values) return false;
          const fixtureHome = normalizeSportApiTeam(fixture.home_team || fixture.home || fixture.home_short);
          const sameOrientation = fixtureHome === normalizeSportApiTeam(match.home);
          const homeStats = sameOrientation ? cached.values.home : cached.values.away;
          const awayStats = sameOrientation ? cached.values.away : cached.values.home;
          const sides = [match.teams?.find(team => team.homeAway === "home") || match.teams?.[0], match.teams?.find(team => team.homeAway === "away") || match.teams?.[1]];
          let supplied = false;
          for (const [index, team] of sides.entries()) {
            if (!team) continue;
            const source = index === 0 ? homeStats : awayStats;
            for (const [key, value] of Object.entries(source || {})) {
              if (team[key] == null && value != null && Number.isFinite(Number(value))) {
                team[key] = Number(value);
                supplied = true;
              }
            }
          }
          if (supplied) {
            const currentSource = String(match.statsSource || "unknown");
            if (!currentSource.includes("SportAPI")) match.statsSource = currentSource + "+SportAPI";
            match.statsAvailable = true;
          }
          return supplied;
        };
        // Reuse cached samples for every matching fixture without extra API calls.
        for (const item of matched) {
          const cached = sportApiFixtureStatsCache.get(String(item.fixture.id));
          if (cached) applySportApiStats(item.match, item.fixture, cached);
        }
        // Canary budget: one fixture's stats endpoint at most every five minutes.
        // This intentionally tests real provider coverage before scaling beyond the
        // free monthly allowance. Missing values remain null; none are fabricated.
        // Rotate through fixtures with missing SOT instead of repeatedly selecting
        // the first eligible match. Unqueried fixtures (no cache entry) go first;
        // once all have been checked, the oldest cached sample is refreshed first.
        const candidate = matched
          .filter(item => {
            const sides = item.match.teams || [];
            const missingSot = sides.length >= 2 && sides.slice(0, 2).some(team => team.shotsOnTarget == null);
            const cached = sportApiFixtureStatsCache.get(String(item.fixture.id));
            return missingSot && (!cached || now - cached.at >= SPORTAPI_STATS_REFRESH_MS);
          })
          .sort((a, b) => {
            const aCached = sportApiFixtureStatsCache.get(String(a.fixture.id));
            const bCached = sportApiFixtureStatsCache.get(String(b.fixture.id));
            return (aCached?.at ?? 0) - (bCached?.at ?? 0);
          })[0] || null;
        console.log("[SportAPI canary] fixture matching diagnostic:", JSON.stringify({
          fixtureCount: (sportApiFixtures?.rows || []).length,
          fixtureSamples: (sportApiFixtures?.rows || []).slice(0, 10).map(fixture => ({
            id: fixture.id ?? null,
            home: fixture.home_team || fixture.home || fixture.home_short || null,
            away: fixture.away_team || fixture.away || fixture.away_short || null,
            status: fixture.status ?? null,
            date: fixture.date ?? null
          })),
          liveMatchCount: matches.length,
          matchedLiveFixtures: matched.length,
          unmatchedLiveSamples: matches.filter(match => !matched.some(item => item.match === match)).slice(0, 6).map(match => ({home: match.home, away: match.away})),
          matchedSamples: matched.slice(0, 6).map(item => ({home: item.match.home, away: item.match.away, fixtureHome: item.fixture.home_team || item.fixture.home || item.fixture.home_short, fixtureAway: item.fixture.away_team || item.fixture.away || item.fixture.away_short})),
          cachedFixtureStats: sportApiFixtureStatsCache.size,
          matchesMissingSot: matched.filter(item => (item.match.teams || []).slice(0, 2).some(team => team.shotsOnTarget == null)).length,
          statsRequestCandidate: candidate ? {home: candidate.match.home, away: candidate.match.away} : null,
          statsRequestBudgetAvailable: now - sportApiLastStatsRequestAt >= SPORTAPI_STATS_REQUEST_GAP_MS
        }));
        if (candidate && now - sportApiLastStatsRequestAt >= SPORTAPI_STATS_REQUEST_GAP_MS) {
          sportApiLastStatsRequestAt = now;
          const fixtureId = String(candidate.fixture.id);
          try {
            const response = await fetch("https://sportapi.ai/api/fixtures/" + encodeURIComponent(fixtureId) + "/stats", {
              headers: { "Accept": "application/json", "X-Api-Key": SPORTAPI_API_KEY },
              signal: AbortSignal.timeout(10000)
            });
            if (response.ok) {
              const payload = await response.json();
              const normalizeSide = side => {
                const raw = payload?.data?.[side] || {};
                const number = value => {
                  if (value == null || value === "") return null;
                  const parsed = Number.parseFloat(String(value).replace("%", "").replace(",", "."));
                  return Number.isFinite(parsed) ? parsed : null;
                };
                return {
                  shotsOnTarget: number(raw.shots_on_target ?? raw.shots_on_goal),
                  totalShots: number(raw.total_shots ?? raw.shots_total ?? raw.shots ?? raw.shot_attempts),
                  shotsOffTarget: number(raw.shots_off_target ?? raw.off_target_shots ?? raw.shots_off_goal),
                  dangerousAttacks: number(raw.dangerous_attacks ?? raw.dangerous_attacks_for ?? raw.dangerous_attacks_created),
                  shotsInBox: number(raw.shots_in_box ?? raw.shots_inside_box ?? raw.shots_in_penalty_area ?? raw.total_shots_inside_box),
                  bigChances: number(raw.big_chances ?? raw.big_chance ?? raw.big_chances_created),
                  corners: number(raw.corners ?? raw.corner_kicks),
                  possession: number(raw.possession ?? raw.ball_possession)
                };
              };
              const cached = {
                at: now,
                available: payload?.available === true,
                values: { home: normalizeSide("home"), away: normalizeSide("away") }
              };
              sportApiFixtureStatsCache.set(fixtureId, cached);
              const supplied = applySportApiStats(candidate.match, candidate.fixture, cached);
              console.log("[SportAPI canary] stats response:", JSON.stringify({
                fixtureId,
                home: candidate.match.home,
                away: candidate.match.away,
                available: cached.available,
                suppliedMissingFields: supplied,
                homeSot: cached.values.home.shotsOnTarget,
                awaySot: cached.values.away.shotsOnTarget
              }));
            } else {
              sportApiFixtureStatsCache.set(fixtureId, { at: now, available: false, values: null });
              console.warn("[SportAPI canary] stats endpoint unavailable:", JSON.stringify({ fixtureId, status: response.status }));
            }
          } catch (error) {
            console.warn("[SportAPI canary] stats request failed:", JSON.stringify({ fixtureId, error: error.message || "request failed" }));
          }
        }
      } else if (!SPORTAPI_API_KEY) {
        // Do not expose the key; this is only a configuration-presence diagnostic.
        console.log("[SportAPI canary] disabled: SPORTAPI_API_KEY is not configured");
      }
      console.log("[GoalMatrix ESPN summary audit]", JSON.stringify(espnSummaryDiagnostics));
      const isSportScoreEvent = value => String(value || "").startsWith("sportscore:") || String(value || "").startsWith("sportscore-widget:");
      if (work.some(item => isSportScoreEvent(item.event.id))) {
        console.log("SportScore live metrics detail diagnostic:", JSON.stringify({
          attempted: work.filter(item => isSportScoreEvent(item.event.id)).length,
          ...sportScoreDetailDiagnostics,
          statsAvailable: matches.filter(match => isSportScoreEvent(match.eventId) && match.statsAvailable).length
        }));
      }
      // High Activity must not write to or mutate the shared AI/VIP rolling-trend history.
      const persisted = highActivityOnly ? null : await persistRollingTrends(matches, date);
      if (!highActivityOnly && !persisted) addRollingTrends(matches);
      const hasPersistableSamples = matches.some(match => Array.isArray(match.teams) && match.teams.some(team =>
        team.team && ["shotsOnTarget", "corners", "attacks", "dangerousAttacks"]
          .some(key => team[key] != null && Number.isFinite(Number(team[key])))
      ));
      const trendHistory = highActivityOnly ? "isolated high-activity feed; shared trend history untouched" : !persisted ? "in-memory fallback; resets on service restart" : hasPersistableSamples ? "postgresql; retained across service restarts" : "PostgreSQL ready; waiting for real live-stat samples";
      // Read-only diagnostic summary for blank live-stat tiles. No scoring or protocol logic.
      const diagnosticFields = ["shotsOnTarget","shotsInBox","bigChances","corners","possession","xG"];
      const liveMetricsAudit = {
        scope: highActivityOnly ? "high-activity" : "default",
        totalLiveEvents: liveEvents.length,
        checkedEvents: work.length,
        returnedMatches: matches.length,
        matchesWithTwoTeams: matches.filter(match => Array.isArray(match.teams) && match.teams.length >= 2).length,
        matchesWithAnyStats: matches.filter(match => match.statsAvailable).length,
        providers: matches.reduce((counts, match) => {
          const provider = match.statsSource || "unknown";
          counts[provider] = (counts[provider] || 0) + 1;
          return counts;
        }, {}),
        fieldCoverage: Object.fromEntries(diagnosticFields.map(field => [field,
          matches.filter(match => Array.isArray(match.teams) && match.teams.length >= 2
            && match.teams.slice(0, 2).every(team => team[field] != null && Number.isFinite(Number(team[field])))).length
        ])),
        sample: matches.slice(0, 8).map(match => ({
          eventId: match.eventId, home: match.home, away: match.away,
          statsSource: match.statsSource || "unknown", statsAvailable: Boolean(match.statsAvailable),
          teamCount: Array.isArray(match.teams) ? match.teams.length : 0
        }))
      };
      console.log("[GoalMatrix live-metrics audit]", JSON.stringify(liveMetricsAudit));
      const body = { date, checked: work.length, totalLive: liveEvents.length, matches, updatedAt: new Date().toISOString(), trendHistory };
      cache.set(cacheKey, { at: Date.now(), body });
      return send(res, 200, body);
    }

    if (url.pathname === "/api/pitch/date") {
      const date = url.searchParams.get("date") || "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 400, { error: "date must be YYYY-MM-DD" });
      return send(res, 200, await pitchGet("/v1/date/" + date));
    }

    const matchRoute = url.pathname.match(/^\/api\/pitch\/matches\/(m_[A-Za-z0-9]{6})\/(stats|momentum|shots|events)$/);
    if (matchRoute) {
      const [, id, endpoint] = matchRoute;
      return send(res, 200, await pitchGet("/v1/matches/" + id + "/" + endpoint));
    }

    if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "Unknown API route" });

    const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const filePath = path.resolve(ROOT, "." + requested);
    if (!filePath.startsWith(ROOT + path.sep) && filePath !== path.join(ROOT, "index.html")) {
      return send(res, 403, "Forbidden", "text/plain; charset=utf-8");
    }
    fs.readFile(filePath, (err, data) => {
      if (err) return send(res, 404, "Not found", "text/plain; charset=utf-8");
      const ext = path.extname(filePath).toLowerCase();
      const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
      res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "X-Content-Type-Options": "nosniff" });
      res.end(data);
    });
  } catch (err) {
    const status = Number(err.status) || 502;
    send(res, status, { error: err.message, code: err.code || null });
  }
});

const analyticsDatabaseHost = (() => { try { return resolvedDatabaseUrl ? new URL(resolvedDatabaseUrl).hostname : "unset"; } catch { return resolvedDatabaseUrl ? "invalid-url" : "unset"; } })();
const rawDatabaseUrl = process.env.DATABASE_URL || "";
const databaseUrlShape = {
  length: rawDatabaseUrl.length,
  hasScheme: /^[a-z][a-z0-9+.-]*:\/\//i.test(rawDatabaseUrl),
  hasAt: rawDatabaseUrl.includes("@"),
  hasBaseHost: /(?:@|:\/\/)base(?=[:/?#]|$)/i.test(rawDatabaseUrl),
  prefix: (rawDatabaseUrl.match(/^[a-z][a-z0-9+.-]*:\/\//i) || [rawDatabaseUrl.slice(0, Math.min(8, rawDatabaseUrl.length))])[0]
};
console.log("Push scanner configuration:", JSON.stringify({ enabled: Boolean(PUSH_SCAN_TOKEN && process.env.PUSH_SCAN_INTERVAL_ENABLED !== "false"), pushConfigured: Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY), databaseConfigured: Boolean(analyticsPool), databaseHost: analyticsDatabaseHost, databaseUrlShape, databaseCredentialEnvKeys: Object.keys(process.env).filter(key => /^(DATABASE|POSTGRES|PGHOST|PGUSER|PGDATABASE|PGPASSWORD)/i.test(key)) }));
if (PUSH_SCAN_TOKEN && process.env.PUSH_SCAN_INTERVAL_ENABLED !== "false") {
  console.log("Background push scanner scheduled every 60 seconds.");
  // Run once shortly after startup so the live pipeline is tested immediately after every deploy.
  setTimeout(async () => {
    try {
      const response = await fetch("http://127.0.0.1:" + PORT + "/api/push/scan", {
        method: "POST",
        headers: { Authorization: "Bearer " + PUSH_SCAN_TOKEN },
        signal: AbortSignal.timeout(55000)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) console.error("Startup push scan returned HTTP " + response.status + ": " + (result.detail || result.error || "unknown error"));
      else console.log("Startup push scan completed:", JSON.stringify({
        liveMatches: Number(result.liveMatches || 0), statsMatches: Number(result.statsMatches || 0),
        checked: Number(result.checked || 0), candidates: Number(result.candidates || 0),
        deliveries: Number(result.deliveries || 0), subscribers: Number(result.subscribers || 0), date: result.date || null,
        diagnostics: result.diagnostics || null
      }));
    } catch (error) {
      console.error("Startup push scan request failed:", error.message || "unknown error");
    }
  }, 5000);
  const backgroundScanTimer = setInterval(async () => {
    try {
      const response = await fetch("http://127.0.0.1:" + PORT + "/api/push/scan", {
        method: "POST",
        headers: { Authorization: "Bearer " + PUSH_SCAN_TOKEN },
        signal: AbortSignal.timeout(55000)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.error("Scheduled push scan returned HTTP " + response.status + ": " + (result.detail || result.error || "unknown error"));
      } else {
        console.log("Scheduled push scan completed:", JSON.stringify({
          liveMatches: Number(result.liveMatches || 0),
          statsMatches: Number(result.statsMatches || 0),
          checked: Number(result.checked || 0),
          candidates: Number(result.candidates || 0),
          deliveries: Number(result.deliveries || 0),
          subscribers: Number(result.subscribers || 0),
          date: result.date || null,
          diagnostics: result.diagnostics || null
        }));
      }
    } catch (error) {
      console.error("Scheduled push scan request failed:", error.message);
    }
  }, 60000);
  backgroundScanTimer.unref();
}
// Re-evaluate settled AI alert performance hourly; the report recommends tests but never mutates live rules.
const protocolAnalystTimer = setInterval(() => { runProtocolAnalyst().catch(() => {}); }, 60 * 60 * 1000);
protocolAnalystTimer.unref();
setTimeout(() => { runProtocolAnalyst().catch(() => {}); }, 15000).unref?.();

server.listen(PORT, "0.0.0.0", () => {
  console.log("Goal Pulse listening on " + PORT);
  // Daily full-coupon Pre-Match preparation at/after 06:00 Greece time.
  // Per-league persisted freshness prevents duplicate season downloads.
  const preMatchDailyTimer = setInterval(() => {
    runScheduledPreMatchCollection().catch(() => {});
  }, 60 * 1000);
  preMatchDailyTimer.unref();
  setTimeout(() => { runScheduledPreMatchCollection().catch(() => {}); }, 8000).unref?.();
  // Run a read-only audit against the same live database path and log the actual result.
  // This avoids changing the Postgres IP allowlist just to perform verification.
  setTimeout(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/alerts/history/verify`, {
        headers: { Origin: "https://goal-pulse.onrender.com" }
      });
      const audit = await response.json();
      if (!response.ok || !audit.ok) throw new Error(audit.error || ("HTTP " + response.status));
      const issueCodes = {};
      for (const issue of (audit.integrity?.issues || [])) {
        issueCodes[issue.issue] = (issueCodes[issue.issue] || 0) + 1;
      }
      console.log("Goal Pulse history integrity audit:", JSON.stringify({
        generatedAt: audit.generatedAt,
        windowDays: audit.windowDays,
        scanned: audit.scanned,
        settled: audit.settled,
        pending: audit.pending,
        pendingAge: audit.pendingAge,
        pendingSample: audit.pendingSample,
        settledWinLossSample: audit.settledWinLossSample,
        wins: audit.wins,
        losses: audit.losses,
        successRate: audit.successRate,
        byOutcome: audit.byOutcome,
        byPeriod: audit.byPeriod,
        issueCount: audit.integrity?.issueCount,
        issueCodes,
        sampleIssues: (audit.integrity?.issues || []).slice(0, 15),
        note: audit.note
      }));
    } catch (error) {
      console.error("Goal Pulse history integrity audit failed:", String(error.message || error));
    }
  }, 25000).unref?.();
});