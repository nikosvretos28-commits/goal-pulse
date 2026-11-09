"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCompetitionHistoryStore } = require("../competition-history-store");

function createFakePool() {
  const rows = new Map();
  return {
    rows,
    async query(sql, params = []) {
      if (sql.includes("CREATE TABLE")) return { rowCount: 0, rows: [] };
      if (sql.includes("INSERT INTO competition_history_cache")) {
        const key = params[0] + ":" + params[1];
        const existing = rows.get(key);
        const incomingPartial = params[3] === true;
        if (!existing || existing.isPartial || !incomingPartial) {
          rows.set(key, {
            body: JSON.parse(params[2]),
            isPartial: incomingPartial,
            fetchedAt: new Date("2026-11-09T10:00:00.000Z")
          });
          return { rowCount: 1, rows: [{ league_code: params[0] }] };
        }
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("SELECT body, fetched_at")) {
        const row = rows.get(params[0] + ":" + params[1]);
        return { rowCount: row ? 1 : 0, rows: row ? [{ body: row.body, fetched_at: row.fetchedAt }] : [] };
      }
      throw new Error("Unexpected SQL in fake pool");
    }
  };
}

test("verified history survives store recreation through the persistent database", async () => {
  const pool = createFakePool();
  const firstInstance = createCompetitionHistoryStore({ pool });
  const body = { league: "eng.1", season: 2026, matches: [{ id: "1" }], partial: false };
  assert.equal(await firstInstance.save("eng.1", 2026, body), true);

  const afterRestart = createCompetitionHistoryStore({ pool });
  const restored = await afterRestart.load("eng.1", 2026);
  assert.deepEqual(restored.body, body);
  assert.equal(restored.fetchedAt, "2026-11-09T10:00:00.000Z");
});

test("empty history is never persisted and partial data cannot replace a complete season", async () => {
  const pool = createFakePool();
  const store = createCompetitionHistoryStore({ pool });
  assert.equal(await store.save("eng.1", 2026, { matches: [] }), false);

  const complete = { matches: [{ id: "complete" }], partial: false, successfulWindows: 12, totalWindows: 12 };
  const partial = { matches: [{ id: "partial" }], partial: true, successfulWindows: 4, totalWindows: 12 };
  assert.equal(await store.save("eng.1", 2026, complete), true);
  assert.equal(await store.save("eng.1", 2026, partial), false);
  assert.deepEqual((await store.load("eng.1", 2026)).body, complete);
});

test("a partial season can be saved when no complete season exists", async () => {
  const pool = createFakePool();
  const store = createCompetitionHistoryStore({ pool });
  const partial = { matches: [{ id: "partial" }], partial: true, successfulWindows: 4, totalWindows: 12 };
  assert.equal(await store.save("fra.1", 2026, partial), true);
  assert.deepEqual((await store.load("fra.1", 2026)).body, partial);
});

test("store safely degrades when PostgreSQL is not configured", async () => {
  const store = createCompetitionHistoryStore();
  assert.equal(await store.save("eng.1", 2026, { matches: [{ id: "1" }] }), false);
  assert.equal(await store.load("eng.1", 2026), null);
});
