"use strict";

const crypto = require("node:crypto");

const TARGET_PERIODS = new Set(["HT", "FT"]);
const STATES = new Set(["pending", "settled_verified", "unverifiable", "disputed"]);

function validateSettlementInput(input) {
  const value = input && typeof input === "object" ? input : {};
  const errors = [];
  const signalId = String(value.signalId || "").trim();
  const targetPeriod = String(value.targetPeriod || "").toUpperCase();
  const state = String(value.state || "").toLowerCase();
  const provider = String(value.provider || "").trim();
  const fixtureId = String(value.fixtureId || "").trim();
  const settledAt = value.settledAt == null ? null : new Date(value.settledAt);
  const source = String(value.source || "").trim();
  const reason = String(value.reason || "").trim();
  if (!signalId) errors.push("signalId_required");
  if (!TARGET_PERIODS.has(targetPeriod)) errors.push("targetPeriod_must_be_HT_or_FT");
  if (!STATES.has(state)) errors.push("invalid_state");
  if (!provider) errors.push("provider_required");
  if (!fixtureId) errors.push("fixtureId_required");
  if (!source) errors.push("source_required");
  if (!settledAt || !Number.isFinite(settledAt.getTime())) errors.push("valid_settledAt_required");
  if (state === "settled_verified") {
    if (!Number.isInteger(value.scoreHome) || value.scoreHome < 0 ||
        !Number.isInteger(value.scoreAway) || value.scoreAway < 0) errors.push("verified_score_required");
  } else if (state === "unverifiable" || state === "disputed") {
    if (!reason) errors.push("reason_required_for_nonverified_state");
  }
  return {
    valid: errors.length === 0, errors,
    value: {
      signalId, targetPeriod, state, provider, fixtureId, source,
      settledAt: settledAt && Number.isFinite(settledAt.getTime()) ? settledAt.toISOString() : null,
      scoreHome: Number.isInteger(value.scoreHome) ? value.scoreHome : null,
      scoreAway: Number.isInteger(value.scoreAway) ? value.scoreAway : null,
      reason
    }
  };
}

function gradeSignalSettlement(signalPayload, targetPeriod, scoreHome, scoreAway) {
  if (!signalPayload || !["1H", "2H"].includes(signalPayload.period)) {
    return { valid: false, reason: "signal_snapshot_missing_or_invalid" };
  }
  if (!TARGET_PERIODS.has(targetPeriod)) return { valid: false, reason: "invalid_target_period" };
  if (signalPayload.period === "2H" && targetPeriod === "HT") {
    return { valid: false, reason: "second_half_signal_cannot_settle_at_half_time" };
  }
  if (!Number.isInteger(scoreHome) || scoreHome < 0 ||
      !Number.isInteger(scoreAway) || scoreAway < 0) {
    return { valid: false, reason: "invalid_period_score" };
  }
  if (!Number.isInteger(signalPayload.scoreHome) || signalPayload.scoreHome < 0 ||
      !Number.isInteger(signalPayload.scoreAway) || signalPayload.scoreAway < 0) {
    return { valid: false, reason: "signal_time_score_missing" };
  }
  const signalGoals = signalPayload.scoreHome + signalPayload.scoreAway;
  if (!Number.isInteger(signalGoals) || signalGoals < 0) {
    return { valid: false, reason: "signal_time_score_missing" };
  }
  const overLine = signalGoals + 0.5;
  const resultGoals = scoreHome + scoreAway;
  return {
    valid: true, targetPeriod, signalGoals, overLine, resultGoals,
    outcome: resultGoals > overLine ? "win" : "loss",
    scoreHome, scoreAway
  };
}

