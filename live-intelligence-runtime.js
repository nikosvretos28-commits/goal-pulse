"use strict";

const { createHash } = require("node:crypto");
const { buildLiveIntelligencePushPayload } = require("./live-intelligence");

function validCount(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0
    ? Number(value) : null;
}
function fingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

function createLiveIntelligenceRuntime({ getPool = () => null, getMatches, sendPush, intervalMs = 30000, now = () => new Date() } = {}) {
  let schemaPromise = null;
  let timer = null;
  let scanInFlight = null;
  let lastScanAt = null;
  let lastScanError = null;
  const memoryStates = new Map();
  const memoryAlerts = new Map();

  async function ensureSchema() {
    const pool = getPool();
    if (!pool) return false;
    if (!schemaPromise) schemaPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS live_intelligence_match_state (
        event_id TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS live_intelligence_alert_history (
        alert_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        trigger_fingerprint TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        payload JSONB NOT NULL,
        delivery_status TEXT NOT NULL DEFAULT 'pending',
        delivery_result JSONB,
        attempts INTEGER NOT NULL DEFAULT 0,
        UNIQUE(event_id, trigger_type, trigger_fingerprint)
      );
      CREATE INDEX IF NOT EXISTS live_intelligence_history_created_idx
        ON live_intelligence_alert_history(created_at DESC);
      CREATE INDEX IF NOT EXISTS live_intelligence_history_event_idx
        ON live_intelligence_alert_history(event_id, created_at DESC);
    `).then(() => true).catch(error => {
      schemaPromise = null;
      console.error("[LIVE INTELLIGENCE] persistence unavailable:", error.message);
      return false;
    });
    return schemaPromise;
  }

  async function readState(eventId) {
    const pool = getPool();
    if (pool && await ensureSchema()) {
      const result = await pool.query("SELECT snapshot FROM live_intelligence_match_state WHERE event_id=$1", [eventId]);
      return result.rows[0]?.snapshot || null;
    }
    return memoryStates.get(eventId) || null;
  }

  async function writeState(eventId, snapshot) {
    const pool = getPool();
    if (pool && await ensureSchema()) {
      await pool.query(`
        INSERT INTO live_intelligence_match_state(event_id,snapshot,updated_at)
        VALUES($1,$2::jsonb,NOW())
        ON CONFLICT(event_id) DO UPDATE SET snapshot=EXCLUDED.snapshot,updated_at=NOW()
      `, [eventId, JSON.stringify(snapshot)]);
    } else {
      memoryStates.set(eventId, snapshot);
    }
  }

  async function deliverOnce(match, event) {
    const eventId = String(match.eventId);
    const score = match.score || {};
    const redCards = match.analysis?.gameState?.redCards || {};
    const triggerFingerprint = event.fingerprint || (event.type === "goal"
      ? String(validCount(score.home)) + "-" + String(validCount(score.away))
      : "home:" + String(validCount(redCards.home)) + "|away:" + String(validCount(redCards.away)));
    const analysis = {
      ...(match.analysis || {}),
      independent: true,
      recentGameStateChanges: [{
        type: event.type,
        team: event.team,
        minute: validCount(match.minute),
        timestampSeconds: Math.floor(now().getTime() / 1000),
        confirmed: true,
        description: event.type === "goal" ? "Επιβεβαιωμένη αλλαγή σκορ από live snapshots" : "Επιβεβαιωμένη αλλαγή κόκκινης κάρτας από live snapshots"
      }]
    };
    const payload = buildLiveIntelligencePushPayload({
      analysis,
      match: {
        fixtureId: eventId,
        home: match.home,
        away: match.away,
        league: match.league,
        country: match.country,
        minute: match.minute,
        score
      },
      triggeredAt: now().toISOString()
    });
    if (!payload.ok) return { skipped: true, reason: payload.reason };

    const alertId = fingerprint(eventId + "|" + event.type + "|" + triggerFingerprint);
    const pool = getPool();
    let existing = memoryAlerts.get(alertId) || null;
    if (pool && await ensureSchema()) {
      await pool.query(`
        INSERT INTO live_intelligence_alert_history
          (alert_id,event_id,trigger_type,trigger_fingerprint,payload,delivery_status)
        VALUES($1,$2,$3,$4,$5::jsonb,'pending')
        ON CONFLICT(event_id,trigger_type,trigger_fingerprint) DO NOTHING
      `, [alertId, eventId, event.type, triggerFingerprint, JSON.stringify(payload)]);
      const found = await pool.query(
        "SELECT alert_id,payload,delivery_status,attempts FROM live_intelligence_alert_history WHERE event_id=$1 AND trigger_type=$2 AND trigger_fingerprint=$3",
        [eventId, event.type, triggerFingerprint]
      );
      existing = found.rows[0] || null;
    } else if (!existing) {
      existing = { alert_id: alertId, payload, delivery_status: "pending", attempts: 0 };
      memoryAlerts.set(alertId, existing);
    }
    if (existing.delivery_status === "delivered" || existing.delivery_status === "not_configured") {
      return { skipped: true, reason: "already_delivered_or_not_configured", alertId: existing.alert_id };
    }

    let delivery;
    try {
      delivery = typeof sendPush === "function"
        ? await sendPush(payload)
        : { sent: 0, failed: 0, configured: false };
    } catch (error) {
      delivery = { sent: 0, failed: 1, configured: true, error: String(error.message || error).slice(0, 180) };
    }
    const status = delivery.configured === false
      ? "not_configured"
      : Number(delivery.sent || 0) > 0 ? "delivered" : "pending";
    const attempts = Number(existing.attempts || 0) + 1;
    const result = { ...delivery, attemptedAt: now().toISOString() };
    if (pool && await ensureSchema()) {
      await pool.query(`
        UPDATE live_intelligence_alert_history
        SET delivery_status=$2,delivery_result=$3::jsonb,attempts=$4
        WHERE alert_id=$1
      `, [existing.alert_id || alertId, status, JSON.stringify(result), attempts]);
    }
    memoryAlerts.set(alertId, { alert_id: alertId, payload, delivery_status: status, delivery_result: result, attempts });
    return { alertId, deliveryStatus: status, delivery: result };
  }

  async function processMatch(match) {
    if (!match || match.eventId == null || !match.analysis?.gameState) return null;
    const eventId = String(match.eventId);
    const score = match.score || {};
    const current = {
      scoreHome: validCount(score.home),
      scoreAway: validCount(score.away),
      redCardsHome: validCount(match.analysis.gameState.redCards?.home),
      redCardsAway: validCount(match.analysis.gameState.redCards?.away),
      minute: validCount(match.minute)
    };
    const previous = await readState(eventId);
    await writeState(eventId, current);
    if (!previous) return { eventId, seeded: true };
    const events = [];
    if (current.scoreHome !== null && current.scoreAway !== null &&
        previous.scoreHome !== null && previous.scoreAway !== null &&
        (current.scoreHome !== previous.scoreHome || current.scoreAway !== previous.scoreAway)) {
      const homeDelta = current.scoreHome - previous.scoreHome;
      const awayDelta = current.scoreAway - previous.scoreAway;
      if (homeDelta >= 0 && awayDelta >= 0 && (homeDelta > 0 || awayDelta > 0)) {
        events.push({
          type: "goal",
          team: homeDelta > awayDelta ? "home" : awayDelta > homeDelta ? "away" : null,
          fingerprint: String(previous.scoreHome) + "-" + String(previous.scoreAway) + ">" +
            String(current.scoreHome) + "-" + String(current.scoreAway) + "@" + String(current.minute)
        });
      }
    }
    if (current.redCardsHome !== null && current.redCardsAway !== null &&
        previous.redCardsHome !== null && previous.redCardsAway !== null) {
      if (current.redCardsHome > previous.redCardsHome) events.push({
        type: "red_card", team: "home",
        fingerprint: "home:" + previous.redCardsHome + ">" + current.redCardsHome +
          "|away:" + previous.redCardsAway + ">" + current.redCardsAway + "@" + String(current.minute)
      });
      if (current.redCardsAway > previous.redCardsAway) events.push({
        type: "red_card", team: "away",
        fingerprint: "home:" + previous.redCardsHome + ">" + current.redCardsHome +
          "|away:" + previous.redCardsAway + ">" + current.redCardsAway + "@" + String(current.minute)
      });
    }
    if (!events.length) return { eventId, observed: true };
    const outcomes = [];
    for (const event of events) outcomes.push(await deliverOnce(match, event));
    return { eventId, events: outcomes, ...outcomes[0] };
  }

  async function retryPending() {
    const pool = getPool();
    if (pool && await ensureSchema()) {
      const pending = await pool.query("SELECT alert_id,payload,attempts FROM live_intelligence_alert_history WHERE delivery_status='pending' ORDER BY created_at ASC LIMIT 25");
      for (const row of pending.rows) {
        let delivery;
        try { delivery = typeof sendPush === "function" ? await sendPush(row.payload) : { sent: 0, failed: 0, configured: false }; }
        catch (error) { delivery = { sent: 0, failed: 1, configured: true, error: String(error.message || error).slice(0, 180) }; }
        const status = delivery.configured === false ? "not_configured" : Number(delivery.sent || 0) > 0 ? "delivered" : "pending";
        const result = { ...delivery, attemptedAt: now().toISOString() };
        await pool.query("UPDATE live_intelligence_alert_history SET delivery_status=$2,delivery_result=$3::jsonb,attempts=$4 WHERE alert_id=$1", [row.alert_id, status, JSON.stringify(result), Number(row.attempts || 0) + 1]);
        memoryAlerts.set(row.alert_id, { alert_id: row.alert_id, payload: row.payload, delivery_status: status, delivery_result: result, attempts: Number(row.attempts || 0) + 1 });
      }
      return pending.rowCount || 0;
    }
    let retried = 0;
    for (const row of memoryAlerts.values()) {
      if (row.delivery_status !== "pending") continue;
      let delivery;
      try { delivery = typeof sendPush === "function" ? await sendPush(row.payload) : { sent: 0, failed: 0, configured: false }; }
      catch (error) { delivery = { sent: 0, failed: 1, configured: true, error: String(error.message || error).slice(0, 180) }; }
      row.delivery_status = delivery.configured === false ? "not_configured" : Number(delivery.sent || 0) > 0 ? "delivered" : "pending";
      row.delivery_result = { ...delivery, attemptedAt: now().toISOString() };
      row.attempts = Number(row.attempts || 0) + 1;
      retried++;
    }
    return retried;
  }
  async function scan() {
    if (scanInFlight) return scanInFlight;
    scanInFlight = (async () => {
      try {
        if (typeof getMatches !== "function") throw new Error("LIVE INTELLIGENCE match source is not configured");
        await retryPending();
        const matches = await getMatches();
        const results = [];
        for (const match of Array.isArray(matches) ? matches : []) {
          try { results.push(await processMatch(match)); }
          catch (error) { results.push({ eventId: match?.eventId || null, error: String(error.message || error).slice(0, 160) }); }
        }
        lastScanAt = now().toISOString();
        lastScanError = null;
        return { ok: true, scanned: results.length, results, lastScanAt };
      } catch (error) {
        lastScanError = String(error.message || error).slice(0, 220);
        return { ok: false, error: lastScanError, lastScanAt };
      } finally {
        scanInFlight = null;
      }
    })();
    return scanInFlight;
  }

  async function listHistory(limit = 50) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const pool = getPool();
    if (pool && await ensureSchema()) {
      const result = await pool.query(`
        SELECT alert_id,event_id,trigger_type,created_at,payload,delivery_status,delivery_result,attempts
        FROM live_intelligence_alert_history
        ORDER BY created_at DESC LIMIT $1
      `, [safeLimit]);
      return { persistent: true, records: result.rows };
    }
    return {
      persistent: false,
      records: [...memoryAlerts.values()]
        .sort((a,b) => String(b.delivery_result?.attemptedAt || "").localeCompare(String(a.delivery_result?.attemptedAt || "")))
        .slice(0, safeLimit)
    };
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { scan().catch(() => {}); }, intervalMs);
    timer.unref?.();
    setTimeout(() => { scan().catch(() => {}); }, 12000).unref?.();
    console.log("[LIVE INTELLIGENCE] independent scanner scheduled every " + Math.round(intervalMs / 1000) + " seconds");
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }
  function status() {
    return { enabled: Boolean(timer), intervalMs, lastScanAt, lastScanError, rollingWindows: "unavailable_without_true_event_timestamps" };
  }

  return { ensureSchema, scan, listHistory, start, stop, status };
}

module.exports = { createLiveIntelligenceRuntime };
