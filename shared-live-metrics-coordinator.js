"use strict";

function createSharedLiveMetricsCoordinator(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? Math.max(0, options.ttlMs) : 15000;
  const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(1, options.maxEntries) : 8;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const snapshots = new Map();
  const inflight = new Map();

  async function acquire(key) {
    const cacheKey = String(key || "");
    if (!cacheKey) throw new Error("A live-metrics cache key is required");

    while (true) {
      const currentTime = now();
      const cached = snapshots.get(cacheKey);
      if (cached && currentTime - cached.at < ttlMs) {
        return { role: "shared", value: cached.value };
      }
      if (cached) snapshots.delete(cacheKey);

      const active = inflight.get(cacheKey);
      if (active) {
        const value = await active.promise;
        if (value !== undefined) return { role: "shared", value };
        continue;
      }

      let resolve;
      const promise = new Promise(done => { resolve = done; });
      const token = { promise, resolve, settled: false };
      inflight.set(cacheKey, token);

      const settle = value => {
        if (token.settled) return;
        token.settled = true;
        if (inflight.get(cacheKey) === token) inflight.delete(cacheKey);
        if (value !== undefined) {
          snapshots.set(cacheKey, { at: now(), value });
          while (snapshots.size > maxEntries) {
            snapshots.delete(snapshots.keys().next().value);
          }
        }
        resolve(value);
      };

      return {
        role: "leader",
        publish: value => settle(value),
        fail: () => settle(undefined)
      };
    }
  }

  return {
    acquire,
    clear() {
      snapshots.clear();
      for (const token of inflight.values()) {
        if (!token.settled) {
          token.settled = true;
          token.resolve(undefined);
        }
      }
      inflight.clear();
    }
  };
}

module.exports = { createSharedLiveMetricsCoordinator };
