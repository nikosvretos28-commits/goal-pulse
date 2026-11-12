"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3001);
const MCP_PROTOCOL_VERSION = "2025-03-26";
const MAX_BODY_BYTES = 64 * 1024;
const TOOL_NAME = "get_elite_ai_daily_report";

function tokenMatches(supplied, expected) {
  const a = Buffer.from(String(supplied || ""));
  const b = Buffer.from(String(expected || ""));
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON");
    error.status = 400;
    throw error;
  }
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function callEliteReport(args, env, fetchImpl) {
  const date = args?.date;
  if (date !== undefined && (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
    throw new Error("date must use YYYY-MM-DD");
  }
  const base = String(env.GOALMATRIX_API_BASE_URL || "https://goalmatrix-production.up.railway.app").replace(/\/$/, "");
  const url = new URL(base + "/api/integrations/elite-report");
  if (date) url.searchParams.set("date", date);
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      authorization: "Bearer " + String(env.GOALMATRIX_READONLY_TOKEN || ""),
      accept: "application/json"
    },
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const safeMessage = response.status === 404
      ? "No stored Elite AI daily report exists for that date."
      : response.status === 401
        ? "The upstream read-only credential was rejected."
        : "GoalMatrix report service returned HTTP " + response.status + ".";
    throw new Error(safeMessage);
  }
  return body;
}

function createMcpServer(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, { ok: true, service: "goalmatrix-readonly-mcp" });
    }
    if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "Not found" });
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "cache-control": "no-store" });
      return res.end();
    }
    if (!tokenMatches((req.headers.authorization || "").replace(/^Bearer\s+/i, ""), env.GOALMATRIX_MCP_TOKEN)) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }

    let message;
    try {
      message = await readJson(req);
    } catch (error) {
      return sendJson(res, error.status || 400, { error: error.message });
    }
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return sendJson(res, 400, rpcError(message?.id, -32600, "Invalid Request"));
    }
    if (message.method === "notifications/initialized" || message.method.startsWith("notifications/")) {
      res.writeHead(202, { "cache-control": "no-store" });
      return res.end();
    }
    const id = message.id;
    if (id === undefined) return sendJson(res, 400, rpcError(null, -32600, "Request id required"));

    if (message.method === "initialize") {
      return sendJson(res, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "goalmatrix-readonly", version: "1.0.0" }
        }
      });
    }
    if (message.method === "ping") {
      return sendJson(res, 200, { jsonrpc: "2.0", id, result: {} });
    }
    if (message.method === "tools/list") {
      return sendJson(res, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [{
            name: TOOL_NAME,
            description: "Read the already-stored GoalMatrix Elite AI daily report. This tool never triggers report generation or changes live alerts.",
            inputSchema: {
              type: "object",
              properties: {
                date: { type: "string", pattern: "^\d{4}-\d{2}-\d{2}$", description: "Optional report date in Europe/Athens calendar, YYYY-MM-DD." }
              },
              additionalProperties: false
            }
          }]
        }
      });
    }
    if (message.method === "tools/call") {
      const params = message.params || {};
      if (params.name !== TOOL_NAME) {
        return sendJson(res, 200, rpcError(id, -32602, "Unknown tool"));
      }
      try {
        const report = await callEliteReport(params.arguments || {}, env, fetchImpl);
        return sendJson(res, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(report) }],
            structuredContent: report,
            isError: false
          }
        });
      } catch (error) {
        return sendJson(res, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: error.message }],
            isError: true
          }
        });
      }
    }
    return sendJson(res, 200, rpcError(id, -32601, "Method not found"));
  });
  return server;
}

if (require.main === module) {
  if (!process.env.GOALMATRIX_MCP_TOKEN || !process.env.GOALMATRIX_READONLY_TOKEN) {
    console.error("Missing required MCP authentication configuration.");
    process.exit(1);
  }
  createMcpServer().listen(PORT, "0.0.0.0", () => {
    console.log("GoalMatrix read-only MCP server listening on port " + PORT);
  });
}

module.exports = { createMcpServer, tokenMatches, callEliteReport, MCP_PROTOCOL_VERSION, TOOL_NAME };
