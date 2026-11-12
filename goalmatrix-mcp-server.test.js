"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMcpServer, tokenMatches, callEliteReport, TOOL_NAME } = require("./goalmatrix-mcp-server");

test("token comparison rejects empty and mismatched values", () => {
  assert.equal(tokenMatches("", ""), false);
  assert.equal(tokenMatches("abc", "abcd"), false);
  assert.equal(tokenMatches("abc", "abc"), true);
});

test("report tool validates date before making a request", async () => {
  let called = false;
  await assert.rejects(
    callEliteReport({ date: "yesterday" }, {
      GOALMATRIX_READONLY_TOKEN: "secret"
    }, async () => { called = true; }),
    /YYYY-MM-DD/
  );
  assert.equal(called, false);
});

test("report tool calls only the allowlisted GET endpoint", async () => {
  let request;
  const result = await callEliteReport({ date: "2026-11-11" }, {
    GOALMATRIX_API_BASE_URL: "https://example.test/",
    GOALMATRIX_READONLY_TOKEN: "upstream-secret"
  }, async (url, options) => {
    request = { url: String(url), options };
    return { ok: true, status: 200, json: async () => ({ ok: true, readOnly: true, date: "2026-11-11" }) };
  });
  assert.equal(request.url, "https://example.test/api/integrations/elite-report?date=2026-11-11");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.authorization, "Bearer upstream-secret");
  assert.equal(result.readOnly, true);
});

test("MCP server requires its own bearer token", async t => {
  const server = createMcpServer({
    env: { GOALMATRIX_MCP_TOKEN: "client-secret", GOALMATRIX_READONLY_TOKEN: "upstream-secret" },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const response = await fetch("http://127.0.0.1:" + address.port + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  });
  assert.equal(response.status, 401);
});

test("MCP tools/list exposes only the read-only report tool", async t => {
  const server = createMcpServer({
    env: { GOALMATRIX_MCP_TOKEN: "client-secret", GOALMATRIX_READONLY_TOKEN: "upstream-secret" }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch("http://127.0.0.1:" + server.address().port + "/mcp", {
    method: "POST",
    headers: { authorization: "Bearer client-secret", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.result.tools.map(tool => tool.name), [TOOL_NAME]);
});
