# GoalMatrix read-only Elite AI report integration

## Endpoint

`GET /api/integrations/elite-report`

Optional query parameter: `date=YYYY-MM-DD`. If omitted, the endpoint uses the previous calendar date in `Europe/Athens`.

Authentication: send `Authorization: Bearer <token>`.

Configure `GOALMATRIX_READONLY_TOKEN` as a Railway service environment variable after merging this change. Generate a long random secret and set it only in Railway Variables; never commit it or paste it into chat. Until that variable is configured, requests are rejected.

## Scope and safety

- GET only; no refresh, writes, scanner execution, settlement, or protocol changes.
- Reads only the already stored row in `elite_five_bot_daily_reports`.
- Returns the complete stored Elite AI Daily Report JSON, its report date, and generation timestamp.
- Returns 401 for missing/invalid token, 404 when no stored report exists, and 503 when the analytics database cannot be read.
- Does not expose database credentials, admin PINs, push tokens, or other environment variables.

## Important integration boundary

This endpoint makes the report available to an authenticated server-side reader. It does not by itself register a new ChatGPT tool or grant ChatGPT browser access to the whole GoalMatrix site. A remote MCP/connector still has to be configured to call this endpoint. This first endpoint is deliberately limited to the Elite AI daily report; additional read-only page resources should be exposed as separately allowlisted tools after their data contracts are reviewed.
