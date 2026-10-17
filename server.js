const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const API_BASE = "https://api.pitchapi.dev";
const cache = new Map();
const pitchInflight = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const SCOREBOARD_TTL_MS = 45 * 1000;
const SCOREBOARD_STALE_TTL_MS = 15 * 1000;
const SCOREBOARD_LEAGUES = [
  "eng.1", "esp.1", "ita.1", "ger.1", "fra.1", "por.1",
  "ned.1", "sco.1", "gre.1", "tur.1", "bra.1", "arg.1",
  "usa.1", "mex.1", "aus.1", "uefa.champions", "uefa.europa",
  "uefa.europa.conf"
];
const scoreboardCache = new Map();
const scoreboardInflight = new Map();


function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
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
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, "http://localhost");
  if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });

  if (url.pathname === "/api/health") {
    return send(res, 200, { ok: true, pitchApiConfigured: Boolean(process.env.PITCH_API_KEY) });
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
              if (!response.ok) return { code, events: [], ok: false };
              const body = await response.json();
              return { code, events: Array.isArray(body.events) ? body.events : [], ok: true };
            } catch {
              return { code, events: [], ok: false };
            }
          }));
          const successfulFeeds = feeds.filter(feed => feed.ok).length;
          const body = { date, successfulFeeds, totalFeeds: SCOREBOARD_LEAGUES.length, feeds: feeds.map(({code,events,ok}) => ({code,events,ok})) };
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
      const scoreboard = scoreboardCache.get(date);
      if (!scoreboard || !Array.isArray(scoreboard.body?.feeds)) {
        return send(res, 503, { error: "Scoreboard not loaded yet", matches: [] });
      }
      const liveEvents = scoreboard.body.feeds.flatMap(feed => (feed.events || [])
        .filter(event => (event.status?.type?.state || event.competitions?.[0]?.status?.type?.state) === "in")
        .map(event => ({ event, leagueCode: feed.code })));
      const work = liveEvents.slice(0, 24);
      let cursor = 0;
      const matches = [];
      const workers = Array.from({ length: Math.min(8, work.length) }, async () => {
        while (cursor < work.length) {
          const item = work[cursor++];
          const event = item.event;
          try {
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
                shots: get("totalshots", "shots", "shotsattempted"),
                shotsOnTarget: get("shotsontarget", "shotsongoal", "sog"),
                shotsOffTarget: get("shotsofftarget", "shotsOffGoal", "offtargetshots", "shotswide"),
                corners: get("woncorners", "cornerkicks", "corners"),
                possession: get("possessionpct", "possession"),
                dangerousAttacks: get("dangerousattacks")
              };
            });
            matches.push({
              eventId: String(event.id),
              home: event.competitions?.[0]?.competitors?.find(t => t.homeAway === "home")?.team?.displayName || "",
              away: event.competitions?.[0]?.competitors?.find(t => t.homeAway === "away")?.team?.displayName || "",
              minute: event.status?.displayClock || event.competitions?.[0]?.status?.displayClock || "",
              statsAvailable: teams.length > 0 && values.some(v => v.shots !== null || v.shotsOnTarget !== null || v.corners !== null),
              teams: values
            });
          } catch {}
        }
      });
      await Promise.all(workers);
      const body = { date, checked: work.length, totalLive: liveEvents.length, matches, updatedAt: new Date().toISOString() };
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

server.listen(PORT, "0.0.0.0", () => console.log("Goal Pulse listening on " + PORT));
