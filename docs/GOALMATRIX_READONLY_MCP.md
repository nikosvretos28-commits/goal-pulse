# GoalMatrix read-only MCP reader

This is a separate, independently deployable MCP service. It does not alter the main GoalMatrix web process or any live alert/protocol code.

## Deploy as a separate Railway service

- Root directory: repository root
- Start command: `node goalmatrix-mcp-server.js`
- Runtime: Node.js 24
- Public endpoint: `https://<new-mcp-service-domain>/mcp`
- Health check path: `/healthz`

## Required Railway variables

- `GOALMATRIX_MCP_TOKEN`: a new random secret used by the MCP client to authenticate to this service.
- `GOALMATRIX_READONLY_TOKEN`: the existing secret configured on the GoalMatrix main service, copied securely from a secret manager if available. Never commit it or put it in a URL.
- `GOALMATRIX_API_BASE_URL`: optional; defaults to `https://goalmatrix-production.up.railway.app`.

The two tokens are intentionally separate. The MCP service authenticates its caller with `GOALMATRIX_MCP_TOKEN` and uses `GOALMATRIX_READONLY_TOKEN` only for its server-to-server request to GoalMatrix.

## MCP capability

The service implements stateless Streamable HTTP JSON-RPC over POST at `/mcp` and exposes exactly one tool:

- `get_elite_ai_daily_report(date?)`: reads the already-stored Elite AI report for the requested Athens calendar date, or the upstream default date when omitted.

It does not expose arbitrary URLs, SQL, environment variables, admin actions, writes, report generation, scanners, settlement, or live alert controls. A 404 from the upstream means no stored report exists for that date.

## Validation

Run:

```sh
node --test goalmatrix-mcp-server.test.js
```

This service is prepared for a remote MCP client. Registering it in ChatGPT still depends on the user's available ChatGPT plan and connector controls; deploying this service alone does not create that connection.
