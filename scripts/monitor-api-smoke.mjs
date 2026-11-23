#!/usr/bin/env node
// End-to-end smoke test for the monitoring API.
//
// Starts a stub VictoriaMetrics (GET /api/v1/query only), boots the real app
// against it with a throwaway DATA_DIR and fake password, then checks:
//   - /api/monitor/overview and /api/monitor/hosts require a session (401 JSON)
//   - both JSON contracts (hosts joined by label, null fields for missing data)
//   - the 30s snapshot cache (second request: cached:true, no new VM queries)
//   - fallbacks: VM not configured and VM unreachable => 200 { available:false }
//
// Run `npm run build` first (the app is started from dist/).
// Usage: node scripts/monitor-api-smoke.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'dist', 'index.js');
const PASSWORD = 'smoke-monitor-password';
const SESSION_SECRET = 'smoke-monitor-session-secret-0123456789abcdef';
const CREDENTIALS_KEY = 'smoke-monitor-credentials-key-0123456789';
const VM_DELAY_MS = 80;
const START_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 10_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const HOST_FIELDS = [
  'bootTime',
  'cpu',
  'disk',
  'env',
  'fail2banBanned',
  'host',
  'icmpUp',
  'instance',
  'load1',
  'nodeUp',
  'provider',
  'ram',
  'role',
  'rttP50Ms',
  'rttP95Ms',
  'ufwBlocks1h',
  'ufwEnabled',
  'uptimeSec',
];

function series(metric, value) {
  return { metric, value: [Math.floor(Date.now() / 1000), String(value)] };
}

// Synthetic RFC 5737 hosts. gamma exists only in node-exporter, delta only in
// ICMP, so the join must keep both with nulls for the missing side.
const HOSTS = {
  alpha: {
    probe: 1,
    node: 1,
    ip: '203.0.113.10',
    nodeIp: '203.0.113.10:9100',
    provider: 'landvps',
    role: 'app',
    env: 'prod',
  },
  beta: {
    probe: 0,
    node: 0,
    ip: '203.0.113.11',
    nodeIp: '203.0.113.11:9100',
    provider: 'kyonix',
    role: 'proxy',
    env: 'prod',
  },
  gamma: {
    probe: null,
    node: 1,
    ip: null,
    nodeIp: '203.0.113.12:9100',
    provider: 'play2go',
    role: 'monitoring',
    env: 'prod',
  },
  delta: {
    probe: 1,
    node: null,
    ip: '203.0.113.13',
    nodeIp: null,
    provider: 'play2go',
    role: 'db',
    env: 'stage',
  },
};

const promValues = {
  cpu: { alpha: 12.34, beta: 56.78, gamma: 78.9 },
  ram: { alpha: 23.45, beta: 45.6, gamma: 67.8 },
  disk: { alpha: 34.56, beta: 56.7, gamma: 78.9 },
  load: { alpha: 0.42, beta: 1.5, gamma: 2.25 },
  rttP50: { alpha: 0.0123, beta: 0.0789, delta: 0.005 },
  rttP95: { alpha: 0.0456 },
  ufwOn: { alpha: 1, beta: 0, gamma: 1 },
  ufwBlocks: { alpha: 3, gamma: 0 },
  banned: { alpha: 0, beta: 2, gamma: 0 },
};

function hostMetric(name) {
  const h = HOSTS[name];
  return {
    host: name,
    provider: h.provider,
    role: h.role,
    env: h.env,
  };
}

