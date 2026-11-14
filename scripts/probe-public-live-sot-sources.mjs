#!/usr/bin/env node
/**
 * Diagnostic-only probe for public live football SOT sources.
 *
 * This script is intentionally isolated: it is not imported by server.js,
 * does not write to the database/cache, and cannot affect alert protocols.
 * Run with: node scripts/probe-public-live-sot-sources.mjs
 *
 * No API keys or additional npm packages are required.
 */

const TIMEOUT_MS = 10000;
const MAX_EVENTS_TO_CHECK = 5;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

async function get(url, extraHeaders = {}) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json, text/plain, */*",
      "cache-control": "no-cache",
      ...extraHeaders
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const body = await response.text();
  return { status: response.status, ok: response.ok, body };
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function exactSot(statsPayload) {
  const groups = Array.isArray(statsPayload?.statistics?.groups)
    ? statsPayload.statistics.groups
    : [];
  for (const group of groups) {
    const rows = Array.isArray(group?.statistics) ? group.statistics : [];
    for (const row of rows) {
      const label = String(row?.name || "").trim().toLowerCase();
      if (label === "shots on target") {
        return {
          home: row.home ?? null,
          away: row.away ?? null
        };
      }
    }
  }
  return null;
}

async function probeSofaScore() {
  const result = {
    provider: "SofaScore",
    endpoint: "https://www.sofascore.com/api/v1/sport/football/events/live",
    liveEndpointStatus: null,
    liveEventsFound: 0,
    eventsCheckedForStats: 0,
    eventsWithExactSot: [],
    error: null
  };

  try {
    const live = await get(result.endpoint, {
      referer: "https://www.sofascore.com/"
    });
    result.liveEndpointStatus = live.status;
    if (!live.ok) {
      result.error = "Live endpoint did not return HTTP success.";
      return result;
    }

    const payload = parseJson(live.body);
    const events = Array.isArray(payload?.events) ? payload.events : [];
    result.liveEventsFound = events.length;

    for (const event of events.slice(0, MAX_EVENTS_TO_CHECK)) {
      const id = event?.id;
      if (id == null) continue;
      result.eventsCheckedForStats += 1;

      try {
        const statsResponse = await get(
          `https://www.sofascore.com/api/v1/event/${encodeURIComponent(id)}/statistics`,
          { referer: `https://www.sofascore.com/event/${id}` }
        );
        if (!statsResponse.ok) continue;

        const stats = parseJson(statsResponse.body);
        const sot = exactSot(stats);
        if (sot) {
          result.eventsWithExactSot.push({
            eventId: id,
            home: event?.homeTeam?.name || null,
            away: event?.awayTeam?.name || null,
            homeSot: sot.home,
            awaySot: sot.away
          });
        }
      } catch {
        // Continue probing other live events; this is diagnostic-only.
      }
    }
  } catch (error) {
    result.error = String(error?.message || error);
  }

  return result;
}

async function probeFlashscoreWebAccess() {
  const result = {
    provider: "Flashscore",
    page: "https://www.flashscore.com/",
    pageStatus: null,
    sotFeedVerified: false,
    limitation:
      "Homepage access alone does not verify live SOT data. The internal feed requires " +
      "a changing X-Fsign signature and browser-like TLS behavior; this Node fetch probe " +
      "does not bypass those protections or claim a working feed.",
    error: null
  };

  try {
    const response = await get(result.page, {
      accept: "text/html,application/xhtml+xml"
    });
    result.pageStatus = response.status;
  } catch (error) {
    result.error = String(error?.message || error);
  }

  return result;
}

const results = await Promise.all([
  probeSofaScore(),
  probeFlashscoreWebAccess()
]);

console.log(JSON.stringify({
  diagnosticOnly: true,
  productionChanged: false,
  alertProtocolsChanged: false,
  checkedAt: new Date().toISOString(),
  results
}, null, 2));
