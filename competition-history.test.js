"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createLimiter, isHistoryLeagueSupported, fetchCompetitionHistoryWindow, formatEspnMonth } = require("./competition-history");

test("history endpoint only accepts ESPN-backed competition codes", () => {
  const supported = ["eng.1", "gre.1"];
  assert.equal(isHistoryLeagueSupported("eng.1", supported), true);
  assert.equal(isHistoryLeagueSupported("sportscore.mongolia-premier", supported), false);
  assert.equal(isHistoryLeagueSupported("unknown.1", supported), false);
});

test("history window falls back when the primary host fails at network level", async () => {
  const calls = [];
  const events = [{ id: "fixture-1" }];
  const result = await fetchCompetitionHistoryWindow({
    endpoint: "https://primary.example/scoreboard",
    fallbackEndpoint: "https://fallback.example/scoreboard",
    fetchImpl: async url => {
      calls.push(url);
      if (url.includes("primary")) throw new Error("network timeout");
      return { ok: true, json: async () => ({ events }) };
    }
  });
  assert.deepEqual(calls, ["https://primary.example/scoreboard", "https://fallback.example/scoreboard"]);
  assert.deepEqual(result, events);
});

test("history window falls back after ESPN throttles the primary host", async () => {
  const calls = [];
  const result = await fetchCompetitionHistoryWindow({
    endpoint: "https://primary.example/scoreboard",
    fallbackEndpoint: "https://fallback.example/scoreboard",
    fetchImpl: async url => {
      calls.push(url);
      return url.includes("primary")
        ? { ok: false, status: 429 }
        : { ok: true, json: async () => ({ events: [{ id: "fixture-2" }] }) };
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(result[0].id, "fixture-2");
});

test("history window reports the provider error when both hosts fail", async () => {
  await assert.rejects(
    fetchCompetitionHistoryWindow({
      endpoint: "https://primary.example/scoreboard",
      fallbackEndpoint: "https://fallback.example/scoreboard",
      fetchImpl: async () => ({ ok: false, status: 503 })
    }),
    /HTTP 503/
  );
});

test("history window retries the fallback hostname after HTTP 400", async () => {
  const calls = [];
  const result = await fetchCompetitionHistoryWindow({
    endpoint: "https://primary.example/scoreboard",
    fallbackEndpoint: "https://fallback.example/scoreboard",
    fetchImpl: async url => {
      calls.push(url);
      return url.includes("primary")
        ? { ok: false, status: 400 }
        : { ok: true, json: async () => ({ events: [{ id: "fallback-after-400" }] }) };
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(result[0].id, "fallback-after-400");
});

test("history window preserves both host errors for diagnosis", async () => {
  await assert.rejects(
    fetchCompetitionHistoryWindow({
      endpoint: "https://primary.example/scoreboard",
      fallbackEndpoint: "https://fallback.example/scoreboard",
      fetchImpl: async url => ({ ok: false, status: url.includes("primary") ? 400 : 503 })
    }),
    error => /primary HTTP 400/.test(error.message) && /fallback HTTP 503/.test(error.message)
  );
});

test("history request limiter never exceeds its configured concurrency", async () => {
  const limit = createLimiter(2);
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 9 }, (_, index) => limit(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return index;
  }));
  const result = await Promise.all(tasks);
  assert.equal(peak, 2);
  assert.deepEqual(result, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test("ESPN history month selector uses YYYYMM in UTC", () => {
  assert.equal(formatEspnMonth(new Date("2026-08-01T00:00:00.000Z")), "202608");
  assert.equal(formatEspnMonth(new Date("2027-01-31T23:59:59.000Z")), "202701");
  assert.throws(() => formatEspnMonth("not-a-date"), /valid date/);
});
