"use strict";

const { evaluateCloudAlert } = require("./cloud-alert-evaluator");

const DEFAULT_INTERVAL_MS = 60_000;
const MAX_FEED_AGE_MS = 120_000;

function athensDateKey(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Athens", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return values.year + values.month + values.day;
}

function numericMinute(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  const match = raw.match(/^(\d{1,3})(?:\s*\+\s*(\d{1,2}))?/);
  if (!match) return null;
  const minute = Number(match[1]) + Number(match[2] || 0);
  return Number.isInteger(minute) && minute > 0 ? minute : null;
}

function matchPeriod(match, minute) {
  const status = [match?.statusText, match?.status_text, match?.status]
    .filter(value => value != null && typeof value !== "object")
    .join(" ").toLowerCase();
  if (/extra.?time|penalt|shoot.?out|\bet\b|\bpens?\b/.test(status)) return null;
  if (/\bht\b|half.?time|halftime|ανάπαυλα/.test(status)) return null;
  if (/\b(ft|full.?time|finished|ended|final|postponed|cancelled|canceled|abandoned|suspended)\b/.test(status)) return null;
  if (/second.?half|2nd.?half|δεύτερο.?ημίχρονο|2ο.?ημίχρονο|\b2h\b/.test(status)) return "2H";
  if (/first.?half|1st.?half|πρώτο.?ημίχρονο|1ο.?ημίχρονο|\b1h\b/.test(status)) return "1H";
  // Minute alone cannot distinguish first-half stoppage time (45+N) from
  // second-half play. Fail closed above 45' unless the feed supplies phase.
  if (minute != null && minute <= 45) return "1H";
  return null;
}

function getTeamSot(match) {
  if (!Array.isArray(match?.teams) || match.teams.length < 2) return null;
  const home = match.teams.find(team => team?.homeAway === "home") || match.teams[0];
  const away = match.teams.find(team => team?.homeAway === "away") || match.teams[1];
  const values = [home?.shotsOnTarget, away?.shotsOnTarget];
  if (values.some(value => value == null || !Number.isInteger(Number(value)) || Number(value) < 0)) return null;
  return { home: Number(values[0]), away: Number(values[1]) };
}

function getRecentSot10(match) {
  const window = match?.trend?.window10m;
  if (window?.available !== true) return null;
  const sampleMinutes = Number(window.sampleMinutes);
  if (!Number.isFinite(sampleMinutes) || sampleMinutes < 9 || sampleMinutes > 11.5) return null;
  if (!Array.isArray(window.teams) || window.teams.length < 2) return null;
  const values = window.teams.slice(0, 2).map(team => team?.shotsOnTarget);
  if (values.some(value => value == null || !Number.isInteger(Number(value)) || Number(value) < 0)) return null;
  return Number(values[0]) + Number(values[1]);
}

