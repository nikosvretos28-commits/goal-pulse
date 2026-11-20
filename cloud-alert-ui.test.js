"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("Cloud Alert dashboard script parses and includes settlement history/export UI", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const start = html.indexOf("function cloudAlertEscape");
  const end = html.indexOf("function alertHistoryKey", start);
  assert.ok(start >= 0, "Cloud Alert dashboard renderer must exist");
  assert.ok(end > start, "Cloud Alert dashboard renderer must have a bounded source block");
  const source = html.slice(start, end);
  assert.doesNotThrow(() => new vm.Script(source, { filename: "index.html:cloud-alert" }));
  assert.match(html, /id="cloudAlertSettlementHistory"/);
  assert.match(html, /\/api\/cloud-alert\/settlements\?limit=100/);
  assert.match(html, /\/api\/cloud-alert\/settlements\/export\.csv/);
  assert.match(html, /SHADOW · PUSH LOCKED/);
});