function vectorFor(key) {
  switch (key) {
    case 'probe':
      return Object.entries(HOSTS)
        .filter(([, h]) => h.probe != null)
        .map(([name, h]) =>
          series(
            { ...hostMetric(name), job: 'blackbox-icmp', instance: h.ip },
            h.probe,
          ),
        );
    case 'rttP50':
      return Object.entries(promValues.rttP50).map(([name, value]) =>
        series({ host: name }, value),
      );
    case 'rttP95':
      return Object.entries(promValues.rttP95).map(([name, value]) =>
        series({ host: name }, value),
      );
    case 'nodeUp':
      return Object.entries(HOSTS)
        .filter(([, h]) => h.node != null)
        .map(([name, h]) =>
          series(
            { ...hostMetric(name), job: 'node-remote', instance: h.nodeIp },
            h.node,
          ),
        );
    case 'cpu':
    case 'ram':
    case 'disk':
    case 'load':
      return Object.entries(promValues[key]).map(([name, value]) =>
        series({ host: name }, value),
      );
    case 'boot': {
      const now = Math.floor(Date.now() / 1000);
      return [
        series({ host: 'alpha' }, now - 24 * 3600),
        series({ host: 'beta' }, now - 7200),
        series({ host: 'gamma' }, now - 300),
      ];
    }
    case 'ufwOn':
    case 'ufwBlocks':
    case 'banned':
      return Object.entries(promValues[key]).map(([name, value]) =>
        series({ host: name }, value),
      );
    default:
      throw new Error(`stub: unknown query key ${key}`);
  }
}

function matchQuery(query) {
  if (query.includes('quantile_over_time(0.5, probe_icmp')) return 'rttP50';
  if (query.includes('quantile_over_time(0.95, probe_icmp')) return 'rttP95';
  if (query.includes('probe_success{')) return 'probe';
  if (query.includes('node_cpu_seconds_total')) return 'cpu';
  if (query.includes('node_memory_MemAvailable_bytes')) return 'ram';
  if (query.includes('node_filesystem_avail_bytes')) return 'disk';
  if (query.includes('node_load1')) return 'load';
  if (query.includes('node_boot_time_seconds')) return 'boot';
  if (query.includes('node_security_ufw_enabled')) return 'ufwOn';
  if (query.includes('node_security_ufw_blocks_1h')) return 'ufwBlocks';
  if (query.includes('node_security_fail2ban_banned')) return 'banned';
  if (query.includes('up{job=~"node.*"')) return 'nodeUp';
  return null;
}

function createStubVm() {
  const state = { queries: 0, reads: 0, writes: 0, unmatched: [], failKey: null };

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url.split('?')[0] !== '/api/v1/query') {
      state.writes += 1;
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: 'read-only stub VM' }));
      return;
    }
    state.reads += 1;
    const url = new URL(req.url, 'http://stub');
    const query = url.searchParams.get('query') ?? '';
    const key = matchQuery(query);
    if (!key) {
      state.unmatched.push(query);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: `unmatched query: ${query}` }));
      return;
    }
    state.queries += 1;
    await delay(VM_DELAY_MS);
    if (state.failKey === key) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: `stub failure for ${key}` }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'success',
        data: { resultType: 'vector', result: vectorFor(key) },
      }),
    );
  });

  return { server, state };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function startApp(port, dataDir, vmUrl) {
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    PANEL_PASSWORD: PASSWORD,
    SESSION_SECRET,
    CREDENTIALS_KEY,
    VICTORIAMETRICS_URL: vmUrl,
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
    MONITOR_POLL_MS: '600000',
    MONITOR_SUMMARY_CRON: '0 0 1 1 *',
    TZ: 'Europe/Moscow',
  };
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  return { child, logs, port, base: `http://127.0.0.1:${port}` };
}

async function waitForApp(app) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (app.child.exitCode != null) {
      throw new Error(`app exited early (code ${app.child.exitCode})\n${app.logs.join('')}`);
    }
    try {
      const res = await fetch(`${app.base}/login`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await delay(100);
  }
  throw new Error(`app did not start in ${START_TIMEOUT_MS}ms\n${app.logs.join('')}`);
}

async function stopApp(app) {
  if (!app || app.child.exitCode != null) return;
  app.child.kill('SIGTERM');
  await Promise.race([once(app.child, 'exit'), delay(4000)]);
  if (app.child.exitCode == null) app.child.kill('SIGKILL');
  await Promise.race([once(app.child, 'exit'), delay(2000)]);
}

async function fetchJson(url, options = {}) {
  const headers = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { res, text, json };
}

