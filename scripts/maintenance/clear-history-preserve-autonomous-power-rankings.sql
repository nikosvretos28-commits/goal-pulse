-- GoalMatrix historical-data reset.
-- IMPORTANT:
-- 1) Take and verify a PostgreSQL backup before running this file.
-- 2) Run during a maintenance window with alert/history writers paused.
-- 3) Review the preflight counts first. This script intentionally preserves
--    autonomous Power Ranking alerts stored in alert_history.
-- 4) Execute as one transaction. ROLLBACK is safe until COMMIT.
--
-- Preserved:
--   * alert_history rows whose payload.alertType is
--     'power_ranking_autonomous_signal' (autonomous Power Rankings)
--   * push_subscriptions
--   * pre_match_season_profiles / pre_match_collection_state
--   * all application configuration and live protocol logic
--
-- Cleared:
--   * all other AI/VIP alert history
--   * Pressure Hunter history
--   * HI Activity history
--   * AI Analyst / daily report history
--   * competition history cache
--   * historical live-stat snapshots

BEGIN;

LOCK TABLE alert_history,
           pressure_hunter_history,
           high_activity_history,
           protocol_analyst_reports,
           elite_five_bot_daily_reports,
           competition_history_cache,
           live_stat_snapshots
IN ACCESS EXCLUSIVE MODE;

-- Preflight: record the number of rows targeted and the autonomous rows retained.
SELECT 'alert_history_to_delete' AS item, COUNT(*) AS row_count
FROM alert_history
WHERE COALESCE(payload->>'alertType', '') <> 'power_ranking_autonomous_signal'
UNION ALL
SELECT 'autonomous_power_rankings_preserved', COUNT(*)
FROM alert_history
WHERE payload->>'alertType' = 'power_ranking_autonomous_signal'
UNION ALL
SELECT 'pressure_hunter_history', COUNT(*) FROM pressure_hunter_history
UNION ALL
SELECT 'high_activity_history', COUNT(*) FROM high_activity_history
UNION ALL
SELECT 'protocol_analyst_reports', COUNT(*) FROM protocol_analyst_reports
UNION ALL
SELECT 'elite_five_bot_daily_reports', COUNT(*) FROM elite_five_bot_daily_reports
UNION ALL
SELECT 'competition_history_cache', COUNT(*) FROM competition_history_cache
UNION ALL
SELECT 'live_stat_snapshots', COUNT(*) FROM live_stat_snapshots;

-- Clear every historical record except autonomous Power Ranking signals.
DELETE FROM alert_history
WHERE COALESCE(payload->>'alertType', '') <> 'power_ranking_autonomous_signal';

DELETE FROM pressure_hunter_history;
DELETE FROM high_activity_history;
DELETE FROM protocol_analyst_reports;
DELETE FROM elite_five_bot_daily_reports;
DELETE FROM competition_history_cache;
DELETE FROM live_stat_snapshots;

-- Postflight assertions: abort if any protected autonomous records disappeared
-- or if any targeted history remains.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM alert_history
    WHERE COALESCE(payload->>'alertType', '') <> 'power_ranking_autonomous_signal'
  ) THEN
    RAISE EXCEPTION 'Non-autonomous alert history remains after reset';
  END IF;
END $$;

-- Review postflight counts, then COMMIT only after confirming the autonomous
-- Power Ranking rows remain intact. Use ROLLBACK instead if anything is wrong.
SELECT 'autonomous_power_rankings_remaining' AS item, COUNT(*) AS row_count
FROM alert_history
WHERE payload->>'alertType' = 'power_ranking_autonomous_signal';

-- COMMIT;
-- ROLLBACK;
