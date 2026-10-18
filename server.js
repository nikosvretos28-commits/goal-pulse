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
      if (error.statusCode === 404 || error.statusCode === 410) {
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
async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20000) throw new Error("Request body too large");
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
const scoreboardCache = new Map();
const scoreboardInflight = new Map();
const liveHistory = new Map();
const LIVE_HISTORY_TTL_MS = 11 * 60 * 1000;
const analyticsPool = process.env.DATABASE_URL && Pool ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000
}) : null;
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

async function persistRollingTrends(matches, date) {
  if (!analyticsPool || !await ensureAnalyticsDb()) return false;
  try {
    const snapshots = [];
    for (const match of matches) for (const team of match.teams || []) {
      if (team.team) snapshots.push([String(match.eventId), date, String(team.team), team.shots, team.shotsOnTarget, team.corners, team.attacks, team.dangerousAttacks, String(match.minute || "")]);
    }
    if (!snapshots.length) return true;
    const values = [];
    const tuples = snapshots.map((row, index) => {
      const n = index * 9;
      values.push(...row);
      return `(${n+1}, ${n+2}, ${n+3}, NOW(), ${n+4}, ${n+5}, ${n+6}, ${n+7}, ${n+8}, ${n+9})`;
    });
    await analyticsPool.query(
      `INSERT INTO live_stat_snapshots
       (event_id, match_date, team_name, observed_at, shots, shots_on_target, corners, attacks, dangerous_attacks, minute)
       VALUES ${tuples.join(", ")}`, values
    );
    const eventIds = [...new Set(matches.map(match => String(match.eventId)).filter(Boolean))];
    const baselines = {};
    for (const minutes of [5, 10]) {
      const result = await analyticsPool.query(
        `SELECT DISTINCT ON (event_id, team_name)
           event_id, team_name, observed_at, shots, shots_on_target, corners, attacks, dangerous_attacks
         FROM live_stat_snapshots
         WHERE event_id = ANY($1::text[])
           AND observed_at <= NOW() - ($2::interval)
           AND observed_at >= NOW() - INTERVAL '11 minutes'
         ORDER BY event_id, team_name, observed_at DESC`,
        [eventIds, minutes + " minutes"]
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
          const delta = key => {
            const current = team[key];
            const old = previous?.[key];
            if (!previous || current == null || old == null || !Number.isFinite(Number(current)) || !Number.isFinite(Number(old))) return null;
            return Math.max(0, Number(current) - Number(old));
          };
          return { team: team.team, shots: delta("shots"), shotsOnTarget: delta("shots_on_target"), corners: delta("corners"), attacks: delta("attacks"), dangerousAttacks: delta("dangerous_attacks") };
        });
        return { available: teams.some(team => team.shots != null || team.shotsOnTarget != null || team.corners != null), sampleMinutes: minutes, teams };
      };
      match.trend = { source: "PostgreSQL-persisted cumulative-stat deltas", window5m: makeWindow(5), window10m: makeWindow(10) };
    }
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
  const candidates = leagues.filter(item => aliases.some(alias => normal(item.name) === alias || normal(item.name).includes(alias) || alias.includes(normal(item.name))));
  const country = code.split(".")[0];
  const countryCodes = {eng:"ENG",esp:"ESP",ita:"ITA",ger:"DEU",fra:"FRA",por:"PRT",ned:"NLD",sco:"SCO",gre:"GRC",tur:"TUR",bra:"BRA",arg:"ARG",usa:"USA",mex:"MEX",aus:"AUS",bel:"BEL",aut:"AUT",sui:"CHE",den:"DNK",nor:"NOR",swe:"SWE",pol:"POL",jpn:"JPN",kor:"KOR",sau:"SAU"};
  return candidates.find(item => item.country_code === countryCodes[country]) || candidates[0] || null;
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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, "http://localhost");
  if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { error: "Method not allowed" });

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
      const now = Date.now();
      let checked = 0, sent = 0, candidates = 0;
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
        const goalEvidence = onTarget >= 1 && shots >= 2;
        const points = onTarget * 4 + Math.min(shots, 4) + corners * 2 + Math.min(attacks * 0.25, 3) + Math.min(dangerous * 0.75, 5);
        const isAiGoal = goalEvidence && points >= 5;
        const isAiPressure = !isAiGoal && evidenceKinds >= 3 && points >= 7;
        const isVip = goalEvidence && corners >= 1 && evidenceKinds >= 3 && points >= 9;
        const levels = [];
        if (isAiGoal || isAiPressure) levels.push("AI");
        if (isVip) levels.push("VIP");
        for (const level of levels) {
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
            body: ((match.home || "Γηπεδούχος") + " – " + (match.away || "Φιλοξενούμενος") + " · " + (match.minute || "LIVE") + " · " + (isAiGoal ? "Ένδειξη πιθανού γκολ" : "Αυξημένη επιθετική πίεση") + " · " + reason).slice(0, 180),
            tag: "goal-pulse-bg-" + level.toLowerCase() + "-" + id,
            url: "/"
          });
          if (result.sent > 0) {
            pushScanLastAlert.set(cooldownKey, now);
            sent += result.sent;
          }
          candidates++;
        }
      }
      for (const [id, item] of pushScanSnapshots) if (now - item.at > 15 * 60 * 1000) pushScanSnapshots.delete(id);
      const liveMatches = Number(metrics.totalLive || 0);
      const statsMatches = (metrics.matches || []).filter(match => match.statsAvailable).length;
      return send(res, 200, { ok: true, liveMatches, statsMatches, checked, candidates, deliveries: sent, date, pushConfigured: Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) });
    } catch (error) {
      console.error("Background push scan failed:", error.message);
      return send(res, 503, { error: "Background scan failed", detail: error.message });
    }
  }

  if (url.pathname === "/api/health") {
    return send(res, 200, { ok: true, pitchApiConfigured: Boolean(process.env.PITCH_API_KEY), persistentAnalyticsConfigured: Boolean(analyticsPool) });
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
    const validDate = value => /^\\d{8}$/.test(value) && !Number.isNaN(Date.parse(value.slice(0,4)+"-"+value.slice(4,6)+"-"+value.slice(6,8)+"T00:00:00Z"));
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
          const feeds = await Promise.all(SCOREBOARD_LEAGUES.map(async code => {
            try {
              const response = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/" + code + "/scoreboard?dates=" + date, {
                headers: { "Accept": "application/json" },
                signal: AbortSignal.timeout(10000)
              });
              if (!response.ok) return { code, events: [], ok: false, error: "HTTP " + response.status };
              const body = await response.json();
              return { code, events: Array.isArray(body.events) ? body.events : [], ok: true };
            } catch (error) {
              return { code, events: [], ok: false, error: error.message || "request failed" };
            }
          }));
          let finalFeeds = feeds;
          let successfulFeeds = feeds.filter(feed => feed.ok).length;
          if (successfulFeeds === 0) {
            // ESPN blocks requests from this deployment; use the configured PitchAPI source.
            try {
              const isoDate = date.slice(0,4) + "-" + date.slice(4,6) + "-" + date.slice(6,8);
              const directory = (await pitchGet("/v1/leagues"))?.data?.leagues || [];
              const normal = value => String(value || "").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
              const countryCodes = {eng:"ENG",esp:"ESP",ita:"ITA",ger:"DEU",fra:"FRA",por:"PRT",ned:"NLD",sco:"SCO",gre:"GRC",tur:"TUR",bra:"BRA",arg:"ARG",usa:"USA",mex:"MEX",aus:"AUS",bel:"BEL",aut:"AUT",sui:"CHE",den:"DNK",nor:"NOR",swe:"SWE",pol:"POL",jpn:"JPN",kor:"KOR",sau:"SAU"};
              const idToCode = new Map();
              for (const code of SCOREBOARD_LEAGUES) {
                const aliases = pitchLeagueAliases(code).map(normal);
                if (!aliases.length) continue;
                const candidates = directory.filter(item => aliases.some(alias => normal(item.name) === alias || normal(item.name).includes(alias) || alias.includes(normal(item.name))));
                const chosen = candidates.find(item => item.country_code === countryCodes[code.split(".")[0]]) || candidates[0];
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
                  const candidates = SCOREBOARD_LEAGUES.filter(candidate => (aliasesByCode.get(candidate) || []).some(alias => matchLeagueName === alias || matchLeagueName.includes(alias) || alias.includes(matchLeagueName)));
                  code = candidates.find(candidate => {
                    const expectedCountry = countryCodes[candidate.split(".")[0]];
                    return !expectedCountry || !matchCountry || matchCountry === expectedCountry || matchCountry.includes(expectedCountry);
                  }) || candidates[0];
                }
                if (!code) continue;
                const statusText = String(match.status || "").toLowerCase();
                const state = /live|in.?play|first.?half|second.?half|half.?time|extra.?time|penalt/.test(statusText) ? "in" : /finished|full.?time/.test(statusText) ? "post" : "pre";
                const status = { type: { state, completed: state === "post" }, displayClock: match.minute != null ? String(match.minute) + "'" : String(match.status || "") };
                const homeName = match.home_team?.name || "";
                const awayName = match.away_team?.name || "";
                const event = {
                  id: String(match.id || ""), date: match.time_utc || match.date || "",
                  name: homeName + " vs " + awayName, status,
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
                finalFeeds = SCOREBOARD_LEAGUES.map(code => ({ code, events: byCode.get(code) || [], ok: true }));
                successfulFeeds = finalFeeds.length;
                const mappedMatches = [...byCode.values()].reduce((n, list) => n + list.length, 0);
                console.log("Scoreboard using PitchAPI:", JSON.stringify({ date, sourceMatches: sourceMatches.length, mappedMatches, sample: mappedMatches ? undefined : sourceMatches.slice(0, 3).map(match => ({ league: match.league?.name, country: match.league?.country_code || match.league?.country, hasHome: Boolean(match.home_team?.name), hasAway: Boolean(match.away_team?.name), keys: Object.keys(match || {}) })) }));
              }
            } catch (error) {
              console.error("PitchAPI scoreboard fallback failed:", error.message);
            }
          }
          if (successfulFeeds === 0) {
            console.error("All scoreboard feeds failed:", JSON.stringify(feeds.slice(0, 6).map(feed => ({ code: feed.code, error: feed.error || "unknown" }))));
          }
          const body = { date, successfulFeeds, totalFeeds: SCOREBOARD_LEAGUES.length, feeds: finalFeeds.map(({code,events,ok}) => ({code,events,ok})), source: feeds.some(feed => feed.ok) ? "ESPN" : (successfulFeeds ? "PitchAPI" : "unavailable") };
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
      const work = liveEvents.slice(0, 36);
      let cursor = 0;
      const matches = [];
      const workers = Array.from({ length: Math.min(8, work.length) }, async () => {
        while (cursor < work.length) {
          const item = work[cursor++];
          const event = item.event;
          try {
            if (String(event.id).startsWith("m_")) {
              const pitchStats = await pitchGet("/v1/matches/" + encodeURIComponent(event.id) + "/stats");
              const groups = (pitchStats?.data?.periods || []).filter(period => !period.period || String(period.period).trim().toLowerCase() === "all").flatMap(period => period.groups || []);
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
                { team: homeName, homeAway: "home", shots: readStat("home", ["total_shots","shots","total_attempts"]), shotsOnTarget: readStat("home", ["shots_on_target","shots_on_goal"]), shotsOffTarget: null, blockedShots: null, corners: readStat("home", ["corners","corner_kicks"]), attacks: null, dangerousAttacks: null, possession: readStat("home", ["possession","possession_percentage"]), xG: readStat("home", ["expected_goals","xg"]) },
                { team: awayName, homeAway: "away", shots: readStat("away", ["total_shots","shots","total_attempts"]), shotsOnTarget: readStat("away", ["shots_on_target","shots_on_goal"]), shotsOffTarget: null, blockedShots: null, corners: readStat("away", ["corners","corner_kicks"]), attacks: null, dangerousAttacks: null, possession: readStat("away", ["possession","possession_percentage"]), xG: readStat("away", ["expected_goals","xg"]) }
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
          } catch {}
        }
      });
      await Promise.all(workers);
      const persisted = await persistRollingTrends(matches, date);
      if (!persisted) addRollingTrends(matches);
      const body = { date, checked: work.length, totalLive: liveEvents.length, matches, updatedAt: new Date().toISOString(), trendHistory: persisted ? "postgresql; retained across service restarts" : "in-memory fallback; resets on service restart" };
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

console.log("Push scanner configuration:", JSON.stringify({ enabled: Boolean(PUSH_SCAN_TOKEN && process.env.PUSH_SCAN_INTERVAL_ENABLED === "true"), pushConfigured: Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY), databaseConfigured: Boolean(analyticsPool) }));
if (PUSH_SCAN_TOKEN && process.env.PUSH_SCAN_INTERVAL_ENABLED === "true") {
  console.log("Background push scanner scheduled every 60 seconds.");
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