async function login(app) {
  const { res, text, json } = await fetchJson(`${app.base}/api/login`, {
    method: 'POST',
    body: { password: PASSWORD },
  });
  assert.equal(res.status, 200, `login status: ${res.status} ${text}`);
  assert.equal(json?.ok, true, `login body: ${text}`);
  const setCookies =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const raw = setCookies.length ? setCookies : [res.headers.get('set-cookie') ?? ''];
  const cookie = raw
    .map((value) => value.split(';')[0])
    .find((value) => value.startsWith('sb_session='));
  assert.ok(cookie, `login cookie missing: ${raw.join(' | ')}`);
  return cookie;
}

function assertJsonResponse(result, status, label) {
  assert.equal(result.res.status, status, `${label} status ${result.res.status}: ${result.text}`);
  assert.match(
    result.res.headers.get('content-type') ?? '',
    /application\/json/,
    `${label} content-type`,
  );
}

function assertOneDecimal(value, label) {
  assert.equal(typeof value, 'number', `${label} must be a number, got ${typeof value}`);
  assert.ok(Number.isFinite(value), `${label} must be finite`);
  assert.equal(Math.round(value * 10) / 10, value, `${label} must have 1 decimal (got ${value})`);
}

function approx(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${label}: expected ${expected}, got ${actual}`,
  );
}

function validateOverview(overview) {
  assert.equal(overview.available, true, 'overview.available');
  assert.equal(overview.cached, false, 'first overview must not be cached');
  assert.equal(typeof overview.updatedAt, 'string', 'overview.updatedAt');
  assert.ok(!Number.isNaN(Date.parse(overview.updatedAt)), 'overview.updatedAt parseable');

  assert.deepEqual(overview.hosts, {
    total: 4,
    up: 3,
    down: 1,
    icmpDown: 1,
    nodeDown: 1,
  });

  assertOneDecimal(overview.averages.cpu, 'averages.cpu');
  assertOneDecimal(overview.averages.ram, 'averages.ram');
  assertOneDecimal(overview.averages.disk, 'averages.disk');
  approx(overview.averages.cpu, 49.3, 'averages.cpu');
  approx(overview.averages.ram, 45.6, 'averages.ram');
  approx(overview.averages.disk, 56.7, 'averages.disk');

  assert.deepEqual(overview.security, {
    ufwEnabled: 2,
    ufwTotal: 3,
    ufwBlocks1h: 3,
    fail2banBanned: 2,
  });

  for (const key of ['cpu', 'ram', 'disk']) {
    const top = overview.top[key];
    assert.ok(Array.isArray(top), `top.${key} array`);
    assert.equal(top.length, 3, `top.${key} length`);
    assert.equal(top[0].host, 'gamma', `top.${key} first host`);
    for (const row of top) {
      assert.equal(typeof row.host, 'string', `top.${key} host type`);
      assertOneDecimal(row.value, `top.${key} value`);
    }
  }
  approx(overview.top.cpu[1].value, 56.8, 'top.cpu beta');
  approx(overview.top.ram[0].value, 67.8, 'top.ram gamma');
  approx(overview.top.disk[2].value, 34.6, 'top.disk alpha');
}

function validateHosts(hostsResponse) {
  assert.equal(hostsResponse.available, true, 'hosts.available');
  assert.equal(hostsResponse.cached, true, 'hosts served from shared snapshot cache');
  assert.equal(typeof hostsResponse.updatedAt, 'string', 'hosts.updatedAt');
  assert.ok(Array.isArray(hostsResponse.hosts), 'hosts array');
  assert.deepEqual(
    hostsResponse.hosts.map((row) => row.host),
    ['alpha', 'beta', 'delta', 'gamma'],
    'hosts sorted and joined across sources',
  );

  for (const row of hostsResponse.hosts) {
    assert.deepEqual(
      Object.keys(row).sort(),
      [...HOST_FIELDS].sort(),
      `contract fields for ${row.host}`,
    );
  }

  const byName = Object.fromEntries(hostsResponse.hosts.map((row) => [row.host, row]));

  const alpha = byName.alpha;
  assert.equal(alpha.provider, 'landvps');
  assert.equal(alpha.role, 'app');
  assert.equal(alpha.env, 'prod');
  assert.equal(alpha.instance, '203.0.113.10');
  assert.equal(alpha.icmpUp, true);
  assertOneDecimal(alpha.rttP50Ms, 'alpha.rttP50Ms');
  assertOneDecimal(alpha.rttP95Ms, 'alpha.rttP95Ms');
  approx(alpha.rttP50Ms, 12.3, 'alpha.rttP50Ms');
  approx(alpha.rttP95Ms, 45.6, 'alpha.rttP95Ms');
  assert.equal(alpha.nodeUp, true);
  assertOneDecimal(alpha.cpu, 'alpha.cpu');
  assertOneDecimal(alpha.ram, 'alpha.ram');
  assertOneDecimal(alpha.disk, 'alpha.disk');
  assertOneDecimal(alpha.load1, 'alpha.load1');
  approx(alpha.cpu, 12.3, 'alpha.cpu');
  approx(alpha.ram, 23.5, 'alpha.ram');
  approx(alpha.disk, 34.6, 'alpha.disk');
  approx(alpha.load1, 0.4, 'alpha.load1');
  assert.ok(Number.isInteger(alpha.bootTime), 'alpha.bootTime integer');
  assert.ok(Number.isInteger(alpha.uptimeSec), 'alpha.uptimeSec integer');
  assert.ok(
    Math.abs(alpha.uptimeSec - 86_400) <= 5,
    `alpha.uptimeSec ~86400, got ${alpha.uptimeSec}`,
  );
  assert.equal(alpha.ufwEnabled, true);
  assertOneDecimal(alpha.ufwBlocks1h, 'alpha.ufwBlocks1h');
  assertOneDecimal(alpha.fail2banBanned, 'alpha.fail2banBanned');

  const beta = byName.beta;
  assert.equal(beta.icmpUp, false);
  assert.equal(beta.rttP95Ms, null, 'beta.rttP95Ms null when no sample');
  assert.equal(beta.nodeUp, false);
  assert.equal(beta.ufwEnabled, false);
  assert.equal(beta.ufwBlocks1h, null, 'beta.ufwBlocks1h null when metric absent');
  assertOneDecimal(beta.fail2banBanned, 'beta.fail2banBanned');
  approx(beta.fail2banBanned, 2, 'beta.fail2banBanned');

  const gamma = byName.gamma;
  assert.equal(gamma.icmpUp, null, 'gamma ICMP missing => null');
  assert.equal(gamma.instance, '203.0.113.12', 'node instance normalized to IP');
  assert.equal(gamma.provider, 'play2go');
  assert.equal(gamma.role, 'monitoring');
  assert.equal(gamma.env, 'prod');
  assert.equal(gamma.nodeUp, true);
  assert.equal(gamma.rttP50Ms, null);
  assert.equal(gamma.rttP95Ms, null);
  assertOneDecimal(gamma.cpu, 'gamma.cpu');
  assertOneDecimal(gamma.ufwBlocks1h, 'gamma.ufwBlocks1h');
  approx(gamma.ufwBlocks1h, 0, 'gamma.ufwBlocks1h');

  const delta = byName.delta;
  assert.equal(delta.icmpUp, true);
  assert.equal(delta.nodeUp, null, 'delta node missing => null');
  assert.equal(delta.cpu, null);
  assert.equal(delta.ram, null);
  assert.equal(delta.disk, null);
  assert.equal(delta.load1, null);
  assert.equal(delta.bootTime, null);
  assert.equal(delta.uptimeSec, null);
  assert.equal(delta.ufwEnabled, null);
  assert.equal(delta.ufwBlocks1h, null);
  assert.equal(delta.fail2banBanned, null);
  assert.equal(delta.instance, '203.0.113.13');
}

function validateUnavailable(body, label) {
  assert.equal(body.available, false, `${label}.available`);
  assert.equal(typeof body.reason, 'string', `${label}.reason`);
  assert.ok(body.reason.length > 0, `${label}.reason non-empty`);
  assert.equal(body.updatedAt, null, `${label}.updatedAt`);
  assert.equal(body.cached, false, `${label}.cached`);
  if (Array.isArray(body.hosts)) {
    assert.deepEqual(body.hosts, [], `${label}.hosts empty`);
    return;
  }
  assert.deepEqual(body.hosts, { total: 0, up: 0, down: 0, icmpDown: 0, nodeDown: 0 });
  assert.deepEqual(body.averages, { cpu: null, ram: null, disk: null });
  assert.deepEqual(body.security, {
    ufwEnabled: null,
    ufwTotal: null,
    ufwBlocks1h: null,
    fail2banBanned: null,
  });
  assert.deepEqual(body.top, { cpu: [], ram: [], disk: [] });
}

async function main() {
  if (!fs.existsSync(ENTRY)) {
    throw new Error(`missing ${ENTRY} — run "npm run build" first`);
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-api-smoke-'));
  const stub = createStubVm();
  let app = null;
  let partialApp = null;
  let fallbackNoUrl = null;
  let fallbackUnreachable = null;

  try {
    await new Promise((resolve, reject) => {
      stub.server.once('error', reject);
      stub.server.listen(0, '127.0.0.1', resolve);
    });
    const stubAddress = stub.server.address();
    const stubPort = typeof stubAddress === 'object' && stubAddress ? stubAddress.port : 0;
    const stubUrl = `http://127.0.0.1:${stubPort}`;

    const appPort = await freePort();
    app = startApp(appPort, dataDir, stubUrl);
    await waitForApp(app);
    // Let the startup ICMP alert poll finish before counting VM requests.
    await delay(250);

    const cookie = await login(app);

    // --- session guard -----------------------------------------------------
    for (const endpoint of ['overview', 'hosts']) {
      const unauthorized = await fetchJson(`${app.base}/api/monitor/${endpoint}`);
      assertJsonResponse(unauthorized, 401, `unauthorized ${endpoint}`);
      assert.deepEqual(unauthorized.json, { error: 'Unauthorized' });
    }
    const invalidSession = await fetchJson(`${app.base}/api/monitor/overview`, {
      cookie: 'sb_session=deadbeef',
    });
    assertJsonResponse(invalidSession, 401, 'invalid session');
    assert.deepEqual(invalidSession.json, { error: 'Unauthorized' });

    // --- overview: shape, values, cache ------------------------------------
    const beforeFirst = stub.state.queries;
    const firstStart = performance.now();
    const overviewFirst = await fetchJson(`${app.base}/api/monitor/overview`, { cookie });
    const firstMs = performance.now() - firstStart;
    assertJsonResponse(overviewFirst, 200, 'overview');
    validateOverview(overviewFirst.json);
    assert.ok(
      stub.state.queries > beforeFirst,
      'first overview must query VictoriaMetrics',
    );

    const queriesAfterFirst = stub.state.queries;
    const secondStart = performance.now();
    const overviewSecond = await fetchJson(`${app.base}/api/monitor/overview`, { cookie });
    const secondMs = performance.now() - secondStart;
    assertJsonResponse(overviewSecond, 200, 'overview (cached)');
    assert.equal(overviewSecond.json.cached, true, 'second overview cached');
    assert.equal(overviewSecond.json.updatedAt, overviewFirst.json.updatedAt);
    assert.equal(
      stub.state.queries,
      queriesAfterFirst,
      'cached overview must not issue new VM queries',
    );
    assert.ok(
      secondMs < firstMs,
      `cached overview must be faster (first ${firstMs.toFixed(1)}ms, second ${secondMs.toFixed(1)}ms)`,
    );

    // --- hosts: contract, join, nulls --------------------------------------
    const hostsResponse = await fetchJson(`${app.base}/api/monitor/hosts`, { cookie });
    assertJsonResponse(hostsResponse, 200, 'hosts');
    validateHosts(hostsResponse.json);

    // Only reads against VictoriaMetrics.
    assert.equal(stub.state.writes, 0, 'monitor must not write to VictoriaMetrics');
    assert.ok(stub.state.reads > 0, 'stub VM received reads');
    assert.deepEqual(stub.state.unmatched, [], 'all PromQL was matched by the stub VM');

    await stopApp(app);
    app = null;

    // --- partial VM failure: allSettled keeps the response usable ----------
    stub.state.failKey = 'cpu';
    const partialPort = await freePort();
    partialApp = startApp(partialPort, dataDir, stubUrl);
    await waitForApp(partialApp);
    const partialCookie = await login(partialApp);
    const partialOverview = await fetchJson(`${partialApp.base}/api/monitor/overview`, {
      cookie: partialCookie,
    });
    assertJsonResponse(partialOverview, 200, 'overview with one failed query');
    assert.equal(partialOverview.json.available, true, 'partial failure stays available');
    assert.equal(partialOverview.json.averages.cpu, null, 'failed CPU query => null average');
    assert.deepEqual(partialOverview.json.top.cpu, [], 'failed CPU query => empty top');
    assertOneDecimal(partialOverview.json.averages.ram, 'partial averages.ram');
    await stopApp(partialApp);
    partialApp = null;
    stub.state.failKey = null;

    // --- fallback: VM not configured ---------------------------------------
    const noUrlPort = await freePort();
    fallbackNoUrl = startApp(noUrlPort, dataDir, '');
    await waitForApp(fallbackNoUrl);
    const noUrlCookie = await login(fallbackNoUrl);

    const noUrlOverview = await fetchJson(`${fallbackNoUrl.base}/api/monitor/overview`, {
      cookie: noUrlCookie,
    });
    assertJsonResponse(noUrlOverview, 200, 'overview without VM');
    validateUnavailable(noUrlOverview.json, 'overview without VM');

    const noUrlHosts = await fetchJson(`${fallbackNoUrl.base}/api/monitor/hosts`, {
      cookie: noUrlCookie,
    });
    assertJsonResponse(noUrlHosts, 200, 'hosts without VM');
    validateUnavailable(noUrlHosts.json, 'hosts without VM');
    assert.deepEqual(noUrlHosts.json.hosts, []);

    await stopApp(fallbackNoUrl);
    fallbackNoUrl = null;

    // --- fallback: VM configured but unreachable ---------------------------
    const deadPort = await freePort();
    const deadUrl = `http://127.0.0.1:${deadPort}`;
    const deadAppPort = await freePort();
    fallbackUnreachable = startApp(deadAppPort, dataDir, deadUrl);
    await waitForApp(fallbackUnreachable);
    const deadCookie = await login(fallbackUnreachable);
    const deadOverview = await fetchJson(`${fallbackUnreachable.base}/api/monitor/overview`, {
      cookie: deadCookie,
    });
    assertJsonResponse(deadOverview, 200, 'overview with unreachable VM');
    validateUnavailable(deadOverview.json, 'overview with unreachable VM');
    assert.match(deadOverview.json.reason, /VictoriaMetrics недоступна/, 'unreachable reason');

    await stopApp(fallbackUnreachable);
    fallbackUnreachable = null;

    console.log('ok  session guard: 401 JSON without cookie');
    console.log('ok  overview: contract, counts, averages, security, top');
    console.log(`ok  cache: cached=true, no VM queries, ${firstMs.toFixed(0)}ms -> ${secondMs.toFixed(0)}ms`);
    console.log('ok  hosts: ICMP/node join, provider/role/env, nulls preserved');
    console.log('ok  read-only: no writes to VictoriaMetrics');
    console.log('ok  partial failure: 200 available:true, failed metric null');
    console.log('ok  fallback: VM not configured and unreachable => 200 available:false');
    console.log('monitor-api-smoke: PASS');
  } catch (e) {
    if (app) console.error('--- app logs ---\n' + app.logs.join(''));
    if (partialApp) console.error('--- partial app logs ---\n' + partialApp.logs.join(''));
    if (fallbackNoUrl) console.error('--- fallback logs ---\n' + fallbackNoUrl.logs.join(''));
    if (fallbackUnreachable) {
      console.error('--- fallback unreachable logs ---\n' + fallbackUnreachable.logs.join(''));
    }
    throw e;
  } finally {
    await stopApp(app);
    await stopApp(partialApp);
    await stopApp(fallbackNoUrl);
    await stopApp(fallbackUnreachable);
    await new Promise((resolve) => stub.server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('monitor-api-smoke: FAIL');
    console.error(e);
    process.exit(1);
  },
);
