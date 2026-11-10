"use strict";

function createLimiter(maxConcurrent = 4) {
  const limit = Math.max(1, Math.floor(Number(maxConcurrent) || 1));
  let active = 0;
  const queue = [];
  return async function run(task) {
    if (typeof task !== "function") throw new TypeError("A task function is required");
    if (active >= limit) await new Promise(resolve => queue.push(resolve));
    else active += 1;
    try {
      return await task();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

function isHistoryLeagueSupported(league, supportedLeagues) {
  if (typeof league !== "string" || league.startsWith("sportscore.")) return false;
  if (supportedLeagues instanceof Set) return supportedLeagues.has(league);
  return Array.isArray(supportedLeagues) && supportedLeagues.includes(league);
}

async function fetchCompetitionHistoryWindow({
  endpoint,
  fallbackEndpoint,
  headers = {},
  timeoutMs = 15000,
  fetchImpl = fetch
}) {
  const urls = [endpoint, fallbackEndpoint].filter(Boolean);
  const failures = [];
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    const hostRole = index === 0 ? "primary" : "fallback";
    try {
      const response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) {
        failures.push(hostRole + " HTTP " + response.status + " (" + url + ")");
        // A 400 can be host-specific (routing/edge validation). Try the
        // alternate ESPN hostname before declaring the entire window failed.
        continue;
      }
      const body = await response.json();
      return Array.isArray(body?.events) ? body.events : [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(hostRole + " network/timeout error (" + url + "): " + message);
    }
  }
  throw new Error("Competition history provider failed: " + failures.join("; "));
}

module.exports = { createLimiter, isHistoryLeagueSupported, fetchCompetitionHistoryWindow };
