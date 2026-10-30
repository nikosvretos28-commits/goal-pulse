# HI Activity-only history reset runbook

## Scope and safety

This procedure is for a future, explicitly approved reset of the persistent HI Activity observation history only.

- Target table: `high_activity_history`.
- Protected table: `alert_history` (contains AI and VIP alert history).
- Do not modify `protocol_analyst_reports`, push subscriptions, live scanners, alert protocols, or any other table.
- This document does not run a reset. No records are deleted by adding this runbook.
- Do not perform the reset until first-half and second-half settlement have both been verified against real completed fixtures and the project owner gives a final explicit go-ahead.
- Run the SQL manually in a database session with transaction support. Do not put it in an application endpoint, startup task, or automatic deployment hook.

## Pre-reset checks

1. Confirm the deployed application is healthy.
2. Verify a real first-half HI Activity observation settles correctly at the half-time score.
3. Verify a real second-half HI Activity observation settles correctly at the full-time score.
4. Record the row counts returned by this query:

```sql
SELECT
  (SELECT COUNT(*) FROM high_activity_history) AS hi_activity_rows_before,
  (SELECT COUNT(*) FROM alert_history) AS ai_vip_rows_before;
```

5. Confirm AI and VIP alert history is visible in the application.

## Dry run (must ROLLBACK)

This dry run takes a write-blocking lock on the HI Activity table and a write-blocking lock on the AI/VIP history table for the short duration of the transaction. This prevents concurrent writes from making the safety comparison ambiguous. It deletes only HI Activity rows, verifies that table is empty, verifies the AI/VIP row count did not change during the transaction, then rolls everything back.

```sql
BEGIN;

LOCK TABLE high_activity_history IN ACCESS EXCLUSIVE MODE;
LOCK TABLE alert_history IN SHARE MODE;

DO $$
DECLARE
  ai_vip_before BIGINT;
  ai_vip_after BIGINT;
  hi_activity_after BIGINT;
BEGIN
  SELECT COUNT(*) INTO ai_vip_before FROM alert_history;

  DELETE FROM high_activity_history;

  SELECT COUNT(*) INTO hi_activity_after FROM high_activity_history;
  SELECT COUNT(*) INTO ai_vip_after FROM alert_history;

  IF hi_activity_after <> 0 THEN
    RAISE EXCEPTION 'Safety check failed: HI Activity table is not empty';
  END IF;

  IF ai_vip_after <> ai_vip_before THEN
    RAISE EXCEPTION 'Safety check failed: AI/VIP history row count changed';
  END IF;
END
$$;

SELECT
  (SELECT COUNT(*) FROM high_activity_history) AS hi_activity_rows_inside_transaction,
  (SELECT COUNT(*) FROM alert_history) AS ai_vip_rows_inside_transaction;

ROLLBACK;
```

Expected dry-run result: HI Activity count is zero inside the transaction; AI/VIP count is unchanged. After `ROLLBACK`, the original HI Activity rows must be present again. If any SQL statement errors, stop; do not attempt a commit.

## Final execution (separate explicit approval required)

Only after the dry run succeeds, both real-fixture settlement checks pass, and the project owner gives a fresh explicit approval for the actual deletion, run the exact same transaction above again, but replace the final `ROLLBACK;` with `COMMIT;`.

Then verify:

```sql
SELECT
  (SELECT COUNT(*) FROM high_activity_history) AS hi_activity_rows_after_commit,
  (SELECT COUNT(*) FROM alert_history) AS ai_vip_rows_after_commit;
```

Expected result: `hi_activity_rows_after_commit = 0`; the AI/VIP count must equal the recorded pre-reset count. If it does not, stop and investigate; do not delete or alter any other table.

## Post-reset application check

1. Reload GoalMatrix.
2. Confirm the HI Activity history starts empty.
3. Confirm AI Alerts and VIP Alerts still show their existing history, pending items, and statistics.
4. Confirm new HI Activity observations are saved normally.

If any check fails, stop. Do not repeat the reset or change any other table.
