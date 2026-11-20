"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSharedLiveMetricsCoordinator } = require("./shared-live-metrics-coordinator");

test("concurrent scanner scopes share one live snapshot", async () => {
  const coordinator = createSharedLiveMetricsCoordinator({ ttlMs: 15000 });
  const leader = await coordinator.acquire("2026-11-20");
  assert.equal(leader.role, "leader");

  const followers = Promise.all([
    coordinator.acquire("2026-11-20"),
    coordinator.acquire("2026-11-20"),
    coordinator.acquire("2026-11-20")
  ]);
  const snapshot = { matches: [{ eventId: "match-1", teams: [{ shotsOnTarget: 4 }, { shotsOnTarget: 3 }] }] };
  leader.publish(snapshot);

  const shared = await followers;
  assert.equal(shared.length, 3);
  for (const lease of shared) {
    assert.equal(lease.role, "shared");
    assert.equal(lease.value, snapshot);
  }
});

test("a published snapshot is reused until its TTL expires", async () => {
  let clock = 1000;
  const coordinator = createSharedLiveMetricsCoordinator({ ttlMs: 15000, now: () => clock });
  const first = await coordinator.acquire("today");
  first.publish({ version: 1 });

  const cached = await coordinator.acquire("today");
  assert.equal(cached.role, "shared");
  assert.equal(cached.value.version, 1);

  clock += 15001;
  const refreshed = await coordinator.acquire("today");
  assert.equal(refreshed.role, "leader");
  refreshed.publish({ version: 2 });

  const newest = await coordinator.acquire("today");
  assert.equal(newest.value.version, 2);
});

test("a failed collection releases waiters so one can retry", async () => {
  const coordinator = createSharedLiveMetricsCoordinator();
  const first = await coordinator.acquire("today");
  const waiting = coordinator.acquire("today");
  first.fail();

  const retry = await waiting;
  assert.equal(retry.role, "leader");
  retry.publish({ matches: [] });
  assert.deepEqual((await coordinator.acquire("today")).value, { matches: [] });
});
