"use strict";

const HISTORY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS competition_history_cache (
    league_code TEXT NOT NULL,
    season INTEGER NOT NULL,
    body JSONB NOT NULL,
    is_partial BOOLEAN NOT NULL DEFAULT FALSE,
    successful_windows INTEGER NOT NULL DEFAULT 0,
    total_windows INTEGER NOT NULL DEFAULT 0,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (league_code, season)
  );
  CREATE INDEX IF NOT EXISTS competition_history_cache_fetched_idx
    ON competition_history_cache(fetched_at DESC);
`;

function createCompetitionHistoryStore({ pool } = {}) {
  let initPromise = null;

  async function ensureTable() {
    if (!pool || typeof pool.query !== "function") return false;
    if (!initPromise) {
      initPromise = pool.query(HISTORY_TABLE_SQL).then(() => true).catch(error => {
        initPromise = null;
        throw error;
      });
    }
    return initPromise;
  }

  async function save(league, season, body) {
    if (!pool || !league || !Number.isInteger(Number(season))) return false;
    if (!body || !Array.isArray(body.matches) || body.matches.length === 0) return false;
    await ensureTable();
    const partial = body.partial === true;
    const successfulWindows = Math.max(0, Number(body.successfulWindows) || 0);
    const totalWindows = Math.max(0, Number(body.totalWindows) || 0);
    const result = await pool.query(
      `INSERT INTO competition_history_cache
        (league_code, season, body, is_partial, successful_windows, total_windows, fetched_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, NOW())
       ON CONFLICT (league_code, season) DO UPDATE SET
         body = EXCLUDED.body,
         is_partial = EXCLUDED.is_partial,
         successful_windows = EXCLUDED.successful_windows,
         total_windows = EXCLUDED.total_windows,
         fetched_at = NOW()
       WHERE competition_history_cache.is_partial = TRUE OR EXCLUDED.is_partial = FALSE
       RETURNING league_code`,
      [String(league), Number(season), JSON.stringify(body), partial, successfulWindows, totalWindows]
    );
    return Boolean(result && result.rowCount);
  }

  async function load(league, season) {
    if (!pool || !league || !Number.isInteger(Number(season))) return null;
    await ensureTable();
    const result = await pool.query(
      `SELECT body, fetched_at FROM competition_history_cache
       WHERE league_code = $1 AND season = $2`,
      [String(league), Number(season)]
    );
    const row = result && result.rows && result.rows[0];
    if (!row || !row.body || !Array.isArray(row.body.matches) || row.body.matches.length === 0) return null;
    const fetchedAt = row.fetched_at instanceof Date
      ? row.fetched_at.toISOString()
      : new Date(row.fetched_at || Date.now()).toISOString();
    return { body: row.body, fetchedAt };
  }

  return { ensureTable, save, load };
}

module.exports = { createCompetitionHistoryStore };
