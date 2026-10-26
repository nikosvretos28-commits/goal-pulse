#!/usr/bin/env node
'use strict';

// Goal Pulse AI Doctor: read-only diagnostics. It never edits files, restarts
// services, deletes history, or prints secret values.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const checks = [];
const add = (name, status, detail) => checks.push({ name, status, detail });
const exists = (p) => fs.existsSync(path.join(root, p));

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); }
  catch (error) { return { __error: error.message }; }
}

const pkg = readJson('package.json');
if (pkg.__error) {
  add('package.json', 'FAIL', 'Missing or invalid JSON: ' + pkg.__error);
} else {
  add('package.json', 'PASS', 'Valid JSON');
  if (pkg.scripts && pkg.scripts.start) add('start script', 'PASS', pkg.scripts.start);
  else add('start script', 'FAIL', 'package.json has no scripts.start');
  for (const dep of ['pg', 'web-push']) {
    if ((pkg.dependencies && pkg.dependencies[dep]) || (pkg.devDependencies && pkg.devDependencies[dep])) {
      add('dependency: ' + dep, 'PASS', 'Declared in package.json');
    } else {
      add('dependency: ' + dep, 'WARN', 'Not declared; verify whether it is required');
    }
  }
}

if (!exists('server.js')) {
  add('server.js', 'FAIL', 'Entry-point file is missing');
} else {
  const syntax = spawnSync(process.execPath, ['--check', path.join(root, 'server.js')], {
    cwd: root, encoding: 'utf8', timeout: 15000
  });
  if (syntax.error) add('server.js syntax', 'FAIL', syntax.error.message);
  else if (syntax.status === 0) add('server.js syntax', 'PASS', 'Node syntax check passed');
  else add('server.js syntax', 'FAIL', (syntax.stderr || syntax.stdout || 'Node syntax check failed').trim().slice(0, 1200));
}

const port = Number(process.env.PORT || 3000);
if (Number.isInteger(port) && port > 0 && port < 65536) {
  add('PORT configuration', 'PASS', 'A valid port is configured (' + (process.env.PORT ? 'environment' : 'default') + ')');
} else {
  add('PORT configuration', 'FAIL', 'PORT must be an integer between 1 and 65535');
}

if (process.env.DATABASE_URL) {
  add('database configuration', 'PASS', 'DATABASE_URL is present; value hidden');
} else if (process.env.PGHOST || process.env.PGDATABASE) {
  add('database configuration', 'PASS', 'PostgreSQL connection fields are present; values hidden');
} else {
  add('database configuration', 'WARN', 'No PostgreSQL connection variables detected; verify whether this deployment requires a database');
}

if (process.env.PITCHAPI_API_KEY || process.env.PITCHAPI_KEY) {
  add('live-data API key', 'PASS', 'A likely PitchAPI key variable is present; value hidden');
} else {
  add('live-data API key', 'WARN', 'No common PitchAPI key variable detected; verify the exact variable name used by server.js');
}

async function checkHealthUrl() {
  const url = process.env.GOAL_PULSE_HEALTH_URL;
  if (!url) {
    add('deployed health endpoint', 'SKIP', 'Set GOAL_PULSE_HEALTH_URL to check the deployed app. No URL was assumed.');
    return;
  }
  let parsed;
  try { parsed = new URL(url); }
  catch { add('deployed health endpoint', 'FAIL', 'GOAL_PULSE_HEALTH_URL is not a valid URL'); return; }
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    add('deployed health endpoint', 'FAIL', 'Health URL must use HTTP or HTTPS'); return;
  }
  try {
    const startedAt = performance.now();
    const response = await fetch(parsed, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
    const headerMs = Math.round(performance.now() - startedAt);
    const body = await response.arrayBuffer();
    const totalMs = Math.round(performance.now() - startedAt);
    const status = response.status;
    if (status >= 200 && status < 400) add('deployed health endpoint', 'PASS', 'HTTP ' + status);
    else add('deployed health endpoint', 'FAIL', 'HTTP ' + status + ' returned by configured URL');
    const warnMs = Number(process.env.GOAL_PULSE_WARN_RESPONSE_MS || 1500);
    const failMs = Number(process.env.GOAL_PULSE_FAIL_RESPONSE_MS || 4000);
    const detail = 'headers ' + headerMs + ' ms; full response ' + totalMs + ' ms; ' + body.byteLength + ' bytes';
    if (totalMs >= failMs) add('site response speed', 'WARN', detail + ' — slow response; investigate server load, API calls, and caching');
    else if (totalMs >= warnMs) add('site response speed', 'WARN', detail + ' — slower than target; aim for under ' + warnMs + ' ms');
    else add('site response speed', 'PASS', detail + ' — within the ' + warnMs + ' ms target');
  } catch (error) {
    add('deployed health endpoint', 'FAIL', 'Request failed: ' + (error.name === 'TimeoutError' ? 'timed out after 8 seconds' : error.message));
  }
}

function printReport() {
  const rank = { FAIL: 0, WARN: 1, SKIP: 2, PASS: 3 };
  for (const item of checks) {
    const label = item.status.padEnd(4);
    console.log('[' + label + '] ' + item.name + ' — ' + item.detail);
  }
  const counts = checks.reduce((a, item) => (a[item.status] = (a[item.status] || 0) + 1, a), {});
  console.log('\nGoal Pulse AI Doctor: ' + (counts.FAIL ? 'ISSUES FOUND' : counts.WARN ? 'CHECK WARNINGS' : 'BASIC CHECKS PASSED'));
  console.log(checks.length + ' checks | ' + (counts.PASS || 0) + ' pass | ' + (counts.WARN || 0) + ' warnings | ' + (counts.FAIL || 0) + ' failures | ' + (counts.SKIP || 0) + ' skipped');
  if (counts.FAIL) process.exitCode = 1;
}

checkHealthUrl().then(printReport).catch((error) => {
  add('doctor execution', 'FAIL', error.message);
  printReport();
});