function createCloudAlertScanner({
  baseUrl,
  runtime,
  settlement = null,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  intervalMs = DEFAULT_INTERVAL_MS,
  logger = console
}) {
  if (!baseUrl || !runtime || typeof fetchImpl !== "function") {
    throw new TypeError("baseUrl, runtime and fetchImpl are required");
  }
  const confirmations = new Map();
  let interval = null;
  let startupTimeout = null;
  let inFlight = null;

  function confirmSnapshot(matchId, period, homeSot, awaySot, at) {
    const key = String(matchId) + "|" + period;
    const previous = confirmations.get(key);
    confirmations.set(key, { homeSot, awaySot, at });
    if (!previous || at - previous.at < 10_000 || at - previous.at > 90_000) {
      return { confirmed: false, reason: "awaiting_second_independent_sample" };
    }
    if (homeSot < previous.homeSot || awaySot < previous.awaySot) {
      return { confirmed: false, reason: "cumulative_sot_regression" };
    }
    return { confirmed: true, reason: "two_monotonic_samples" };
  }

  async function runOnce() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const startedAt = now();
      const date = athensDateKey(startedAt);
      const response = await fetchImpl(baseUrl.replace(/\/$/, "") + "/api/live-metrics?date=" + date + "&scope=cloud-alert", {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(25_000)
      });
      if (!response.ok) throw new Error("live metrics returned HTTP " + response.status);
      const body = await response.json();
      let settlementSummary = null;
      if (settlement && typeof settlement.reconcileScoreboard === "function") {
        try {
          const scoreboardResponse = await fetchImpl(baseUrl.replace(/\/$/, "") + "/api/scoreboard?date=" + date, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(25_000)
          });
          if (scoreboardResponse.ok) {
            settlementSummary = await settlement.reconcileScoreboard(await scoreboardResponse.json(), now);
          } else {
            logger.warn?.("[Cloud Alert settlement] scoreboard unavailable:", scoreboardResponse.status);
          }
        } catch (error) {
          logger.warn?.("[Cloud Alert settlement] reconciliation deferred:", String(error.message || error).slice(0, 180));
        }
      }
      const feedAt = Date.parse(body?.updatedAt || "");
      if (!Number.isFinite(feedAt) || startedAt - feedAt > MAX_FEED_AGE_MS || feedAt > startedAt + 10_000) {
        return { ok: false, reason: "stale_or_unstamped_live_metrics", checked: 0, qualified: 0 };
      }

      let checked = 0, qualified = 0, held = 0;
      for (const match of Array.isArray(body.matches) ? body.matches : []) {
        const matchId = String(match?.eventId || "");
        const minute = numericMinute(match?.minute);
        const period = matchPeriod(match, minute);
        const sot = getTeamSot(match);
        const source = String(match?.statsSource || "").trim();
        if (!matchId || !period || !sot || match.statsAvailable !== true || !source) {
          held++;
          continue;
        }
        checked++;
        const at = now();
        const confirmation = confirmSnapshot(matchId, period, sot.home, sot.away, at);
        const r6 = await runtime.recordSnapshot({
          matchId, period, homeSot: sot.home, awaySot: sot.away
        });
        const r10 = getRecentSot10(match);
        const rollingWindowsValid = Boolean(r6?.valid || r10 != null);
        const result = evaluateCloudAlert({
          matchId,
          period,
          elapsedMinute: minute,
          homeSot: sot.home,
          awaySot: sot.away,
          recentSot6: r6?.valid ? r6.value : null,
          recentSot10: r10,
          dataQuality: "valid",
          confirmed: confirmation.confirmed,
          rollingWindowsValid
        });
        if (result.status !== "qualified") {
          if (result.status === "held") held++;
          continue;
        }

        const saved = await runtime.recordShadowCandidate({
          matchId,
          period,
          triggers: result.triggers,
          minute,
          home: match.home,
          away: match.away,
          homeSot: sot.home,
          awaySot: sot.away,
          recentSot6: r6?.valid ? r6.value : null,
          recentSot10: r10,
          scoreHome: Number.isInteger(match.homeScore) ? match.homeScore : null,
          scoreAway: Number.isInteger(match.awayScore) ? match.awayScore : null,
          metrics: result.metrics,
          confirmation: confirmation.reason,
          statsSource: source
        });
        if (saved?.saved) qualified++;
      }
      const summary = { ok: true, checked, qualified, held, date, settlement: settlementSummary, mode: "shadow-only-no-push" };
      logger.info?.("[Cloud Alert scanner] independent cycle:", JSON.stringify(summary));
      return summary;
    })();
    try {
      return await inFlight;
    } catch (error) {
      logger.warn?.("[Cloud Alert scanner] cycle failed closed:", String(error.message || error).slice(0, 180));
      return { ok: false, reason: String(error.message || error).slice(0, 180), checked: 0, qualified: 0 };
    } finally {
      inFlight = null;
    }
  }

  function start() {
    if (interval || process.env.CLOUD_ALERT_SCANNER_ENABLED === "false") return false;
    startupTimeout = setTimeout(() => { void runOnce(); }, 5_000);
    startupTimeout.unref?.();
    interval = setInterval(() => { void runOnce(); }, intervalMs);
    interval.unref?.();
    logger.info?.("[Cloud Alert scanner] independent shadow scanner scheduled:", intervalMs + "ms; push delivery disabled");
    return true;
  }

  function stop() {
    if (startupTimeout) clearTimeout(startupTimeout);
    if (interval) clearInterval(interval);
    startupTimeout = null;
    interval = null;
  }

  return { runOnce, start, stop };
}

module.exports = {
  createCloudAlertScanner,
  athensDateKey,
  numericMinute,
  matchPeriod,
  getTeamSot,
  getRecentSot10
};
