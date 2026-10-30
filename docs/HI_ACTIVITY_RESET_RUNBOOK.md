# HI Activity-only history reset runbook

## Scope and safety

This procedure is for a future, explicitly approved reset of the persistent HI Activity observation history only.

- Target table: `high_activity_history`.
- Do not modify `alert_history` (contains AI and VIP alert history).
- Do not modify `protocol_analyst_reports`, push subscriptions, live scanners, alert protocols, or any other table.
- This document does not run a reset. No records are deleted by adding this runbook.
- Do not perform the reset until first-half and second-half settlement have both been verified against real completed fixtures and the project owner gives a final explicit go-ahead.

## Pre-reset checks

1. Confirm the deployed application is healthy.
2. Verify a real first-half HI Activity observation settles correctly at the half-time score.
3. Verify a real second-half HI Activity observation settles correctly at the full-time score.
4. Confirm AI and VIP alert history is visible and unchanged.
5. Record the HI Activity row count before reset:

```sql
SELECT COUNT(*) AS hi_activity_rows_before
FROM high_activity_history;
```

## Reset SQL (deliberately non-committing preview)

Run only after the checks above and explicit approval. This preview deletes rows only from `high_activity_history`, then rolls the transaction back so it cannot persist a deletion:

```sql
BEGIN;

DELETE FROM high_activity_history;

SELECT COUNT(*) AS hi_activity_rows_after
FROM high_activity_history;

ROLLBACK;
```

The preview should report zero rows inside the transaction, then restore the original rows after rollback.

## Final execution

Only after the owner explicitly authorizes the actual reset, repeat the transaction above and use `COMMIT` instead of `ROLLBACK`. Then verify:

```sql
SELECT COUNT(*) AS hi_activity_rows_after_commit
FROM high_activity_history;

SELECT COUNT(*) AS ai_vip_history_rows
FROM alert_history;
```

Expected result: `hi_activity_rows_after_commit = 0`. The AI/VIP count must remain unchanged from the pre-reset count.

## Post-reset application check

1. Reload GoalMatrix.
2. Confirm the HI Activity history starts empty.
3. Confirm AI Alerts and VIP Alerts still show their existing history and statistics.
4. Confirm new HI Activity observations are saved normally.

If any check fails, stop. Do not repeat the reset or change any other table.
