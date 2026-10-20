const http = require("node:http");
const webpush = require("web-push");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
let Pool = null;
try { ({ Pool } = require("pg")); } catch {}

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const API_BASE = "https://api.pitchapi.dev";
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
const PUSH_SCAN_TOKEN = process.env.PUSH_SCAN_TOKEN || "";
const pushScanSnapshots = new Map();
const pushScanLastAlert = new Map();
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
  if (!ALLOWED_ORIGINS.has(origin)) { send(res, 403, { error: "Origin not allowed" }); return false; }
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
const SCOREBOARD_TTL_MS = 45 * 1000;
const SCOREBOARD_STALE_TTL_MS = 15 * 1000;
const SCOREBOARD_LEAGUES = [
  "eng.1", "esp.1", "ita.1", "ger.1", "fra.1", "por.1", "ned.1", "sco.1", "gre.1", "tur.1", "bra.1", "arg.1", "usa.1", "mex.1", "aus.1", "eng.2", "esp.2", "ita.2", "ger.2", "fra.2", "bel.1", "aut.1", "sui.1", "den.1", "nor.1", "swe.1", "pol.1", "jpn.1", "kor.1", "sau.1", "bra.2", "eng.3", "eng.4", "ita.3", "ger.3", "fra.3", "por.2", "ned.2", "sco.2", "bel.2", "aut.2", "sui.2", "den.2", "nor.2", "swe.2", "pol.2", "tur.2", "usa.2", "bra.3", "arg.2", "uefa.champions", "uefa.europa", "uefa.europa.conf", "eng.fa", "eng.league_cup", "esp.copa_del_rey", "esp.super_cup", "ita.coppa_italia", "ita.super_cup", "ger.dfb_pokal", "ger.super_cup", "fra.coupe_de_france", "ned.cup", "sco.tennents", "sco.cis", "por.taca.portugal", "gre.cup", "arg.copa", "bra.copa_do_brazil", "conmebol.libertadores", "conmebol.sudamericana", "eng.5", "eng.6", "eng.7", "esp.3", "ita.4", "ger.4", "fra.4", "por.3", "ned.3", "gre.2", "bra.4", "arg.3", "jpn.2", "kor.2", "aus.2", "usa.nwsl", "eng.w.1", "esp.w.1", "fra.w.1", "uefa.nations", "fifa.world", "fifa.worldq.uefa", "fifa.worldq.conmebol", "conmebol.copa_america", "concacaf.gold", "concacaf.nations", "caf.nations", "afc.asian.cup", "fifa.cwc", "ita.w.1", "ger.w.1", "por.w.1", "mex.w.1", "bra.w.1", "arg.w.1", "aus.w.1", "uefa.w.champions", "chi.1", "col.1", "uru.1", "par.1", "ecu.1", "per.1", "bol.1", "ven.1", "crc.1", "egy.1", "rsa.1", "mar.1", "irn.1", "qat.1", "uae.1", "ind.1", "tha.1", "idn.1", "mys.1", "irl.1", "isl.1", "fin.1", "rou.1", "cro.1", "srb.1", "cze.1", "svk.1", "hun.1", "bul.1", "ukr.1", "rus.1", "nzl.1", "chi.2", "col.2", "uru.2", "par.2", "ecu.2", "per.2", "rou.2", "cro.2", "cze.2", "irl.2", "fin.2", "isl.2"
];
// Learn ESPN competition paths that return HTTP 400 so future refreshes skip them.
const ESPN_UNSUPPORTED_LEAGUES = new Set([
  "pol.1", "kor.1", "sau.1", "ger.3", "fra.3", "por.2",
  "bel.2", "pol.2", "usa.2", "gre.cup", "eng.6", "eng.7",
  "esp.3", "ger.4", "fra.4", "por.3", "gre.2", "jpn.2",
  "kor.2", "aus.2", "conmebol.copa_america", "concacaf.nations",
  "ita.w.1", "ger.w.1", "por.w.1", "bra.w.1", "arg.w.1",
  "uefa.w.champions", "egy.1", "mar.1", "irn.1", "qat.1", "uae.1",
  "isl.1", "cro.1", "srb.1"
]);
const scoreboardCache = new Map();
const scoreboardInflight = new Map();
const sportScoreWidgetSlugCache = { at: 0, map: new Map() };
const liveHistory = new Map();
const LIVE_HISTORY_TTL_MS = 11 * 60 * 1000;
function resolveDatabaseUrl(raw) {
  if (!raw) return "";
  // Render's DATABASE_URL was configured as the database password only.
  // Rebuild the URI using the known database metadata and Render's private hostname.
  const trimmed = String(raw).trim();
  if (/^[a-f0-9]{32}$/i.test(trimmed)) {
    const username = process.env.PGUSER || "goal_pulse_memberships_user";
    const database = process.env.PGDATABASE || "goal_pulse_memberships";
    const password = process.env.PGPASSWORD || process.env.DATABASE_PASSWORD || trimmed;
    const internalHost = "dpg-db9t153rjlhs7382ko40-a";
    return "postgresql://" + encodeURIComponent(username) + ":" + encodeURIComponent(password) + "@" + internalHost + "/" + encodeURIComponent(database);
  }
  // Normalize only the host. Keep credentials private and never log the full URL.
  const renderHost = "dpg-db9t153rjlhs7382ko40-a";
  try {
    const parsed = new URL(raw);
    if (parsed.hostname.toLowerCase() === "base" ||
        parsed.hostname.toLowerCase() === "dpg-db9t153rjlhs7382ko40-a") {
      parsed.hostname = renderHost;
    }
    return parsed.toString();
  } catch {
    // Safe fallback for URL strings that cannot be parsed because credentials are malformed.
    return raw
      .replace(/@base(?=[:/?#]|$)/i, "@" + renderHost)
      .replace(/:\/\/base(?=[:/?#]|$)/i, "://" + renderHost)
      .replace(/@dpg-db9t153rjlhs7382ko40-a(?=[:/?#]|$)/i, "@" + renderHost)
      .replace(/:\/\/dpg-db9t153rjlhs7382ko40-a(?=[:/?#]|$)/i, "://" + renderHost);
  }
}
const resolvedDatabaseUrl = resolveDatabaseUrl(process.env.DATABASE_URL || "");
const analyticsPool = resolvedDatabaseUrl && Pool ? new Pool({
  connectionString: resolvedDatabaseUrl,
  ssl: resolvedDatabaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000
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
        shots DOUBLE PRECISION,
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
      "INSERT INTO live_stat_snapshots (event_id, match_date, team_name, shots) VALUES ($1, $2, $3, $4) RETURNING id, event_id",
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
      const hasPersistableStat = ["shots", "shotsOnTarget", "corners", "attacks", "dangerousAttacks"]
        .some(key => team[key] != null && Number.isFinite(Number(team[key])));
      if (team.team && hasPersistableStat) {
        snapshots.push([String(match.eventId), date, String(team.team), team.shots, team.shotsOnTarget, team.corners, team.attacks, team.dangerousAttacks, String(match.minute || "")]);
      }
    }
    if (!snapshots.length) return true;
    const values = [];
    const tuples = snapshots.map((row, index) => {
      const n = index * 9;
      values.push(...row);
      return `($${n+1}, $${n+2}, $${n+3}, NOW(), $${n+4}, $${n+5}, $${n+6}, $${n+7}, $${n+8}, $${n+9})`;
    });
    const snapshotInsert = await analyticsPool.query(
      `INSERT INTO live_stat_snapshots
       (event_id, match_date, team_name, observed_at, shots, shots_on_target, corners, attacks, dangerous_attacks, minute)
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
           event_id, team_name, observed_at, shots, shots_on_target, corners, attacks, dangerous_attacks
         FROM live_stat_snapshots
         WHERE event_id = ANY($1::text[])
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
            shots: delta("shots"),
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
          available: teams.some(team => team.shots != null || team.shotsOnTarget != null || team.corners != null || team.attacks != null || team.dangerousAttacks != null),
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
        shots: team.shots,
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
        if (!previous) return { team: team.team, shots: null, shotsOnTarget: null, corners: null, attacks: null, dangerousAttacks: null };
        const delta = key => {
          const current = team[key];
          const old = previous[key];
          if (current == null || old == null || !Number.isFinite(Number(current)) || !Number.isFinite(Number(old))) return null;
          return Math.max(0, Number(current) - Number(old));
        };
        return { team: team.team, shots: delta("shots"), shotsOnTarget: delta("shotsOnTarget"), corners: delta("corners"), attacks: delta("attacks"), dangerousAttacks: delta("dangerousAttacks") };
      });
      const available = deltas.some(item => item.shots != null || item.shotsOnTarget != null || item.corners != null || item.attacks != null || item.dangerousAttacks != null);
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
    "ger.1":["bundesliga"],"ger.2":["2. bundesliga"],"fra.1":["ligue 1"],"fra.2":["ligue 2"],
    "por.1":["primeira liga","liga portugal"],"por.2":["liga portugal 2"],
    "ned.1":["eredivisie"],"ned.2":["eerste divisie"],"sco.1":["premiership"],"sco.2":["championship"],
    "gre.1":["super league greece","super league"],"tur.1":["super lig","süper lig"],
    "bra.1":["serie a"],"bra.2":["serie b"],"arg.1":["liga profesional","primera division"],"arg.2":["primera nacional"],
    "usa.1":["major league soccer","mls"],"usa.2":["usl championship"],"mex.1":["liga mx"],"aus.1":["a-league men","a-league"],
    "bel.1":["pro league"],"aut.1":["bundesliga"],"sui.1":["super league"],"den.1":["superliga"],"nor.1":["eliteserien"],"swe.1":["allsvenskan"],
    "pol.1":["ekstraklasa"],"jpn.1":["j1 league"],"kor.1":["k league 1"],"sau.1":["saudi pro league"],
    "uefa.champions":["uefa champions league","champions league"],"uefa.europa":["uefa europa league","europa league"],
    "uefa.europa.conf":["uefa conference league","conference league"],"eng.fa":["fa cup"],"eng.league_cup":["efl cup","league cup"],
    "esp.copa_del_rey":["copa del rey"],"ita.coppa_italia":["coppa italia"],"ger.dfb_pokal":["dfb pokal"]
  };
  return aliases[code] || [];
}
function pitchSeasonForCode(code, year, seasons) {
  const calendar = ["bra.1","arg.1","usa.1","mex.1","aus.1","bra.2","arg.2"].includes(code);
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
  const countryCodes = {eng:["ENG","GB","GBR","UK"],esp:["ESP"],ita:["ITA"],ger:["DEU","GER","DE"],fra:["FRA"],por:["PRT","POR","PT"],ned:["NLD","NED","NL"],sco:["SCO","GB","GBR","UK"],gre:["GRC","GRE","GR"],tur:["TUR"],bra:["BRA"],arg:["ARG"],usa:["USA"],mex:["MEX"],aus:["AUS"],bel:["BEL"],aut:["AUT"],sui:["CHE","SUI","CH"],den:["DNK","DEN","DK"],nor:["NOR"],swe:["SWE"],pol:["POL"],jpn:["JPN"],kor:["KOR"],sau:["SAU"]};
  const allowed = countryCodes[country] || [];
  return candidates.find(item => allowed.includes(String(item.country_code || "").toUpperCase())) || null;
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
const oddsPapiCache = new Map();
const normalizeOddsTeam = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
async function oddsPapiGet(pathname, params = {}, ttlMs = 15000) {
  const apiKey = process.env.ODDSPAPI_API_KEY;
  if (!apiKey) return null;
  const query = new URLSearchParams({ ...params, apiKey });
  const cacheKey = pathname + "?" + query.toString().replace(/apiKey=[^&]+/, "apiKey=[redacted]");
  const cached = oddsPapiCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ttlMs) return cached.body;
  const response = await fetch(ODDS_PAPI_BASE + "/" + pathname + "?" + query.toString(), {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(9000)
  });
  if (!response.ok) {
    const error = new Error("OddsPapi HTTP " + response.status);
    error.status = response.status;
    throw error;
  }
  const body = await response.json();
  oddsPapiCache.set(cacheKey, { at: Date.now(), body });
  if (oddsPapiCache.size > 100) oddsPapiCache.delete(oddsPapiCache.keys().next().value);
  return body;
}
async function getVerifiedFirstHalfOver15(match) {
  if (!process.env.ODDSPAPI_API_KEY) return null;
  const now = new Date();
  // Keep the query window strictly below the API 48-hour limit for sportId + from/to.
  const from = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const to = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();
  const fixtures = await oddsPapiGet("fixtures", { sportId: "10", from, to, statusId: "1" }, 20000);
  if (!Array.isArray(fixtures)) return null;
  const home = normalizeOddsTeam(match.home || match.homeTeam || match.teams?.[0]?.name);
  const away = normalizeOddsTeam(match.away || match.awayTeam || match.teams?.[1]?.name);
  if (!home || !away) return null;
  const fixture = fixtures.find(item => {
    const status = String(item.statusName || "").toLowerCase();
    if (!/in.play|live|1st half|first half|half.time|2nd half|second half/.test(status)) return false;
    const h = normalizeOddsTeam(item.participant1Name || item.participant1ShortName);
    const a = normalizeOddsTeam(item.participant2Name || item.participant2ShortName);
    return h === home && a === away;
  });
  if (!fixture || !fixture.fixtureId || fixture.statusName === "Ended") return null;
  const [markets, odds] = await Promise.all([
    oddsPapiGet("markets", { language: "en" }, 6 * 60 * 60 * 1000),
    oddsPapiGet("odds", { fixtureId: fixture.fixtureId, oddsFormat: "decimal" }, 12000)
  ]);
  if (!Array.isArray(markets) || !odds || !odds.bookmakerOdds) return null;
  const firstHalfMarkets = markets.filter(m => Number(m.sportId) === 10 &&
    /over.?under.*first half|first half.*over.?under/i.test(String(m.marketName || "")) &&
    Math.abs(Number(m.handicap) - 1.5) < 0.001 &&
    String(m.period || "").toLowerCase().replace(/[_ -]/g, "").includes("firsthalf") &&
    String(m.marketType || "").toLowerCase() === "totals");
  if (!firstHalfMarkets.length) return null;
  const valid = [];
  for (const [bookmaker, board] of Object.entries(odds.bookmakerOdds)) {
    if (board?.bookmakerIsActive === false || board?.suspended === true) continue;
    for (const marketDef of firstHalfMarkets) {
      const market = board?.markets?.[String(marketDef.marketId)];
      if (!market || market.marketActive === false) continue;
      for (const [outcomeId, outcome] of Object.entries(market.outcomes || {})) {
        const definition = (marketDef.outcomes || []).find(o => String(o.outcomeId) === String(outcomeId));
        if (!/over/i.test(String(definition?.outcomeName || ""))) continue;
        const player = outcome?.players?.["0"];
        const price = Number(player?.price);
        if (!player?.active || !Number.isFinite(price) || price < 1.6) continue;
        // changedAt records the last price movement, not feed freshness; an unchanged active quote remains valid.
        const changedAt = Date.parse(player.changedAt || player.bookmakerChangedAt || "");
        valid.push({ price, bookmaker, line: Number(marketDef.handicap), changedAt: Number.isFinite(changedAt) ? changedAt : null });
      }
    }
  }
  valid.sort((a, b) => b.price - a.price);
  return valid[0] || null;
}

const ALLOWED_ORIGINS = new Set([
  "https://goal-pulse.onrender.com",
  "https://goal-pulse-live-2026-2.onrender.com"
]);
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Cache-Control");
  }
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, "http://localhost");
  if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { error: "Method not allowed" });

  if (url.pathname === "/api/alerts/history" && req.method === "GET") {
    if (!ALLOWED_ORIGINS.has(req.headers.origin || "")) return send(res, 403, { error: "Origin not allowed" });
    if (!await ensureAlertHistoryDb()) return send(res, 503, { error: "Persistent alert history database unavailable" });
    try {
      const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get("limit") || 5000)));
      const result = await analyticsPool.query("SELECT payload FROM alert_history ORDER BY created_at DESC LIMIT $1", [limit]);
      return send(res, 200, { ok: true, persistent: true, alerts: result.rows.map(row => row.payload) });
    } catch (error) {
      return send(res, 503, { error: "Could not load alert history" });
    }
  }
  if (url.pathname === "/api/alerts/history" && req.method === "POST") {
    if (!ALLOWED_ORIGINS.has(req.headers.origin || "")) return send(res, 403, { error: "Origin not allowed" });
    if (!await ensureAlertHistoryDb()) return send(res, 503, { error: "Persistent alert history database unavailable" });
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
      await analyticsPool.query(
        "INSERT INTO alert_history(alert_id,event_id,level,created_at,payload,updated_at) SELECT x.alert_id,x.event_id,x.level,to_timestamp(x.created_at/1000.0),x.payload,NOW() FROM jsonb_to_recordset($1::jsonb) AS x(alert_id text,event_id text,level text,created_at numeric,payload jsonb) ON CONFLICT(alert_id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=NOW()",
        [JSON.stringify(records)]
      );
      return send(res, 200, { ok: true, persistent: true, saved: records.length });
    } catch (error) {
      console.error("Alert history write failed:", error.message);
      return send(res, 503, { error: "Could not save alert history" });
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
  if (url.pathname === "/api/push/alert" && req.method === "POST") {
    if (!pushRequestAllowed(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const level = body.level === "VIP" ? "VIP" : "AI";
      const title = level === "VIP" ? "Goal Pulse · ◆ VIP ALERT" : "Goal Pulse · AI ALERT";
      const result = await sendPushToSubscribers({
        title,
        body: String(body.body || "Νέα live ένδειξη στο Goal Pulse").slice(0, 180),
        tag: "goal-pulse-" + level.toLowerCase() + "-" + String(body.eventId || "live").slice(0, 60),
        url: "/"
      });
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
      const scoreboardResponse = await fetch(base + "/api/scoreboard?date=" + date, { signal: AbortSignal.timeout(25000) });
      if (!scoreboardResponse.ok) throw new Error("Scoreboard unavailable: " + scoreboardResponse.status);
      const metricsResponse = await fetch(base + "/api/live-metrics?date=" + date, { signal: AbortSignal.timeout(45000) });
      if (!metricsResponse.ok) throw new Error("Live metrics unavailable: " + metricsResponse.status);
      const metrics = await metricsResponse.json();
      const scoreboard = await scoreboardResponse.json();
      const scoreboardEvents = (scoreboard.feeds || []).flatMap(feed => feed.events || []);
      const now = Date.now();
      // Evaluate persisted real push alerts at the end of their selected half.
      // First-half outcomes use halftime scores, so second-half goals cannot falsely confirm them.
      if (await ensureAlertHistoryDb()) {
        try {
          const pending = await analyticsPool.query(
            "SELECT alert_id,payload FROM alert_history WHERE payload->>'source'='server-push' AND payload->>'market'='πιθανό γκολ' AND payload->>'outcome'='εκκρεμεί' AND created_at > NOW() - INTERVAL '3 days' ORDER BY created_at ASC LIMIT 1000"
          );
          const metricById = new Map((metrics.matches || []).map(item => [String(item.eventId), item]));
          const normalizeTeam = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          const completedScoreboardByTeams = new Map();
          for (const event of scoreboardEvents) {
            const competition = event.competitions?.[0];
            const competitors = competition?.competitors || [];
            const home = competitors.find(team => team.homeAway === "home") || competitors[0];
            const away = competitors.find(team => team.homeAway === "away") || competitors[1];
            const state = String(event.status?.type?.state || "").toLowerCase();
            const statusLabel = String(event.status?.type?.name || event.status?.type?.detail || event.status?.type?.shortDetail || "").toLowerCase();
            if (!home?.team?.displayName || !away?.team?.displayName || !(state === "post" || /final|full.?time|finished|ended|\bft\b/.test(statusLabel))) continue;
            completedScoreboardByTeams.set(normalizeTeam(home.team.displayName) + "|" + normalizeTeam(away.team.displayName), {
              status: "post", statusText: "finished", homeScore: home.score, awayScore: away.score
            });
          }
          for (const row of pending.rows) {
            const alert = row.payload || {};
            const minuteMatch = String(alert.minuteNumber ?? alert.minute ?? "").match(/(\d{1,3})/);
            const signalMinute = Number(alert.minuteNumber ?? (minuteMatch ? minuteMatch[1] : NaN));
            const explicitPeriod = String(alert.periodAtSignal || "").toLowerCase();
            // Trust the explicit period captured at signal time over a parsed clock number.
            // Some feeds expose "2nd half" in a clock field, whose first digit can parse as minute 2.
            const firstHalf = explicitPeriod
              ? explicitPeriod === "first_half" || explicitPeriod === "halftime"
              : Number.isFinite(signalMinute) && signalMinute <= 45;
            const secondHalf = explicitPeriod
              ? explicitPeriod === "second_half"
              : !firstHalf && Number.isFinite(signalMinute) && signalMinute > 45;
            let live = metricById.get(String(alert.eventId));
            // Live-metrics drops fixtures after full time. For second-half alerts only,
            // recover a completed final score from the scoreboard by exact home/away team order.
            // This is deliberately not used for first-half alerts: full-time scores cannot
            // establish what happened before halftime.
            if (secondHalf && (!live || !/finished|full.?time|ended|final|\bft\b/.test(String(live.statusText || live.status || "").toLowerCase())) && alert.home && alert.away) {
              const completed = completedScoreboardByTeams.get(normalizeTeam(alert.home) + "|" + normalizeTeam(alert.away));
              if (completed) live = completed;
            }
            if (!live) continue;
            const statusText = String(live.statusText || live.status || "").toLowerCase();
            const statusClock = String(live.minute || "").toLowerCase();
            const homeScore = Number(live.homeScore), awayScore = Number(live.awayScore);
            const hasFullScore = live.homeScore != null && live.awayScore != null && Number.isFinite(homeScore) && Number.isFinite(awayScore);
            let outcomeScore = null, finished = false;
            if (firstHalf) {
              const hasHtScore = live.homeHtScore != null && live.awayHtScore != null && Number.isFinite(Number(live.homeHtScore)) && Number.isFinite(Number(live.awayHtScore));
              const isAtHalf = /half.?time|halftime|ημίχρονο/.test(statusText) || /\bht\b/.test(statusClock);
              const minuteNow = Number(String(live.minute || "").match(/(\d{1,3})/)?.[1]);
              if (hasHtScore) {
                outcomeScore = Number(live.homeHtScore) + Number(live.awayHtScore);
                finished = true;
              } else if (isAtHalf && hasFullScore) {
                outcomeScore = homeScore + awayScore;
                finished = true;
              } else if (Number.isFinite(minuteNow) && minuteNow >= 46) {
                // Do not infer a first-half result from a second-half score.
                continue;
              } else if (/finished|full.?time|ended|final|ft/.test(statusText) && !hasHtScore) {
                continue;
              }
            } else if (secondHalf) {
              finished = /finished|full.?time|ended|final|ft/.test(statusText) || live.status === "post";
              if (finished && hasFullScore) outcomeScore = homeScore + awayScore;
            }
            if (!finished || outcomeScore == null || alert.startScore == null) continue;
            alert.outcome = outcomeScore > Number(alert.startScore)
              ? "Επιβεβαιώθηκε · γκολ μέχρι τη λήξη του ημιχρόνου"
              : "Δεν επιβεβαιώθηκε · χωρίς γκολ μέχρι τη λήξη του ημιχρόνου";
            alert.evaluatedAt = now;
            alert.evaluationRule = "end_of_relevant_half";
            await analyticsPool.query(
              "UPDATE alert_history SET payload=$2::jsonb,updated_at=NOW() WHERE alert_id=$1",
              [row.alert_id, JSON.stringify(alert)]
            );
          }
        } catch (evaluationError) {
          console.error("AI alert halftime outcome evaluation failed:", evaluationError.message);
        }
      }
      let checked = 0, sent = 0, candidates = 0;
      const formatPushMinute = match => {
        const rawMinute = match.minute ?? match.elapsed ?? match.liveMinute ?? match.live_minute ?? match.time?.elapsed ?? match.time?.minute;
        if (rawMinute != null && String(rawMinute).trim() !== "") {
          const numericMinute = Number(rawMinute);
          if (Number.isFinite(numericMinute) && numericMinute >= 0) return String(Math.floor(numericMinute)) + "′";
          return String(rawMinute).trim().slice(0, 24);
        }
        const statusText = String(match.status_text || match.statusText || match.status || "").trim();
        return statusText || "LIVE";
      };
      for (const match of (metrics.matches || [])) {
        if (!match.statsAvailable || !Array.isArray(match.teams) || match.teams.length < 2) continue;
        const teams = match.teams;
        const total = key => teams.every(team => team[key] != null)
          ? teams.reduce((sum, team) => sum + Number(team[key] || 0), 0) : null;
        const current = {
          at: now,
          shots: total("shots"),
          onTarget: total("shotsOnTarget"),
          corners: total("corners"),
          attacks: total("attacks"),
          dangerous: total("dangerousAttacks")
        };
        const id = String(match.eventId);
        const previous = pushScanSnapshots.get(id);
        pushScanSnapshots.set(id, current);
        checked++;
        if (!previous || now - previous.at < 35000) continue;
        const delta = key => current[key] == null || previous[key] == null ? 0 : Math.max(0, current[key] - previous[key]);
        const shots = delta("shots"), onTarget = delta("onTarget"), corners = delta("corners");
        const attacks = delta("attacks"), dangerous = delta("dangerous");
        const evidenceKinds = [shots, onTarget, corners, attacks, dangerous].filter(value => value > 0).length;
        // High Activity is only the candidate pool. Push alerts use a separate,
        // stricter goal-likelihood gate; pressure alone must never trigger a goal alert.
        // Require multiple new shots, a shot on target, at least three independent
        // signals, a strong combined score, and corroborating corners/dangerous attacks.
        const scoreAvailable = match.homeScore != null && match.awayScore != null && Number.isFinite(Number(match.homeScore)) && Number.isFinite(Number(match.awayScore));
        const goalEvidence = shots >= 2 && onTarget >= 1;
        const points = Math.min(shots, 4) + onTarget * 2 + corners * 2 + Math.min(attacks * 0.25, 3) + Math.min(dangerous * 0.75, 5);
        const isAiGoal = scoreAvailable && goalEvidence && evidenceKinds >= 3 && points >= 7 && (corners >= 1 || dangerous >= 3);
        const isVip = isAiGoal && corners >= 1 && points >= 9;
        const levels = [];
        // Send one alert only: VIP when the evidence is exceptionally strong, otherwise AI.
        if (isVip) levels.push("VIP");
        else if (isAiGoal) levels.push("AI");
        for (const level of levels) {
          // Betting-tip pushes are fail-closed: never publish a market/price unless
          // a live, correctly matched, active first-half Over 1.5 quote is verified.
          let verifiedOdds = null;
          try {
            const currentGoals = Number(match.homeScore) + Number(match.awayScore);
            const minuteRaw = match.minute ?? match.elapsed ?? match.liveMinute ?? match.live_minute ?? match.time?.elapsed ?? match.time?.minute;
            const minute = Number(minuteRaw);
            const status = String(match.statusText || match.status || match.status_text || "").toLowerCase();
            const firstHalfNow = Number.isFinite(minute) && minute >= 1 && minute <= 45 && !/second half|2nd half|halftime|half.?time|ημίχρονο/.test(status);
            if (firstHalfNow && Number.isFinite(currentGoals) && currentGoals < 2) {
              verifiedOdds = await getVerifiedFirstHalfOver15(match);
            }
          } catch (oddsError) {
            console.error("Odds verification unavailable; suppressing unpriced betting alert:", oddsError.message);
          }
          if (!verifiedOdds || verifiedOdds.price < 1.6) continue;
          const cooldownKey = id + ":" + level;
          if (now - (pushScanLastAlert.get(cooldownKey) || 0) < 8 * 60 * 1000) continue;
          const reason = [
            shots ? shots + " νέες τελικές" : "",
            onTarget ? onTarget + " νέα σουτ στην εστία" : "",
            corners ? corners + " νέα κόρνερ" : "",
            attacks ? attacks + " νέες επιθέσεις" : "",
            dangerous ? dangerous + " νέες επικίνδυνες επιθέσεις" : ""
          ].filter(Boolean).join(" · ");
          const result = await sendPushToSubscribers({
            title: level === "VIP" ? "Goal Pulse · ◆ VIP ALERT" : "Goal Pulse · AI ALERT",
            body: ((match.home || "Γηπεδούχος") + " – " + (match.away || "Φιλοξενούμενος") + ": Πρόταση Over 1,5 γκολ 1ου ημιχρόνου · " + formatPushMinute(match) + " · απόδοση " + verifiedOdds.price.toFixed(2) + " (" + verifiedOdds.bookmaker + ") · " + reason).slice(0, 240),
            tag: "goal-pulse-bg-" + level.toLowerCase() + "-" + id,
            url: "/"
          });
          if (result.sent > 0) {
            pushScanLastAlert.set(cooldownKey, now);
            sent += result.sent;
            // Persist the actual server-generated push, not just browser-side test signals.
            // This record becomes the source of truth for later 10-minute outcome evaluation.
            try {
              if (await ensureAlertHistoryDb()) {
                const alertId = "push:" + id + ":" + level + ":" + now;
                const scoreValue = value => {
                  const n = Number(value);
                  return value !== null && value !== undefined && value !== "" && Number.isFinite(n) ? n : null;
                };
                const scoreEvent = scoreboardEvents.find(event => String(event.id || "") === id);
                const competitors = scoreEvent?.competitions?.[0]?.competitors || [];
                const homeCompetitor = competitors.find(team => team.homeAway === "home") || competitors[0];
                const awayCompetitor = competitors.find(team => team.homeAway === "away") || competitors[1];
                const homeScore = scoreValue(match.homeScore ?? homeCompetitor?.score);
                const awayScore = scoreValue(match.awayScore ?? awayCompetitor?.score);
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
                  minute: rawMinute, minuteNumber, market: "Over 1,5 γκολ 1ου ημιχρόνου", odds: verifiedOdds.price, bookmaker: verifiedOdds.bookmaker, oddsVerifiedAt: new Date(verifiedOdds.changedAt).toISOString(),
                  periodAtSignal: halfTime ? "halftime" : secondHalf ? "second_half" : "first_half",
                  reason, outcome: "εκκρεμεί", evaluationRule: "end_of_relevant_half",
                  ...(homeScore !== null && awayScore !== null ? { startScore: homeScore + awayScore, startHomeScore: homeScore, startAwayScore: awayScore } : {}),
                  statsAtSignal: { shots, onTarget, corners, attacks, dangerous, evidenceKinds, points }
                };
                await analyticsPool.query(
                  "INSERT INTO alert_history(alert_id,event_id,level,created_at,payload,updated_at) VALUES($1,$2,$3,to_timestamp($4/1000.0),$5::jsonb,NOW()) ON CONFLICT(alert_id) DO NOTHING",
                  [alertId, id, level, now, JSON.stringify(alertRecord)]
                );
              } else {
                console.error("Actual push alert was sent but persistent history database is unavailable:", id);
              }
            } catch (historyError) {
              console.error("Actual push alert history save failed:", historyError.message);
            }
          }
          candidates++;
        }
      }
      for (const [id, item] of pushScanSnapshots) if (now - item.at > 15 * 60 * 1000) pushScanSnapshots.delete(id);
      const liveMatches = Number(metrics.totalLive || 0);
      const statsMatches = (metrics.matches || []).filter(match => match.statsAvailable).length;
      let subscribers = pushSubscriptions.size;
      if (await ensurePushDb()) {
        try {
          const subscriberResult = await analyticsPool.query("SELECT COUNT(*)::int AS count FROM push_subscriptions");
          subscribers = subscriberResult.rows[0].count;
        } catch {}
      }
      return send(res, 200, { ok: true, liveMatches, statsMatches, checked, candidates, deliveries: sent, subscribers, date, pushConfigured: Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) });
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
      pushScannerEnabled: Boolean(PUSH_SCAN_TOKEN && process.env.PUSH_SCAN_INTERVAL_ENABLED === "true")
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
      const pitchLeague = await findPitchLeague(league);
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
    if (!SCOREBOARD_LEAGUES.includes(league)) return send(res, 400, { error: "Unsupported league", matches: [] });
    if (!Number.isInteger(season) || season < 2000 || season > new Date().getUTCFullYear() + 1) return send(res, 400, { error: "Invalid season", matches: [] });
    const historyKey = "competition-history:" + league + ":" + season;
    try {
      const pitchLeague = await findPitchLeague(league);
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
          const result = { league, season, seasonStart: "", seasonEnd: "", matches, fetchedAt: new Date().toISOString(), source: "PitchAPI" };
          cache.set(historyKey, { at: Date.now(), body: result });
          return send(res, 200, result);
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
        const range = compactDate(window.start) + "-" + compactDate(window.end);
        const response = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/" + league + "/scoreboard?limit=1000&dates=" + range, {
          headers: { "Accept": "application/json" },
          signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new Error("Competition history provider unavailable");
        const body = await response.json();
        return Array.isArray(body.events) ? body.events : [];
      }));
      const successfulWindows = windowResults.filter(result => result.status === "fulfilled");
      if (!successfulWindows.length) throw new Error("No competition history windows available");
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
      const result = { league, season, seasonStart: start.toISOString().slice(0,10), seasonEnd: end.toISOString().slice(0,10), matches, fetchedAt: new Date().toISOString() };
      cache.set(historyKey, { at: Date.now(), body: result });
      return send(res, 200, result);
    } catch (error) {
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
          // Run the three ESPN league batches concurrently so one slow league batch
          // cannot make the public scoreboard miss the browser's request deadline.
          const espnBatches = Array.from({ length: Math.ceil(espnLeagues.length / 36) }, (_, index) =>
            espnLeagues.slice(index * 36, (index + 1) * 36)
          );
          const batchResults = await Promise.all(espnBatches.map(batch => Promise.all(batch.map(async code => {
            try {
              const response = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/" + code + "/scoreboard?dates=" + date, {
                headers: { "Accept": "application/json" },
                signal: AbortSignal.timeout(8000)
              });
              if (!response.ok) { if (response.status === 400) ESPN_UNSUPPORTED_LEAGUES.add(code); return { code, events: [], ok: false, error: "HTTP " + response.status }; }
              const body = await response.json();
              return { code, events: Array.isArray(body.events) ? body.events : [], ok: true };
            } catch (error) {
              return { code, events: [], ok: false, error: error.message || "request failed" };
            }
          }))));
          feeds.push(...batchResults.flat());
          let finalFeeds = feeds;
          let successfulFeeds = feeds.filter(feed => feed.ok).length;
          if (process.env.PITCH_API_KEY && process.env.PITCH_API_SCOREBOARD_FALLBACK_ENABLED === "true" && !feeds.some(feed => feed.ok)) {
            // Use PitchAPI as a fallback only when ESPN returned no fixtures; avoid delaying the live scoreboard when ESPN already has data.
            try {
              const isoDate = date.slice(0,4) + "-" + date.slice(4,6) + "-" + date.slice(6,8);
              const directory = (await pitchGet("/v1/leagues"))?.data?.leagues || [];
              const normal = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
              const countryCodes = {
                eng:["ENG","GB","GBR","UK"],esp:["ESP"],ita:["ITA"],ger:["DEU","GER","DE"],fra:["FRA"],
                por:["PRT","POR","PT"],ned:["NLD","NED","NL"],sco:["SCO","GB","GBR","UK"],gre:["GRC","GRE","GR"],
                tur:["TUR"],bra:["BRA"],arg:["ARG"],usa:["USA"],mex:["MEX"],aus:["AUS"],bel:["BEL"],aut:["AUT"],
                sui:["CHE","SUI","CH"],den:["DNK","DEN","DK"],nor:["NOR"],swe:["SWE"],pol:["POL"],jpn:["JPN"],
                kor:["KOR"],sau:["SAU"]
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
            const sportScoreResponses = await Promise.all(["live", "upcoming"].map(async status => {
              const endpoint = "https://sportscore.com/api/v1/fixtures/?sport=football" +
                (status === "live" ? "" : "&date=" + encodeURIComponent(requestedIsoDate)) + "&status=" + status + "&limit=200&src=goal-pulse";
              try {
                const response = await fetch(endpoint, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(9000) });
                if (!response.ok) return { status, ok: false, httpStatus: response.status, matches: [] };
                const body = await response.json();
                const matches = Array.isArray(body.matches) ? body.matches :
                  Array.isArray(body.data) ? body.data :
                  Array.isArray(body.fixtures) ? body.fixtures : [];
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
                const matchDate = matchTime ? new Date(matchTime) : null;
                if (!matchDate || !Number.isFinite(matchDate.getTime())) continue;
                if (result.status !== "live" && matchDate.toISOString().slice(0, 10) !== requestedIsoDate) continue;
                const homeName = String(match.home || match.home_name || match.home_team?.name || match.homeTeam?.name || match.participants?.find(p => p.meta?.location === "home")?.name || "").trim();
                const awayName = String(match.away || match.away_name || match.away_team?.name || match.awayTeam?.name || match.participants?.find(p => p.meta?.location === "away")?.name || "").trim();
                if (!homeName || !awayName) continue;
                const rawStatus = String(match.status_text || match.status || match.state || result.status || "").toLowerCase();
                const state = result.status === "live" || /live|in play|in-play|playing|1st half|2nd half|half time|extra time|penalt|in_progress/.test(rawStatus)
                  ? "in"
                  : /finished|full time|ended|complete|after extra|\bft\b|\baet\b|\bpen\b/.test(rawStatus)
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
                const status = { type: { state, completed: state === "post" }, displayClock: String(match.minute || match.status_text || (state === "in" ? "LIVE" : "")) };
                sportScoreEvents.push({
                  id: eventId, date: matchDate.toISOString(), name: homeName + " vs " + awayName,
                  leagueName: String(match.competition?.name || match.league?.name || match.competition_name || match.league_name || "Football"),
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
              console.log("SportScore live/upcoming fixtures:", JSON.stringify({
                date, liveReceived: sportScoreResponses.find(x => x.status === "live")?.matches.length || 0,
                upcomingReceived: sportScoreResponses.find(x => x.status === "upcoming")?.matches.length || 0,
                mapped: sportScoreEvents.length, added: missingSportScoreEvents.length,
                errors: sportScoreResponses.filter(x => !x.ok).map(x => ({ status: x.status, httpStatus: x.httpStatus, error: x.error }))
              }));
            } else {
              console.warn("SportScore returned no mappable fixtures:", JSON.stringify(sportScoreResponses.map(x => ({ status: x.status, ok: x.ok, received: x.matches.length, httpStatus: x.httpStatus, error: x.error }))));
            }
          } catch (error) {
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
              const liveFixtures = Array.isArray(payload) ? payload : (payload.matches || payload.data || payload.fixtures || payload.events || payload.results || []);
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
                const status = { type: { state: "in", completed: false }, displayClock: String(match.minute ?? match.elapsed ?? match.status_text ?? "LIVE") };
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
                sample: liveFixtures.slice(0, 3).map(match => ({ keys: Object.keys(match || {}), id: match.id, slug: match.slug, status: match.status, status_text: match.status_text, home: match.home, away: match.away }))
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
          const body = { date, successfulFeeds, totalFeeds: SCOREBOARD_LEAGUES.length, feeds: finalFeeds.map(({code,events,ok}) => ({code,events,ok})), source: successfulFeeds ? scoreboardSource : "unavailable" };
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
      const cacheKey = "live-metrics:" + date;
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
      const liveEvents = scoreboard.body.feeds.flatMap(feed => (feed.events || [])
        .filter(event => (event.status?.type?.state || event.competitions?.[0]?.status?.type?.state) === "in")
        .map(event => ({ event, leagueCode: feed.code })));
      const sportScoreLiveExists = liveEvents.some(item => String(item.event.id).startsWith("sportscore:"));
      const sportScoreLiveStatsByPair = new Map();
      if (sportScoreLiveExists) {
        try {
          const liveDate = date.slice(0, 4) + "-" + date.slice(4, 6) + "-" + date.slice(6, 8);
          const liveResponse = await fetch("https://sportscore.com/api/v1/fixtures/?sport=football&date=" + liveDate + "&status=live&limit=200", {
            headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(9000)
          });
          if (liveResponse.ok) {
            const livePayload = await liveResponse.json();
            const liveFixtures = Array.isArray(livePayload) ? livePayload : (livePayload.matches || livePayload.data || livePayload.fixtures || livePayload.events || livePayload.results || []);
            const normalizeDirectTeam = value => String(value || "").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().replace(/\\b(fc|cf|sc|afc|club|football|soccer)\\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
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
      if (sportScoreLiveExists && Date.now() - sportScoreWidgetSlugCache.at > 45000) {
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
            const liveSlugFixtures = Array.isArray(payload) ? payload : (payload.matches || payload.data || payload.fixtures || payload.events || payload.results || []);
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
      const work = liveEvents.slice(0, 36);
      let cursor = 0;
      const matches = [];
      const sportScoreDetailDiagnostics = { ok: 0, notFound: 0, otherErrors: 0, statuses: {}, slugSamples: [], sample: null };
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
                let detailResponse = await fetch("https://sportscore.com/api/widget/match/?sport=football&slug=" + encodeURIComponent(slug) + "&src=goal-pulse", {
                  headers: { "Accept": "application/json" },
                  signal: AbortSignal.timeout(8000)
                });
                if (detailResponse.status === 404 && slug.includes("-vs-")) {
                  const parts = slug.split("-vs-");
                  if (parts.length === 2) {
                    const reverseSlug = parts[1] + "-vs-" + parts[0];
                    const retryResponse = await fetch("https://sportscore.com/api/widget/match/?sport=football&slug=" + encodeURIComponent(reverseSlug) + "&src=goal-pulse", {
                      headers: { "Accept": "application/json" },
                      signal: AbortSignal.timeout(8000)
                    });
                    if (retryResponse.ok) { slug = reverseSlug; detailResponse = retryResponse; }
                    else {
                      const statusKey = String(retryResponse.status);
                      sportScoreDetailDiagnostics.statuses[statusKey] = (sportScoreDetailDiagnostics.statuses[statusKey] || 0) + 1;
                    }
                  }
                }
                if (!detailResponse.ok) {
                  const statusKey = String(detailResponse.status);
                  sportScoreDetailDiagnostics.statuses[statusKey] = (sportScoreDetailDiagnostics.statuses[statusKey] || 0) + 1;
                  if (detailResponse.status === 404) sportScoreDetailDiagnostics.notFound++;
                  else sportScoreDetailDiagnostics.otherErrors++;
                  continue;
                }
                detail = await detailResponse.json();
                sportScoreDetailDiagnostics.ok++;
              }
              const root = detail.match || detail.data || detail.fixture || detail;
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
                    if (/stat|shot|corner|attack|possession|expected|home|away|slug|match/i.test(key)) {
                      paths.push({ path: next, type: Array.isArray(value) ? "array" : typeof value, sample: value == null || typeof value !== "object" ? value : undefined });
                    }
                    if (value && typeof value === "object") inspect(value, next, depth + 1);
                  }
                };
                inspect(root);
                sportScoreDetailDiagnostics.sample = { eventId: String(event.id), rootKeys: Object.keys(root || {}), paths: paths.slice(0, 40) };
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
                if (label && home != null && away != null && (typeof home !== "object") && (typeof away !== "object")) statsRows.push({ label, home, away });
                for (const [key, value] of Object.entries(node)) {
                  if (["home","away","home_value","away_value","homeValue","awayValue","value_home","value_away"].includes(key)) continue;
                  walk(value, depth + 1);
                }
              };
              walk(root);
              if (sportScoreDetailDiagnostics.sample?.eventId === String(event.id)) {
                sportScoreDetailDiagnostics.sample.statLabels = statsRows.slice(0, 30).map(row => ({ label: row.label, home: row.home, away: row.away }));
              }
              const readStat = (side, aliases) => {
                const found = statsRows.find(row => aliases.includes(row.label));
                if (!found) return null;
                const raw = found[side];
                const n = Number.parseFloat(String(raw).replace("%", "").replace(",", "."));
                return Number.isFinite(n) ? n : null;
              };
              const values = [
                { team: homeName, homeAway: "home", shots: readStat("home", ["total_shots","total_shot","totalshots","shots","shots_total","total_attempts","total_shots_attempted","shots_attempted"]), shotsOnTarget: readStat("home", ["shots_on_target","shots_on_goal","shots_on_target_total","sot","on_target"]), shotsOffTarget: readStat("home", ["shots_off_target","shots_off_goal","shots_wide","off_target","shots_off_target_total"]), blockedShots: readStat("home", ["blocked_shots","shots_blocked","blocked_attempts"]), corners: readStat("home", ["corners","corner","corner_kicks","won_corners","corner_kicks_total","total_corners"]), attacks: readStat("home", ["attacks","total_attacks","attacks_for","total_attacks_for"]), dangerousAttacks: readStat("home", ["dangerous_attacks","dangerous_attacks_for","dangerous_attacks_created"]), possession: readStat("home", ["possession","ball_possession","possession_percentage","possession_pct","ball_possession_percentage"]), xG: readStat("home", ["expected_goals","xg","expected_goals_xg","expected_goals_for"]) },
                { team: awayName, homeAway: "away", shots: readStat("away", ["total_shots","total_shot","totalshots","shots","shots_total","total_attempts","total_shots_attempted","shots_attempted"]), shotsOnTarget: readStat("away", ["shots_on_target","shots_on_goal","shots_on_target_total","sot","on_target"]), shotsOffTarget: readStat("away", ["shots_off_target","shots_off_goal","shots_wide","off_target","shots_off_target_total"]), blockedShots: readStat("away", ["blocked_shots","shots_blocked","blocked_attempts"]), corners: readStat("away", ["corners","corner","corner_kicks","won_corners","corner_kicks_total","total_corners"]), attacks: readStat("away", ["attacks","total_attacks","attacks_for","total_attacks_for"]), dangerousAttacks: readStat("away", ["dangerous_attacks","dangerous_attacks_for","dangerous_attacks_created"]), possession: readStat("away", ["possession","ball_possession","possession_percentage","possession_pct","ball_possession_percentage"]), xG: readStat("away", ["expected_goals","xg","expected_goals_xg","expected_goals_for"]) }
              ];
              // SportScore often omits a separate total-shots row while exposing shots on/off target.
              // Derive total shots only when both component values exist; never guess missing values.
              for (const value of values) {
                if (value.shots == null && value.shotsOnTarget != null && value.shotsOffTarget != null) {
                  value.shots = Number(value.shotsOnTarget) + Number(value.shotsOffTarget);
                }
              }
              matches.push({
                eventId: String(event.id), home: homeName, away: awayName,
                minute: event.live_minute ?? event.status?.displayClock ?? event.time ?? "",
                homeScore: event.home_score ?? event.homeScore ?? null,
                awayScore: event.away_score ?? event.awayScore ?? null,
                status: event.status ?? "", statusText: event.status_text ?? event.statusText ?? "",
                homeHtScore: event.home_ht_score ?? null, awayHtScore: event.away_ht_score ?? null,
                statsAvailable: values.some(value => ["shots","shotsOnTarget","corners","possession","xG"].some(key => value[key] !== null)),
                teams: values
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
              const readStat = (side, aliases) => {
                const found = items.find(stat => aliases.includes(String(stat.key || "").toLowerCase()) || aliases.includes(String(stat.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")));
                if (!found) return null;
                const value = Number.parseFloat(String(found[side] ?? "").replace(",", "."));
                return Number.isFinite(value) ? value : null;
              };
              const homeName = event.competitions?.[0]?.competitors?.find(team => team.homeAway === "home")?.team?.displayName || "";
              const awayName = event.competitions?.[0]?.competitors?.find(team => team.homeAway === "away")?.team?.displayName || "";
              const values = [
                { team: homeName, homeAway: "home", shots: readStat("home", ["total_shots","shots","total_attempts","total_shots_attempted"]), shotsOnTarget: readStat("home", ["shots_on_target","shots_on_goal","shots_on_target_total","on_target"]), shotsOffTarget: readStat("home", ["shots_off_target","shots_off_goal","shots_wide","off_target","shots_off_target_total"]), blockedShots: readStat("home", ["blocked_shots","shots_blocked","blocked_attempts"]), corners: readStat("home", ["corners","corner_kicks","won_corners","corner_kicks_total"]), attacks: readStat("home", ["attacks","total_attacks","attacks_for"]), dangerousAttacks: readStat("home", ["dangerous_attacks","dangerous_attacks_for","dangerous_attacks_created"]), possession: readStat("home", ["possession","possession_percentage","possession_pct","ball_possession"]), xG: readStat("home", ["expected_goals","expected_goals_xg","xg","expected_goals_for"]) },
                { team: awayName, homeAway: "away", shots: readStat("away", ["total_shots","shots","total_attempts","total_shots_attempted"]), shotsOnTarget: readStat("away", ["shots_on_target","shots_on_goal","shots_on_target_total","on_target"]), shotsOffTarget: readStat("away", ["shots_off_target","shots_off_goal","shots_wide","off_target","shots_off_target_total"]), blockedShots: readStat("away", ["blocked_shots","shots_blocked","blocked_attempts"]), corners: readStat("away", ["corners","corner_kicks","won_corners","corner_kicks_total"]), attacks: readStat("away", ["attacks","total_attacks","attacks_for"]), dangerousAttacks: readStat("away", ["dangerous_attacks","dangerous_attacks_for","dangerous_attacks_created"]), possession: readStat("away", ["possession","possession_percentage","possession_pct","ball_possession"]), xG: readStat("away", ["expected_goals","expected_goals_xg","xg","expected_goals_for"]) }
              ];
              matches.push({
                eventId: String(event.id), home: homeName, away: awayName,
                minute: event.status?.displayClock || "",
                statsAvailable: values.some(value => ["shots","shotsOnTarget","corners","possession","xG"].some(key => value[key] !== null)),
                teams: values
              });
              continue;
            }
            const response = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/" + item.leagueCode + "/summary?event=" + encodeURIComponent(event.id), {
              headers: { "Accept": "application/json" },
              signal: AbortSignal.timeout(8000)
            });
            if (!response.ok) continue;
            const summary = await response.json();
            const teams = summary?.boxscore?.teams || [];
            const values = teams.map(team => {
              const stats = team.statistics || [];
              const get = (...names) => {
                const normalizedNames = names.map(name => String(name).toLowerCase().replace(/[^a-z]/g, ""));
                const found = stats.find(stat => { const statNames = [stat.name, stat.abbreviation].filter(Boolean).map(value => String(value).toLowerCase().replace(/[^a-z]/g, "")); return normalizedNames.some(name => statNames.includes(name)); });
                if (!found) return null;
                const n = Number(String(found.displayValue ?? found.value ?? "").replace("%", ""));
                return Number.isFinite(n) ? n : null;
              };
              return {
                team: team.team?.displayName || team.team?.name || "",
                homeAway: team.homeAway || team.team?.homeAway || "",
                shots: get("totalshots", "shots", "shotsattempted"),
                shotsOnTarget: get("shotsontarget", "shotsongoal", "sog"),
                shotsOffTarget: get("shotsofftarget", "shotsOffGoal", "offtargetshots", "shotswide"),
                blockedShots: get("blockedshots", "shotsblocked"),
                corners: get("woncorners", "cornerkicks", "corners"),
                attacks: get("attacks", "totalattacks", "attacksfor", "totalattacksfor"),
                dangerousAttacks: get("dangerousattacks", "dangerousattacksfor", "dangerousattackscreated", "dangerousattackswon"),
                possession: get("possessionpct", "possession"),
                xG: get("expectedgoals", "xg", "expectedgoalsfor")
              };
            });
            matches.push({
              eventId: String(event.id),
              home: event.competitions?.[0]?.competitors?.find(t => t.homeAway === "home")?.team?.displayName || "",
              away: event.competitions?.[0]?.competitors?.find(t => t.homeAway === "away")?.team?.displayName || "",
              minute: event.status?.displayClock || event.competitions?.[0]?.status?.displayClock || "",
              statsAvailable: teams.length > 0 && values.some(v => ["shots", "shotsOnTarget", "shotsOffTarget", "blockedShots", "corners", "attacks", "dangerousAttacks", "possession", "xG"].some(key => v[key] !== null)),
              teams: values
            });
          } catch (error) {
            console.error("Live stats fetch failed:", JSON.stringify({ eventId: String(event.id || ""), leagueCode: item.leagueCode, provider: String(event.id || "").startsWith("m_") ? "PitchAPI" : "ESPN", error: error.message || "unknown error" }));
          }
        }
      });
      await Promise.all(workers);
      const isSportScoreEvent = value => String(value || "").startsWith("sportscore:") || String(value || "").startsWith("sportscore-widget:");
      if (work.some(item => isSportScoreEvent(item.event.id))) {
        console.log("SportScore live metrics detail diagnostic:", JSON.stringify({
          attempted: work.filter(item => isSportScoreEvent(item.event.id)).length,
          ...sportScoreDetailDiagnostics,
          statsAvailable: matches.filter(match => isSportScoreEvent(match.eventId) && match.statsAvailable).length
        }));
      }
      const persisted = await persistRollingTrends(matches, date);
      if (!persisted) addRollingTrends(matches);
      const hasPersistableSamples = matches.some(match => Array.isArray(match.teams) && match.teams.some(team =>
        team.team && ["shots", "shotsOnTarget", "corners", "attacks", "dangerousAttacks"]
          .some(key => team[key] != null && Number.isFinite(Number(team[key])))
      ));
      const trendHistory = !persisted ? "in-memory fallback; resets on service restart" : hasPersistableSamples ? "postgresql; retained across service restarts" : "PostgreSQL ready; waiting for real live-stat samples";
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
console.log("Push scanner configuration:", JSON.stringify({ enabled: Boolean(PUSH_SCAN_TOKEN && process.env.PUSH_SCAN_INTERVAL_ENABLED === "true"), pushConfigured: Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY), databaseConfigured: Boolean(analyticsPool), databaseHost: analyticsDatabaseHost, databaseUrlShape, databaseCredentialEnvKeys: Object.keys(process.env).filter(key => /^(DATABASE|POSTGRES|PGHOST|PGUSER|PGDATABASE|PGPASSWORD)/i.test(key)) }));
if (PUSH_SCAN_TOKEN && process.env.PUSH_SCAN_INTERVAL_ENABLED === "true") {
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
        deliveries: Number(result.deliveries || 0), subscribers: Number(result.subscribers || 0), date: result.date || null
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
          date: result.date || null
        }));
      }
    } catch (error) {
      console.error("Scheduled push scan request failed:", error.message);
    }
  }, 60000);
  backgroundScanTimer.unref();
}
server.listen(PORT, "0.0.0.0", () => console.log("Goal Pulse listening on " + PORT));