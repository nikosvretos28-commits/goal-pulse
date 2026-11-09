"use strict";

function createLimiter(maxConcurrent = 4) {
  const limit = Math.max(1, Math.floor(Number(maxConcurrent) || 1));
  let active = 0;
  const queue = [];
  return async function run(task) {
    if (typeof task !== "function") throw new TypeError("A task function is required");
    if (active >= limit) await new Promise(resolve => queue.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      const next = queue.shift();
      if (next) next();
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
  let lastError = new Error("Competition history provider unavailable");
  const urls = [endpoint, fallbackEndpoint].filter(Boolean);
  for (let index = 0; index < urls.length; index += 1) {
    try {
      const response = await fetchImpl(urls[index], {
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) {
        lastError = new Error("Competition history provider unavailable (HTTP " + response.status + ")");
        // A malformed request will fail identically on the alternate hostname.
        if (response.status === 400) break;
        continue;
      }
      const body = await response.json();
      return Array.isArray(body?.events) ? body.events : [];
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError;
}

module.exports = { createLimiter, isHistoryLeagueSupported, fetchCompetitionHistoryWindow };