function createCloudAlertSettlement({ getPool, ensureSignalSchema = async () => true }) {
  let schemaReady = null;
  async function ensureSchema() {
    const pool = getPool();
    if (!pool) return false;
    if (!(await ensureSignalSchema())) return false;
    if (!schemaReady) {
      schemaReady = pool.query(`
        CREATE TABLE IF NOT EXISTS cloud_alert_settlement_events (
          event_id TEXT PRIMARY KEY,
          event_seq BIGSERIAL,
          signal_id TEXT NOT NULL REFERENCES cloud_alert_signals(signal_id),
          target_period TEXT NOT NULL CHECK (target_period IN ('HT','FT')),
          state TEXT NOT NULL CHECK (state IN ('pending','settled_verified','unverifiable','disputed')),
          provider TEXT NOT NULL,
          fixture_id TEXT NOT NULL,
          source TEXT NOT NULL,
          settled_at TIMESTAMPTZ NOT NULL,
          score_home INTEGER,
          score_away INTEGER,
          signal_goals INTEGER,
          over_line NUMERIC(6,1),
          result_goals INTEGER,
          outcome TEXT CHECK (outcome IN ('win','loss')),
          reason TEXT,
          previous_event_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE cloud_alert_settlement_events
          ADD COLUMN IF NOT EXISTS event_seq BIGSERIAL;
        CREATE INDEX IF NOT EXISTS cloud_alert_settlement_signal_idx
          ON cloud_alert_settlement_events(signal_id,target_period,created_at DESC);
        CREATE INDEX IF NOT EXISTS cloud_alert_settlement_created_idx
          ON cloud_alert_settlement_events(created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS cloud_alert_settlement_event_seq_idx
          ON cloud_alert_settlement_events(event_seq);
        CREATE OR REPLACE FUNCTION cloud_alert_reject_settlement_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'Cloud Alert settlement audit events are append-only';
        END;
        $$;
        DO $cloudalert$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname='cloud_alert_settlement_append_only'
              AND tgrelid='cloud_alert_settlement_events'::regclass
              AND NOT tgisinternal
          ) THEN
            CREATE TRIGGER cloud_alert_settlement_append_only
            BEFORE UPDATE OR DELETE ON cloud_alert_settlement_events
            FOR EACH ROW EXECUTE FUNCTION cloud_alert_reject_settlement_mutation();
          END IF;
        END;
        $cloudalert$;
        DO $cloudalert$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname='cloud_alert_settlement_no_truncate'
              AND tgrelid='cloud_alert_settlement_events'::regclass
              AND NOT tgisinternal
          ) THEN
            CREATE TRIGGER cloud_alert_settlement_no_truncate
            BEFORE TRUNCATE ON cloud_alert_settlement_events
            FOR EACH STATEMENT EXECUTE FUNCTION cloud_alert_reject_settlement_mutation();
          END IF;
        END;
        $cloudalert$;
      `).then(() => true).catch(error => {
        schemaReady = null;
        console.error("[Cloud Alert] settlement schema initialization failed:", error.message);
        return false;
      });
    }
    return schemaReady;
  }

  async function appendEvent(input) {
    const checked = validateSettlementInput(input);
    if (!checked.valid) return { ok: false, reason: "invalid_settlement", errors: checked.errors };
    const value = checked.value;
    const pool = getPool();
    if (!pool || !(await ensureSchema())) return { ok: false, reason: "persistent_database_unavailable" };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const signalResult = await client.query(
        "SELECT period,payload FROM cloud_alert_signals WHERE signal_id=$1 FOR UPDATE",
        [value.signalId]
      );
      if (!signalResult.rows.length) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "signal_not_found" };
      }
      const signal = signalResult.rows[0];
      const latestResult = await client.query(
        `SELECT event_id,state,provider,fixture_id,source,score_home,score_away,reason
         FROM cloud_alert_settlement_events
         WHERE signal_id=$1 AND target_period=$2
         ORDER BY event_seq DESC LIMIT 1 FOR UPDATE`,
        [value.signalId, value.targetPeriod]
      );
      const previous = latestResult.rows[0] || null;
      if (previous?.state === value.state) {
        const samePayload = previous.provider === value.provider &&
          previous.fixture_id === value.fixtureId && previous.source === value.source &&
          (previous.score_home == null ? value.scoreHome == null : Number(previous.score_home) === value.scoreHome) &&
          (previous.score_away == null ? value.scoreAway == null : Number(previous.score_away) === value.scoreAway) &&
          String(previous.reason || "") === value.reason;
        await client.query("ROLLBACK");
        return samePayload
          ? { ok: true, duplicate: true, state: previous.state, eventId: previous.event_id }
          : { ok: false, reason: "same_state_conflicting_payload_requires_dispute", state: previous.state, eventId: previous.event_id };
      }
      const allowedTransitions = {
        pending: new Set(["settled_verified", "unverifiable", "disputed"]),
        settled_verified: new Set(["disputed"]),
        unverifiable: new Set(["disputed"]),
        disputed: new Set(["settled_verified", "unverifiable"])
      };
      if (previous && !allowedTransitions[previous.state]?.has(value.state)) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "invalid_settlement_state_transition",
          from: previous.state, to: value.state };
      }
      if (value.targetPeriod === "HT" && signal.period !== "1H") {
        await client.query("ROLLBACK");
        return { ok: false, reason: "HT_result_only_applies_to_first_half_signals" };
      }
      let grade = null;
      if (value.state === "settled_verified") {
        grade = gradeSignalSettlement(signal.payload, value.targetPeriod, value.scoreHome, value.scoreAway);
        if (!grade.valid) {
          await client.query("ROLLBACK");
          return { ok: false, reason: grade.reason };
        }
      }
      const eventId = crypto.randomUUID();
      await client.query(
        `INSERT INTO cloud_alert_settlement_events
          (event_id,signal_id,target_period,state,provider,fixture_id,source,settled_at,
           score_home,score_away,signal_goals,over_line,result_goals,outcome,reason,previous_event_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [eventId, value.signalId, value.targetPeriod, value.state, value.provider,
         value.fixtureId, value.source, value.settledAt, grade?.scoreHome ?? null,
         grade?.scoreAway ?? null, grade?.signalGoals ?? null, grade?.overLine ?? null,
         grade?.resultGoals ?? null, grade?.outcome ?? null, value.reason || null,
         previous?.event_id || null]
      );
      await client.query("COMMIT");
      return { ok: true, duplicate: false, eventId, previousEventId: previous?.event_id || null,
        state: value.state, grade };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function reconcileScoreboard(scoreboardBody, now = () => Date.now()) {
    const pool = getPool();
    if (!pool || !(await ensureSchema())) return { ok: false, reason: "persistent_database_unavailable", processed: 0 };
    const feeds = Array.isArray(scoreboardBody?.feeds) ? scoreboardBody.feeds : [];
    const fixtures = new Map();
    for (const feed of feeds) {
      for (const event of Array.isArray(feed?.events) ? feed.events : []) {
        const fixtureId = String(event?.id || "").trim();
        if (!fixtureId) continue;
        const status = event.status || event.competitions?.[0]?.status || {};
        const type = status.type || {};
        const rawStatus = typeof status === "string" ? status : "";
        const statusText = [
          rawStatus,type.name,type.description,type.detail,type.shortDetail,type.state,
          status.displayClock,status.period,status.phase,event.statusText,event.status_text
        ].filter(value => value != null).map(String).join(" ").toLowerCase();
        const state = String(type.state || status.state || rawStatus).toLowerCase();
        const finished = state === "post" || type.completed === true ||
          /full[\s-]*time|finished|ended|complete|\bft\b|after[\s-]*extra/.test(statusText);
        const halfTime = /half[\s-]*time|halftime|\bht\b|interval/.test(statusText);
        const secondHalf = /second\s*half|2nd\s*half|\b2h\b/.test(statusText) ||
          Number(status.period) === 2 || Number(type.period) === 2;
        const competitors = event.competitions?.[0]?.competitors || [];
        const home = competitors.find(team => team?.homeAway === "home") || competitors[0];
        const away = competitors.find(team => team?.homeAway === "away") || competitors[1];
        const parseScore = value => value == null || String(value).trim() === "" || !/^\d+$/.test(String(value).trim())
          ? null : Number(value);
        const scoreHome = parseScore(home?.score);
        const scoreAway = parseScore(away?.score);
        fixtures.set(fixtureId, {
          fixtureId, provider: String(event._goalMatrixSource || feed.code || "").trim(),
          statusText, finished, halfTime, secondHalf, scoreHome, scoreAway
        });
      }
    }
    const signals = await pool.query(
      `SELECT s.signal_id,s.match_id,s.fixture_id,s.period,s.payload
       FROM cloud_alert_signals s
       WHERE s.status IN ('shadow_qualified','qualified','recorded_no_push','awaiting_push_delivery','push_accepted')
         AND (
           s.created_at >= NOW() - INTERVAL '48 hours'
           OR (
             s.period='1H' AND (
               NOT EXISTS (
                 SELECT 1 FROM cloud_alert_settlement_events h
                 WHERE h.signal_id=s.signal_id AND h.target_period='HT'
                   AND h.state IN ('settled_verified','unverifiable','disputed')
               )
               OR NOT EXISTS (
                 SELECT 1 FROM cloud_alert_settlement_events f
                 WHERE f.signal_id=s.signal_id AND f.target_period='FT'
                   AND f.state IN ('settled_verified','unverifiable','disputed')
               )
             )
           )
           OR (
             s.period='2H' AND NOT EXISTS (
               SELECT 1 FROM cloud_alert_settlement_events f
               WHERE f.signal_id=s.signal_id AND f.target_period='FT'
                 AND f.state IN ('settled_verified','unverifiable','disputed')
             )
           )
         )
       ORDER BY s.created_at DESC LIMIT 5000`
    );
    let processed = 0, verified = 0, unverifiable = 0, skipped = 0;
    for (const signal of signals.rows) {
      const fixture = fixtures.get(String(signal.fixture_id || signal.match_id));
      if (!fixture || !fixture.provider) { skipped++; continue; }
      const common = {
        signalId: signal.signal_id, provider: fixture.provider,
        fixtureId: fixture.fixtureId, source: "GoalMatrix /api/scoreboard exact fixture ID",
        settledAt: new Date(now()).toISOString()
      };
      const scoreValid = Number.isInteger(fixture.scoreHome) && Number.isInteger(fixture.scoreAway);
      const signalSnapshot = typeof signal.payload === "string" ? JSON.parse(signal.payload) : signal.payload;
      const signalScoreValid = Number.isInteger(signalSnapshot?.scoreHome) && Number.isInteger(signalSnapshot?.scoreAway);
      if (signal.period === "1H" && (fixture.halfTime || fixture.secondHalf || fixture.finished)) {
        const previous = await pool.query(
          `SELECT state,score_home,score_away FROM cloud_alert_settlement_events
           WHERE signal_id=$1 AND target_period='HT'
           ORDER BY event_seq DESC LIMIT 1`, [signal.signal_id]
        );
        if (!previous.rows.length || previous.rows[0].state === "pending") {
          if (fixture.halfTime && scoreValid && signalScoreValid) {
            const result = await appendEvent({ ...common, targetPeriod: "HT", state: "settled_verified",
              scoreHome: fixture.scoreHome, scoreAway: fixture.scoreAway });
            if (result.ok && !result.duplicate) verified++;
          } else {
            const reason = !signalScoreValid ? "signal_time_score_missing_cannot_grade_over_line" :
              "missed_half_time_capture_no_verified_ht_score_available";
            const result = await appendEvent({ ...common, targetPeriod: "HT", state: "unverifiable", reason });
            if (result.ok && !result.duplicate) unverifiable++;
          }
          processed++;
        } else if (previous.rows[0].state === "settled_verified" && fixture.halfTime && scoreValid &&
            (Number(previous.rows[0].score_home) !== fixture.scoreHome ||
             Number(previous.rows[0].score_away) !== fixture.scoreAway)) {
          const result = await appendEvent({ ...common, targetPeriod: "HT", state: "disputed",
            reason: "provider_ht_score_changed_after_verified_settlement" });
          if (result.ok && !result.duplicate) processed++;
        }
      }
      if (fixture.finished) {
        const previous = await pool.query(
          `SELECT state,score_home,score_away FROM cloud_alert_settlement_events
           WHERE signal_id=$1 AND target_period='FT'
           ORDER BY event_seq DESC LIMIT 1`, [signal.signal_id]
        );
        if (!previous.rows.length || previous.rows[0].state === "pending") {
          if (scoreValid && signalScoreValid) {
            const result = await appendEvent({ ...common, targetPeriod: "FT", state: "settled_verified",
              scoreHome: fixture.scoreHome, scoreAway: fixture.scoreAway });
            if (result.ok && !result.duplicate) verified++;
          } else {
            const reason = !signalScoreValid ? "signal_time_score_missing_cannot_grade_over_line" :
              "finished_fixture_missing_verified_final_score";
            const result = await appendEvent({ ...common, targetPeriod: "FT", state: "unverifiable", reason });
            if (result.ok && !result.duplicate) unverifiable++;
          }
          processed++;
        } else if (previous.rows[0].state === "settled_verified" && scoreValid &&
            (Number(previous.rows[0].score_home) !== fixture.scoreHome ||
             Number(previous.rows[0].score_away) !== fixture.scoreAway)) {
          const result = await appendEvent({ ...common, targetPeriod: "FT", state: "disputed",
            reason: "provider_ft_score_changed_after_verified_settlement" });
          if (result.ok && !result.duplicate) processed++;
        }
      }
    }
    return { ok: true, processed, verified, unverifiable, skipped, fixtures: fixtures.size, signals: signals.rows.length };
  }

  async function list(limit = 100) {
    const pool = getPool();
    if (!pool || !(await ensureSchema())) return { persistent: false, events: [] };
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const result = await pool.query(
      `SELECT e.*,s.match_id,s.fixture_id,s.league,s.rule_version,
              s.period AS signal_period,s.minute,s.home,s.away,
              s.home_sot,s.away_sot,s.recent_sot6,s.recent_sot10,s.payload AS signal_snapshot
       FROM cloud_alert_settlement_events e
       JOIN cloud_alert_signals s ON s.signal_id=e.signal_id
       ORDER BY e.event_seq DESC LIMIT $1`, [safeLimit]
    );
    return { persistent: true, events: result.rows };
  }

  async function listCurrent(limit = 250) {
    const pool = getPool();
    if (!pool || !(await ensureSchema())) return { persistent: false, settlements: [] };
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 250));
    const result = await pool.query(
      `WITH targets AS (
         SELECT signal_id,'HT'::text AS target_period FROM cloud_alert_signals WHERE period='1H'
         UNION ALL
         SELECT signal_id,'FT'::text AS target_period FROM cloud_alert_signals
       )
       SELECT s.signal_id,s.match_id,s.fixture_id,s.league,s.rule_version,
              s.period AS signal_period,s.minute,s.home,s.away,
              s.home_sot,s.away_sot,s.recent_sot6,s.recent_sot10,
              s.score_home AS signal_score_home,s.score_away AS signal_score_away,
              t.target_period,COALESCE(e.state,'pending') AS state,e.event_id,e.provider,
              e.fixture_id,e.source,e.settled_at,e.score_home,e.score_away,e.over_line,
              e.result_goals,e.outcome,e.reason,e.previous_event_id
       FROM targets t
       JOIN cloud_alert_signals s ON s.signal_id=t.signal_id
       LEFT JOIN LATERAL (
         SELECT * FROM cloud_alert_settlement_events x
         WHERE x.signal_id=t.signal_id AND x.target_period=t.target_period
         ORDER BY x.event_seq DESC LIMIT 1
       ) e ON TRUE
       ORDER BY s.created_at DESC,t.target_period ASC LIMIT $1`, [safeLimit]
    );
    return { persistent: true, settlements: result.rows };
  }

  async function integrity(limit = 500) {
    const data = await list(limit);
    if (!data.persistent) return { ok: false, persistent: false, issues: [] };
    const issues = [];
    const latest = new Map();
    for (const event of data.events) {
      const key = event.signal_id + "|" + event.target_period;
      if (!latest.has(key)) latest.set(key, event);
      if (event.state === "settled_verified" &&
          (event.score_home == null || event.score_away == null ||
           !Number.isInteger(Number(event.score_home)) || !Number.isInteger(Number(event.score_away)) ||
           !event.provider || !event.fixture_id || !event.source || !event.outcome)) {
        issues.push({ eventId: event.event_id, issue: "verified_settlement_missing_required_metadata" });
      }
      if (event.state === "unverifiable" && !event.reason) {
        issues.push({ eventId: event.event_id, issue: "unverifiable_missing_reason" });
      }
      if (event.state === "disputed" && !event.reason) {
        issues.push({ eventId: event.event_id, issue: "disputed_missing_reason" });
      }
    }
    const pool = getPool();
    const chain = await pool.query(
      `SELECT e.event_id,e.previous_event_id,e.state,p.state AS previous_state,
              e.event_seq,p.event_seq AS previous_event_seq
       FROM cloud_alert_settlement_events e
       LEFT JOIN cloud_alert_settlement_events p ON p.event_id=e.previous_event_id
       WHERE e.previous_event_id IS NOT NULL
         AND (
           p.event_id IS NULL OR p.signal_id<>e.signal_id OR p.target_period<>e.target_period OR
           p.event_seq>=e.event_seq OR NOT (
             (p.state='pending' AND e.state IN ('settled_verified','unverifiable','disputed')) OR
             (p.state IN ('settled_verified','unverifiable') AND e.state='disputed') OR
             (p.state='disputed' AND e.state IN ('settled_verified','unverifiable'))
           )
         )
       LIMIT 50`
    );
    for (const row of chain.rows) issues.push({
      eventId: row.event_id, issue: "broken_or_invalid_audit_transition",
      previousEventId: row.previous_event_id, previousState: row.previous_state, state: row.state
    });
    return { ok: issues.length === 0, persistent: true, scanned: data.events.length,
      currentStates: [...latest.values()].length, issues };
  }

  async function exportCsv(limit = 500) {
    const data = await list(limit);
    if (!data.persistent) return { persistent: false, csv: "" };
    const columns = ["event_id","signal_id","match_id","fixture_id","league","rule_version",
      "signal_period","minute","home","away","home_sot","away_sot","recent_sot6","recent_sot10",
      "target_period","state","provider","source","settled_at","score_home","score_away",
      "signal_goals","over_line","result_goals","outcome","reason","previous_event_id"];
    const escape = value => {
      const text = value == null ? "" : value instanceof Date ? value.toISOString() : String(value);
      return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };
    const rows = [columns.join(",")];
    for (const event of data.events) rows.push(columns.map(column => escape(event[column])).join(","));
    return { persistent: true, csv: rows.join("\r\n") + "\r\n" };
  }

  return { ensureSchema, appendEvent, reconcileScoreboard, list, listCurrent, integrity, exportCsv };
}

module.exports = { TARGET_PERIODS, STATES, validateSettlementInput, gradeSignalSettlement, createCloudAlertSettlement };
