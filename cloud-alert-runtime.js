"use strict";

const crypto = require("node:crypto");

function createCloudAlertRuntime({ getPool, sendPush, pushEnabled = false }) {
  let schemaReady = null;
  let lastSnapshotPruneAt = 0;

  async function ensureSchema() {
    const pool = getPool();
    if (!pool) return false;
    if (!schemaReady) {
      schemaReady = pool.query(`
        CREATE TABLE IF NOT EXISTS cloud_alert_signals (
          signal_id TEXT PRIMARY KEY,
          match_id TEXT NOT NULL,
          fixture_id TEXT,
          league TEXT,
          rule_version TEXT NOT NULL DEFAULT 'cloud-alert-v0.2',
          period TEXT NOT NULL CHECK (period IN ('1H','2H')),
          trigger_ids JSONB NOT NULL,
          minute INTEGER,
          home TEXT NOT NULL,
          away TEXT NOT NULL,
          home_sot INTEGER NOT NULL,
          away_sot INTEGER NOT NULL,
          recent_sot6 INTEGER,
          recent_sot10 INTEGER,
          score_home INTEGER,
          score_away INTEGER,
          status TEXT NOT NULL,
          payload JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE cloud_alert_signals ADD COLUMN IF NOT EXISTS fixture_id TEXT;
        ALTER TABLE cloud_alert_signals ADD COLUMN IF NOT EXISTS league TEXT;
        ALTER TABLE cloud_alert_signals ADD COLUMN IF NOT EXISTS rule_version TEXT NOT NULL DEFAULT 'cloud-alert-v0.2';
        ALTER TABLE cloud_alert_signals ADD COLUMN IF NOT EXISTS recent_sot6 INTEGER;
        CREATE INDEX IF NOT EXISTS cloud_alert_signals_created_idx ON cloud_alert_signals(created_at DESC);
        CREATE INDEX IF NOT EXISTS cloud_alert_signals_match_idx ON cloud_alert_signals(match_id, created_at DESC);
        CREATE OR REPLACE FUNCTION cloud_alert_reject_signal_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $cloudsignal$
        BEGIN
          IF TG_OP='TRUNCATE' OR TG_OP='DELETE' THEN
            RAISE EXCEPTION 'Cloud Alert signal snapshots are immutable';
          END IF;
          IF ROW(OLD.signal_id,OLD.match_id,OLD.fixture_id,OLD.league,OLD.rule_version,OLD.period,
                 OLD.trigger_ids,OLD.minute,OLD.home,OLD.away,OLD.home_sot,OLD.away_sot,
                 OLD.recent_sot6,OLD.recent_sot10,OLD.score_home,OLD.score_away,OLD.payload,OLD.created_at)
             IS DISTINCT FROM
             ROW(NEW.signal_id,NEW.match_id,NEW.fixture_id,NEW.league,NEW.rule_version,NEW.period,
                 NEW.trigger_ids,NEW.minute,NEW.home,NEW.away,NEW.home_sot,NEW.away_sot,
                 NEW.recent_sot6,NEW.recent_sot10,NEW.score_home,NEW.score_away,NEW.payload,NEW.created_at) THEN
            RAISE EXCEPTION 'Cloud Alert signal snapshots are immutable';
          END IF;
          RETURN NEW;
        END;
        $cloudsignal$;
        DO $cloudsignal$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname='cloud_alert_signal_snapshot_immutable'
              AND tgrelid='cloud_alert_signals'::regclass
              AND NOT tgisinternal
          ) THEN
            CREATE TRIGGER cloud_alert_signal_snapshot_immutable
            BEFORE UPDATE OR DELETE ON cloud_alert_signals
            FOR EACH ROW EXECUTE FUNCTION cloud_alert_reject_signal_mutation();
          END IF;
        END;
        $cloudsignal$;
        DO $cloudsignal$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname='cloud_alert_signal_no_truncate'
              AND tgrelid='cloud_alert_signals'::regclass
              AND NOT tgisinternal
          ) THEN
            CREATE TRIGGER cloud_alert_signal_no_truncate
            BEFORE TRUNCATE ON cloud_alert_signals
            FOR EACH STATEMENT EXECUTE FUNCTION cloud_alert_reject_signal_mutation();
          END IF;
        END;
        $cloudsignal$;
        CREATE TABLE IF NOT EXISTS cloud_alert_push_state (
          match_id TEXT NOT NULL,
          period TEXT NOT NULL CHECK (period IN ('1H','2H')),
          sent_count INTEGER NOT NULL DEFAULT 0 CHECK (sent_count BETWEEN 0 AND 2),
          last_score_total INTEGER,
          last_signal_id TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY(match_id, period)
        );
        CREATE TABLE IF NOT EXISTS cloud_alert_sot_snapshots (
          match_id TEXT NOT NULL,
          period TEXT NOT NULL CHECK (period IN ('1H','2H')),
          sampled_at TIMESTAMPTZ NOT NULL,
          home_sot INTEGER NOT NULL,
          away_sot INTEGER NOT NULL,
          PRIMARY KEY(match_id, period, sampled_at)
        );
        CREATE INDEX IF NOT EXISTS cloud_alert_sot_snapshots_time_idx ON cloud_alert_sot_snapshots(match_id,period,sampled_at DESC);
        CREATE TABLE IF NOT EXISTS cloud_alert_pushes (
          push_id TEXT PRIMARY KEY,
          match_id TEXT NOT NULL,
          period TEXT NOT NULL CHECK (period IN ('1H','2H')),
          slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 2),
          signal_id TEXT NOT NULL REFERENCES cloud_alert_signals(signal_id),
          kind TEXT NOT NULL CHECK (kind IN ('initial','re_alert')),
          status TEXT NOT NULL CHECK (status IN ('sending','accepted','failed','unknown')),
          payload JSONB NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 1,
          error_message TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          delivered_at TIMESTAMPTZ
        );
        ALTER TABLE cloud_alert_pushes DROP CONSTRAINT IF EXISTS cloud_alert_pushes_match_id_period_slot_key;
        ALTER TABLE cloud_alert_pushes DROP CONSTRAINT IF EXISTS cloud_alert_pushes_signal_id_key;
        ALTER TABLE cloud_alert_pushes ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE cloud_alert_pushes ADD COLUMN IF NOT EXISTS error_message TEXT;
        ALTER TABLE cloud_alert_pushes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
        CREATE INDEX IF NOT EXISTS cloud_alert_pushes_created_idx ON cloud_alert_pushes(created_at DESC);
        CREATE INDEX IF NOT EXISTS cloud_alert_pushes_signal_idx ON cloud_alert_pushes(signal_id);
        CREATE UNIQUE INDEX IF NOT EXISTS cloud_alert_pushes_active_slot_idx
          ON cloud_alert_pushes(match_id,period,slot)
          WHERE status IN ('sending','accepted','unknown');
      `).then(() => true).catch(error => {
        schemaReady = null;
        console.error("[Cloud Alert] database initialization failed:", error.message);
        return false;
      });
    }
    return schemaReady;
  }

  async function pruneOldSnapshots(pool) {
    const now = Date.now();
    if (now - lastSnapshotPruneAt < 6 * 60 * 60 * 1000) return;
    lastSnapshotPruneAt = now;
    try {
      await pool.query(
        "DELETE FROM cloud_alert_sot_snapshots WHERE sampled_at < NOW() - INTERVAL '36 hours'"
      );
    } catch (error) {
      lastSnapshotPruneAt = 0;
      console.warn("[Cloud Alert] snapshot retention cleanup deferred:", error.message || error);
    }
  }

  async function recordSnapshot({ matchId, period, homeSot, awaySot }) {
    const pool = getPool();
    if (!pool || !(await ensureSchema())) return { value: null, valid: false, reason: "persistent_database_unavailable" };
    if (!matchId || !["1H", "2H"].includes(period) || !Number.isInteger(homeSot) || !Number.isInteger(awaySot)) {
      return { value: null, valid: false, reason: "invalid_sot_snapshot" };
    }
    const sampledAt = new Date(Math.floor(Date.now() / 60000) * 60000);
    await pruneOldSnapshots(pool);
    await pool.query(
      `INSERT INTO cloud_alert_sot_snapshots(match_id,period,sampled_at,home_sot,away_sot)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(match_id,period,sampled_at) DO UPDATE SET
         home_sot=GREATEST(cloud_alert_sot_snapshots.home_sot,EXCLUDED.home_sot),
         away_sot=GREATEST(cloud_alert_sot_snapshots.away_sot,EXCLUDED.away_sot)`,
      [String(matchId), period, sampledAt.toISOString(), homeSot, awaySot]
    );
    const [baseline6, baseline10] = await Promise.all([
      pool.query(
        `SELECT home_sot,away_sot,sampled_at FROM cloud_alert_sot_snapshots
         WHERE match_id=$1 AND period=$2
           AND sampled_at <= $3::timestamptz - INTERVAL '6 minutes'
           AND sampled_at >= $3::timestamptz - INTERVAL '7 minutes'
         ORDER BY sampled_at DESC LIMIT 1`,
        [String(matchId), period, sampledAt.toISOString()]
      ),
      pool.query(
        `SELECT home_sot,away_sot,sampled_at FROM cloud_alert_sot_snapshots
         WHERE match_id=$1 AND period=$2
           AND sampled_at <= $3::timestamptz - INTERVAL '9 minutes'
           AND sampled_at >= $3::timestamptz - INTERVAL '11 minutes 30 seconds'
         ORDER BY sampled_at DESC LIMIT 1`,
        [String(matchId), period, sampledAt.toISOString()]
      )
    ]);
    const delta = prior => {
      if (!prior) return null;
      const previousHome = Number(prior.home_sot), previousAway = Number(prior.away_sot);
      if (homeSot < previousHome || awaySot < previousAway) return { regression: true };
      return {
        value: (homeSot - previousHome) + (awaySot - previousAway),
        baselineAt: new Date(prior.sampled_at).toISOString()
      };
    };
    const recent6 = delta(baseline6.rows[0]);
    const recent10 = delta(baseline10.rows[0]);
    if (recent6?.regression || recent10?.regression) {
      return { value: null, valid: false, recentSot10: null, recentSot10Valid: false, reason: "cumulative_sot_regression" };
    }
    return {
      value: recent6?.value ?? null,
      valid: recent6 !== null,
      reason: recent6 ? null : "six_minute_baseline_not_yet_available",
      baselineAt: recent6?.baselineAt ?? null,
      recentSot10: recent10?.value ?? null,
      recentSot10Valid: recent10 !== null,
      baseline10At: recent10?.baselineAt ?? null
    };
  }

  async function recordShadowCandidate(candidate) {
    const pool = getPool();
    if (!pool || !(await ensureSchema())) return { saved: false, reason: "persistent_database_unavailable" };
    const {
      matchId, fixtureId, league, country, ruleVersion, period, triggers, minute, home, away, homeSot, awaySot,
      recentSot6, recentSot10, scoreHome, scoreAway, metrics, matrixScore, availableMetrics, metricBreakdown, confirmation, statsSource
    } = candidate || {};
    if (!matchId || !["1H", "2H"].includes(period) || !Array.isArray(triggers) ||
        !triggers.length || !Number.isInteger(homeSot) || !Number.isInteger(awaySot)) {
      return { saved: false, reason: "invalid_shadow_candidate" };
    }
    const snapshot = {
      matchId: String(matchId), fixtureId: String(fixtureId || matchId),
      league: String(league || "unknown"), country: String(country || "Country unavailable"), ruleVersion: String(ruleVersion || "matrix-alert-v1"),
      period, triggers: [...triggers].sort(),
      minute: Number.isFinite(minute) ? minute : null,
      home: String(home || "Home"), away: String(away || "Away"),
      homeSot, awaySot,
      recentSot6: Number.isInteger(recentSot6) ? recentSot6 : null,
      recentSot10: Number.isInteger(recentSot10) ? recentSot10 : null,
      scoreHome: Number.isInteger(scoreHome) ? scoreHome : null,
      scoreAway: Number.isInteger(scoreAway) ? scoreAway : null,
      metrics: metrics || null, matrixScore: Number.isFinite(matrixScore) ? matrixScore : null,
      availableMetrics: Number.isInteger(availableMetrics) ? availableMetrics : null, metricBreakdown: Array.isArray(metricBreakdown) ? metricBreakdown : null,
      confirmation: String(confirmation || "unavailable"),
      statsSource: String(statsSource || "unknown"),
      mode: "shadow_only"
    };
    const signalId = crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const result = await pool.query(
      `INSERT INTO cloud_alert_signals
        (signal_id,match_id,fixture_id,league,rule_version,period,trigger_ids,minute,home,away,home_sot,away_sot,recent_sot6,recent_sot10,score_home,score_away,status,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,'shadow_qualified',$17::jsonb)
       ON CONFLICT (signal_id) DO NOTHING
       RETURNING signal_id`,
      [signalId, snapshot.matchId, snapshot.fixtureId, snapshot.league, snapshot.ruleVersion,
       period, JSON.stringify(snapshot.triggers), snapshot.minute, snapshot.home, snapshot.away,
       homeSot, awaySot, snapshot.recentSot6, snapshot.recentSot10, snapshot.scoreHome, snapshot.scoreAway, JSON.stringify(snapshot)]
    );
    return { saved: result.rowCount > 0, duplicate: result.rowCount === 0, signalId };
  }

  async function processCandidate(candidate) {
    if (pushEnabled !== true) {
      return { ok: true, pushed: false, reason: "cloud_alert_activation_locked" };
    }
    const pool = getPool();
    if (!pool || !(await ensureSchema())) return { ok: false, reason: "persistent_database_unavailable" };
    const {
      matchId, fixtureId, league, country, ruleVersion, period, triggers, minute, home, away, homeSot, awaySot,
      recentSot6, recentSot10, scoreHome, scoreAway, metrics, matrixScore, availableMetrics, metricBreakdown
    } = candidate || {};
    if (!matchId || !["1H", "2H"].includes(period) || !Array.isArray(triggers) ||
        !triggers.length || !Number.isInteger(homeSot) || !Number.isInteger(awaySot)) {
      return { ok: false, reason: "invalid_candidate" };
    }
    const snapshot = {
      matchId: String(matchId), fixtureId: String(fixtureId || matchId),
      league: String(league || "unknown"), ruleVersion: String(ruleVersion || "matrix-alert-v1"),
      period, triggers: [...triggers].sort(),
      minute: Number.isFinite(minute) ? minute : null,
      home: String(home || "Home"), away: String(away || "Away"),
      homeSot, awaySot,
      recentSot6: Number.isInteger(recentSot6) ? recentSot6 : null,
      recentSot10: Number.isInteger(recentSot10) ? recentSot10 : null,
      scoreHome: Number.isInteger(scoreHome) ? scoreHome : null,
      scoreAway: Number.isInteger(scoreAway) ? scoreAway : null,
      metrics: metrics || null, matrixScore: Number.isFinite(matrixScore) ? matrixScore : null,
      availableMetrics: Number.isInteger(availableMetrics) ? availableMetrics : null, metricBreakdown: Array.isArray(metricBreakdown) ? metricBreakdown : null,
      country: String(country || "Country unavailable")
    };
    const signalId = crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const scoreTotal = snapshot.scoreHome == null || snapshot.scoreAway == null
      ? null : snapshot.scoreHome + snapshot.scoreAway;
    let reservation = null;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO cloud_alert_signals
          (signal_id,match_id,fixture_id,league,rule_version,period,trigger_ids,minute,home,away,home_sot,away_sot,recent_sot6,recent_sot10,score_home,score_away,status,payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,'qualified',$17::jsonb)
         ON CONFLICT (signal_id) DO NOTHING`,
        [signalId, snapshot.matchId, snapshot.fixtureId, snapshot.league, snapshot.ruleVersion,
         period, JSON.stringify(snapshot.triggers), snapshot.minute, snapshot.home, snapshot.away,
         homeSot, awaySot, snapshot.recentSot6, snapshot.recentSot10,
         snapshot.scoreHome, snapshot.scoreAway, JSON.stringify(snapshot)]
      );
      await client.query(
        "INSERT INTO cloud_alert_push_state(match_id,period) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [snapshot.matchId, period]
      );
      const stateResult = await client.query(
        "SELECT sent_count,last_score_total,last_signal_id FROM cloud_alert_push_state WHERE match_id=$1 AND period=$2 FOR UPDATE",
        [snapshot.matchId, period]
      );
      const state = stateResult.rows[0];
      if (!state) throw new Error("Cloud Alert push state could not be locked");
      const activeResult = await client.query(
        `SELECT push_id,status FROM cloud_alert_pushes
         WHERE match_id=$1 AND period=$2 AND status IN ('sending','unknown')
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [snapshot.matchId, period]
      );
      if (activeResult.rows.length) {
        await client.query("UPDATE cloud_alert_signals SET status=CASE WHEN status='delivery_unknown' THEN status ELSE 'awaiting_push_delivery' END WHERE signal_id=$1", [signalId]);
        await client.query("COMMIT");
        return {
          ok: true, pushed: false,
          reason: activeResult.rows[0].status === "unknown"
            ? "delivery_unknown_manual_review" : "delivery_in_progress"
        };
      }
      let kind = null;
      if (Number(state.sent_count) === 0) kind = "initial";
      else if (Number(state.sent_count) === 1 && scoreTotal != null &&
          state.last_score_total != null && scoreTotal > Number(state.last_score_total) &&
          state.last_signal_id !== signalId) kind = "re_alert";
      if (!kind || Number(state.sent_count) >= 2) {
        await client.query("UPDATE cloud_alert_signals SET status='recorded_no_push' WHERE signal_id=$1 AND status NOT IN ('push_accepted','delivery_unknown')", [signalId]);
        await client.query("COMMIT");
        return {
          ok: true, pushed: false,
          reason: Number(state.sent_count) >= 2 ? "half_push_limit_reached" : "re_alert_requires_new_goal"
        };
      }
      const slot = Number(state.sent_count) + 1;
      const attemptsResult = await client.query(
        `SELECT COUNT(*)::int AS attempts,
                MAX(created_at) FILTER (WHERE status='failed') AS last_failed_at
         FROM cloud_alert_pushes WHERE match_id=$1 AND period=$2 AND slot=$3`,
        [snapshot.matchId, period, slot]
      );
      const lastFailedAt = attemptsResult.rows[0]?.last_failed_at
        ? new Date(attemptsResult.rows[0].last_failed_at).getTime() : 0;
      if (lastFailedAt && Date.now() - lastFailedAt < 5 * 60 * 1000) {
        await client.query("UPDATE cloud_alert_signals SET status='recorded_no_push' WHERE signal_id=$1 AND status NOT IN ('push_accepted','delivery_unknown')", [signalId]);
        await client.query("COMMIT");
        return { ok: true, pushed: false, reason: "push_retry_backoff" };
      }
      const attemptCount = Number(attemptsResult.rows[0]?.attempts || 0) + 1;
      const pushId = crypto.randomUUID();
      const payload = {
        title: "🧮 GOALMATRIX · MATRIX ALERT",
        body: snapshot.home + " " + (snapshot.scoreHome ?? "—") + "–" +
          (snapshot.scoreAway ?? "—") + " " + snapshot.away + " · " + period +
          (snapshot.minute == null ? "" : " · " + snapshot.minute + "′") +
          " · SOT " + homeSot + "–" + awaySot + " · Matrix " + (snapshot.matrixScore ?? "—") + "/100" +
          " · " + snapshot.league + " · " + snapshot.country,
        tag: "goalmatrix-cloud-" + snapshot.matchId + "-" + period + "-" + slot,
        url: "/#cloudAlertPanel",
        cloudAlert: true,
        eventId: snapshot.matchId,
        period,
        triggers: snapshot.triggers
      };
      await client.query(
        `INSERT INTO cloud_alert_pushes
          (push_id,match_id,period,slot,signal_id,kind,status,payload,attempt_count,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,'sending',$7::jsonb,$8,NOW())`,
        [pushId, snapshot.matchId, period, slot, signalId, kind, JSON.stringify(payload), attemptCount]
      );
      await client.query("UPDATE cloud_alert_signals SET status='awaiting_push_delivery' WHERE signal_id=$1", [signalId]);
      await client.query("COMMIT");
      reservation = { pushId, signalId, matchId: snapshot.matchId, period, slot, kind, scoreTotal, payload };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    let delivery;
    try {
      if (typeof sendPush !== "function") {
        delivery = { sent: 0, failed: 0, configured: false };
      } else {
        delivery = await sendPush(reservation.payload);
      }
    } catch (error) {
      const message = String(error.message || error).slice(0, 300);
      const markClient = await pool.connect();
      try {
        await markClient.query("BEGIN");
        await markClient.query(
          "UPDATE cloud_alert_pushes SET status='unknown',error_message=$2,updated_at=NOW() WHERE push_id=$1 AND status='sending'",
          [reservation.pushId, message]
        );
        await markClient.query("UPDATE cloud_alert_signals SET status='delivery_unknown' WHERE signal_id=$1", [reservation.signalId]);
        await markClient.query("COMMIT");
      } catch (persistError) {
        await markClient.query("ROLLBACK").catch(() => {});
        console.error("[Cloud Alert] delivery outcome unknown and could not be recorded:", persistError.message || persistError);
      } finally {
        markClient.release();
      }
      return { ok: false, pushed: false, reason: "delivery_unknown_manual_review" };
    }

    const sent = Math.max(0, Number(delivery?.sent) || 0);
    const failed = Math.max(0, Number(delivery?.failed) || 0);
    if (sent > 0) {
      const finishClient = await pool.connect();
      try {
        await finishClient.query("BEGIN");
        await finishClient.query(
          "UPDATE cloud_alert_pushes SET status='accepted',delivered_at=NOW(),updated_at=NOW(),error_message=$2 WHERE push_id=$1 AND status='sending'",
          [reservation.pushId, failed ? failed + " subscriber delivery failures" : null]
        );
        await finishClient.query(
          `UPDATE cloud_alert_push_state SET sent_count=$3,last_score_total=$4,last_signal_id=$5,updated_at=NOW()
           WHERE match_id=$1 AND period=$2`,
          [reservation.matchId, reservation.period, reservation.slot, reservation.scoreTotal, reservation.signalId]
        );
        await finishClient.query("UPDATE cloud_alert_signals SET status='push_accepted' WHERE signal_id=$1", [reservation.signalId]);
        await finishClient.query("COMMIT");
      } catch (error) {
        await finishClient.query("ROLLBACK").catch(() => {});
        console.error("[Cloud Alert] push accepted but final state remains reserved:", error.message || error);
        return { ok: false, pushed: false, reason: "delivery_accepted_persistence_pending_manual_review" };
      } finally {
        finishClient.release();
      }
      return { ok: true, pushed: true, kind: reservation.kind, slot: reservation.slot, sent, failed };
    }

    const failedClient = await pool.connect();
    try {
      await failedClient.query("BEGIN");
      await failedClient.query(
        "UPDATE cloud_alert_pushes SET status='failed',error_message=$2,updated_at=NOW() WHERE push_id=$1 AND status='sending'",
        [reservation.pushId, delivery?.configured ? "no subscriber accepted the push" : "web push not configured"]
      );
      await failedClient.query("UPDATE cloud_alert_signals SET status='recorded_no_push' WHERE signal_id=$1", [reservation.signalId]);
      await failedClient.query("COMMIT");
    } catch (error) {
      await failedClient.query("ROLLBACK").catch(() => {});
      console.error("[Cloud Alert] failed delivery reservation could not be released:", error.message || error);
      return { ok: false, pushed: false, reason: "failed_delivery_persistence_pending_manual_review" };
    } finally {
      failedClient.release();
    }
    return {
      ok: true, pushed: false,
      reason: delivery?.configured ? "no_active_push_subscriber" : "web_push_not_configured"
    };
  }

  async function listHistory(limit = 100) {
    const pool = getPool();
    if (!pool || !(await ensureSchema())) return { persistent: false, signals: [], pushes: [] };
    const safeLimit = Math.max(1, Math.min(250, Number(limit) || 100));
    const [signals, pushes] = await Promise.all([
      pool.query("SELECT signal_id,match_id,fixture_id,league,rule_version,period,trigger_ids,minute,home,away,home_sot,away_sot,recent_sot6,recent_sot10,score_home,score_away,status,payload,created_at FROM cloud_alert_signals ORDER BY created_at DESC LIMIT $1", [safeLimit]),
      pool.query("SELECT push_id,match_id,period,slot,signal_id,kind,status,payload,attempt_count,created_at,updated_at,delivered_at FROM cloud_alert_pushes ORDER BY updated_at DESC,created_at DESC LIMIT $1", [safeLimit])
    ]);
    return { persistent: true, signals: signals.rows, pushes: pushes.rows };
  }

  return { ensureSchema, recordSnapshot, recordShadowCandidate, processCandidate, listHistory };
}

module.exports = { createCloudAlertRuntime };
