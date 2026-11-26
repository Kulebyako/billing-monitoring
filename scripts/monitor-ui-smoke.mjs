#!/usr/bin/env node
// End-to-end UI smoke for the «Мониторинг» view (#/monitor).
//
// Boots a stub VictoriaMetrics and the real panel (tsx src/index.ts) on a
// throwaway DATA_DIR, then drives the page with headless Chromium (Playwright):
//   - sidebar item «Мониторинг», deep link #/monitor, active state, breadcrumb
//   - KPI cards from /api/monitor/overview (null => «—», never 0)
//   - hosts table from /api/monitor/hosts: sorting via aria-sort, provider/role
//     filters, «только проблемные», problem rows first and highlighted
//   - states: skeleton, empty list, request error, VM unavailable (available:false)
//   - last update time + «Обновить», 60s auto-refresh paused on a hidden tab
//   - 360/768/1280/1600: no page-level horizontal scroll, card list at 360,
//     drawer sidebar below 1024
//   - session required: page redirect without a session, API 401 => /login
//   - no external requests (only same-origin assets)
//
// Usage: node scripts/monitor-ui-smoke.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src', 'index.ts');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const PASSWORD = 'smoke-monitor-ui-password';
const SESSION_SECRET = 'smoke-monitor-ui-session-secret-0123456789';
const CREDENTIALS_KEY = 'smoke-monitor-ui-credentials-key-0123456789';
const START_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_TIMEOUT_MS = 15_000;
const VM_DELAY_MS = 60;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── stub VictoriaMetrics ────────────────────────────────────────────────── */

function series(metric, value) {
  return { metric, value: [Math.floor(Date.now() / 1000), String(value)] };
}

// Synthetic RFC 5737 hosts. gamma exists only in node-exporter, delta only in
// ICMP, so the panel has to render both with «—» for the missing side.
const HOSTS = {
  alpha: { probe: 1, node: 1, ip: '203.0.113.10', nodeIp: '203.0.113.10:9100', provider: 'landvps', role: 'app' },
  beta: { probe: 0, node: 0, ip: '203.0.113.11', nodeIp: '203.0.113.11:9100', provider: 'kyonix', role: 'proxy' },
  gamma: { probe: null, node: 1, ip: null, nodeIp: '203.0.113.12:9100', provider: 'play2go', role: 'monitoring' },
  delta: { probe: 1, node: null, ip: '203.0.113.13', nodeIp: null, provider: 'play2go', role: 'db' },
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

function hostLabels(name) {
  const h = HOSTS[name];
  return { host: name, provider: h.provider, role: h.role, env: 'prod' };
}

function vectorFor(key) {
  switch (key) {
    case 'probe':
      return Object.entries(HOSTS)
        .filter(([, h]) => h.probe != null)
        .map(([name, h]) => series({ ...hostLabels(name), job: 'blackbox-icmp', instance: h.ip }, h.probe));
    case 'rttP50':
      return Object.entries(promValues.rttP50).map(([name, value]) => series({ host: name }, value));
    case 'rttP95':
      return Object.entries(promValues.rttP95).map(([name, value]) => series({ host: name }, value));
    case 'nodeUp':
      return Object.entries(HOSTS)
        .filter(([, h]) => h.node != null)
        .map(([name, h]) => series({ ...hostLabels(name), job: 'node-remote', instance: h.nodeIp }, h.node));
    case 'cpu':
    case 'ram':
    case 'disk':
    case 'load':
      return Object.entries(promValues[key]).map(([name, value]) => series({ host: name }, value));
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
      return Object.entries(promValues[key]).map(([name, value]) => series({ host: name }, value));
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
  const state = { queries: 0, unmatched: [] };
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url.split('?')[0] !== '/api/v1/query') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: 'read-only stub VM' }));
      return;
    }
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
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: vectorFor(key) } }));
  });
  return { server, state };
}

/* ── app process ─────────────────────────────────────────────────────────── */

// Prefer the browser bundled with the installed Playwright (the Docker image
// ships it); fall back to a system Chrome/Chromium so the smoke also runs on
// hosts where `npx playwright install` was skipped.
const CHROME_CANDIDATES = [
  process.env.CHROMIUM_EXECUTABLE,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

async function launchBrowser() {
  const args = ['--no-sandbox', '--disable-dev-shm-usage'];
  try {
    return await chromium.launch({ headless: true, args });
  } catch (bundledError) {
    for (const candidate of CHROME_CANDIDATES) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const browser = await chromium.launch({ headless: true, executablePath: candidate, args });
        console.log(`  (browser: ${candidate})`);
        return browser;
      } catch {
        // try next candidate
      }
    }
    throw bundledError;
  }
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
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
    SYNC_CRON: '0 0 1 1 *',
    REMINDER_CRON: '0 0 1 1 *',
    PLAYWRIGHT_HEADLESS: '1',
    TZ: 'Europe/Moscow',
  };
  const child = spawn(TSX, [ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  return { child, logs, base: `http://127.0.0.1:${port}` };
}

async function waitForApp(app) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (app.child.exitCode != null) {
      throw new Error(`app exited early (code ${app.child.exitCode})\n${app.logs.join('')}`);
    }
    try {
      const res = await fetch(`${app.base}/login`, { signal: AbortSignal.timeout(1500) });
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
  await Promise.race([once(app.child, 'exit'), delay(5000)]);
  if (app.child.exitCode == null) app.child.kill('SIGKILL');
  await Promise.race([once(app.child, 'exit'), delay(2000)]);
}

async function login(app) {
  const res = await fetch(`${app.base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  assert.equal(res.status, 200, `login status: ${res.status} ${text}`);
  const raw =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const values = raw.length ? raw : [res.headers.get('set-cookie') ?? ''];
  const cookie = values.map((value) => value.split(';')[0]).find((value) => value.startsWith('sb_session='));
  assert.ok(cookie, `login cookie missing: ${values.join(' | ')}`);
  return cookie;
}

function cookiePair(raw) {
  const index = raw.indexOf('=');
  return { name: raw.slice(0, index), value: raw.slice(index + 1) };
}

/* ── page helpers ────────────────────────────────────────────────────────── */

function trackExternal(context, base) {
  const external = [];
  context.on('request', (request) => {
    const url = request.url();
    if (url.startsWith(base) || url.startsWith('data:') || url.startsWith('about:')) return;
    external.push(url);
  });
  return external;
}

async function waitForFunction(page, fn, label, timeout = PAGE_TIMEOUT_MS) {
  try {
    await page.waitForFunction(fn, null, { timeout, polling: 100 });
  } catch (e) {
    throw new Error(`${label} (${String(e.message || e).split('\n')[0]})`);
  }
}

async function waitUntil(predicate, label, timeout = PAGE_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`timeout: ${label}`);
}

async function kpiMap(page) {
  return page.$$eval('#monitor-kpi > div', (cells) =>
    Object.fromEntries(
      cells.map((cell) => [
        (cell.querySelector('.kpi-label')?.textContent ?? '').trim(),
        (cell.querySelector('.kpi-value')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      ]),
    ),
  );
}

async function dataRows(page) {
  const rows = await page.$$eval('#monitor-hosts-body tr[role="row"]', (trs) =>
    trs.map((tr) => {
      const cells = {};
      for (const td of tr.querySelectorAll('td[data-label]')) {
        cells[td.getAttribute('data-label')] = (td.textContent ?? '').replace(/\s+/g, ' ').trim();
      }
      return { className: tr.className, cells };
    }),
  );
  return rows.filter((row) => row.cells['Хост']);
}

function rowByHost(rows, prefix) {
  const row = rows.find((item) => item.cells['Хост'].startsWith(prefix));
  assert.ok(row, `row «${prefix}» not found; hosts: ${rows.map((r) => r.cells['Хост']).join(', ')}`);
  return row;
}

function expectCell(rows, host, label, expected) {
  const row = rowByHost(rows, host);
  assert.equal(row.cells[label], expected, `${host} · ${label}`);
}

function expectKpi(kpis, label, expected) {
  assert.equal(kpis[label], expected, `KPI «${label}»`);
}

async function clickMonitorRefresh(page) {
  await page.locator('#monitor-refresh').click();
}

/* ── main ────────────────────────────────────────────────────────────────── */

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-ui-smoke-'));
  const stub = createStubVm();
  const vmPort = await listen(stub.server);
  const appPort = await freePort();
  const app = startApp(appPort, path.join(tmp, 'data'), `http://127.0.0.1:${vmPort}`);
  let browser = null;
  let failures = 0;

  const step = async (label, fn) => {
    try {
      await fn();
      console.log(`  ok   ${label}`);
    } catch (e) {
      failures += 1;
      const message = String((e && e.message) || e).split('\n').slice(0, 4).join('\n       ');
      console.error(`  FAIL ${label}\n       ${message}`);
    }
  };

  try {
    await waitForApp(app);
    const cookie = cookiePair(await login(app));
    const metaRes = await fetch(`${app.base}/api/meta`, {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const meta = await metaRes.json();
    assert.ok(Array.isArray(meta.providers) && meta.providers.length > 0, 'meta.providers пуст');
    const providerLabels = new Map(meta.providers.map((provider) => [provider.id, provider.label]));

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ru-RU' });
    await context.addCookies([
      { name: cookie.name, value: cookie.value, url: app.base, httpOnly: true, sameSite: 'Lax' },
    ]);
    const external = trackExternal(context, app.base);
    const pageErrors = [];
    const page = await context.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    let monitorRequests = 0;
    page.on('request', (request) => {
      if (request.url().includes('/api/monitor/overview')) monitorRequests += 1;
    });

    await page.goto(`${app.base}/`, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
    await page.locator('#nav a[data-view="monitor"]').waitFor({ state: 'attached' });

    await step('сайдбар: пункт «Мониторинг» с deep link #/monitor и активным состоянием', async () => {
      const navLink = page.locator('#nav a[data-view="monitor"]');
      assert.equal((await navLink.textContent()).replace(/\s+/g, ' ').trim(), 'Мониторинг');
      assert.equal(await navLink.getAttribute('href'), '#/monitor');
      assert.equal(await navLink.getAttribute('aria-current'), null);

      // Первый заход: ответы API придерживаем, чтобы увидеть скелетон.
      await page.route('**/api/monitor/**', async (route) => {
        await delay(400);
        await route.continue();
      });
      await navLink.click();
      await waitForFunction(
        page,
        () => location.hash === '#/monitor' && document.querySelectorAll('#monitor-hosts-body .skeleton-block').length > 0,
        'hash #/monitor + скелетон загрузки',
      );
      await page.unroute('**/api/monitor/**');

      assert.equal(await navLink.getAttribute('aria-current'), 'page');
      assert.equal((await page.locator('#breadcrumb').textContent()).trim(), 'Мониторинг');
      assert.match(await page.title(), /^Мониторинг — /);
      // Пункт остаётся активным после перезагрузки по deep link.
      // /api/meta намеренно медленнее снимка: без перерисовки в fillProviders
      // подписи провайдеров остались бы сырыми id до следующего рендера.
      await page.route('**/api/meta', async (route) => {
        await delay(600);
        await route.continue();
      });
      await page.reload({ waitUntil: 'load' });
      await waitForFunction(
        page,
        () =>
          document.querySelectorAll('#monitor-kpi .kpi-value').length === 8 &&
          document.querySelectorAll('#monitor-hosts-body tr td[data-label="Хост"]').length === 4,
        'KPI и строки после deep link',
      );
      assert.equal(
        await page.locator('#nav a[data-view="monitor"]').getAttribute('aria-current'),
        'page',
        'deep link сохраняет активный пункт',
      );

      // /api/meta мог прийти позже снимка мониторинга: подписи провайдеров
      // обязаны перерисоваться из meta.providers label, а не остаться сырыми id.
      assert.notEqual(providerLabels.get('play2go'), 'play2go', 'meta отдаёт человекочитаемый label');
      const providerCell = (prefix) =>
        page.evaluate((host) => {
          const row = [...document.querySelectorAll('#monitor-hosts-body tr')].find((tr) =>
            (tr.querySelector('td[data-label="Хост"]')?.textContent ?? '').includes(host),
          );
          return row ? (row.querySelector('td[data-label="Провайдер"]')?.textContent ?? '').trim() : '';
        }, prefix);
      await waitUntil(
        async () => (await providerCell('gamma')) === providerLabels.get('play2go'),
        'подпись провайдера gamma из /api/meta',
      );
      assert.equal(await providerCell('alpha'), providerLabels.get('landvps'), 'alpha provider label');
      assert.equal(await providerCell('beta'), providerLabels.get('kyonix'), 'beta provider label');
      const optionLabel = (id) =>
        page.$eval(`#monitor-provider option[value="${id}"]`, (el) => el.textContent.trim());
      assert.equal(await optionLabel('play2go'), providerLabels.get('play2go'), 'option play2go');
      assert.equal(await optionLabel('landvps'), providerLabels.get('landvps'), 'option landvps');
      await page.unroute('**/api/meta');
    });

    await step('KPI из /api/monitor/overview: up, ICMP, node-exporter, CPU/RAM/диск, fail2ban, UFW', async () => {
      await waitForFunction(
        page,
        () => document.querySelectorAll('#monitor-hosts-body tr td[data-label="Хост"]').length === 4,
        '4 строки хостов',
      );
      const kpis = await kpiMap(page);
      assert.equal(Object.keys(kpis).length, 8, `KPI ячеек: ${Object.keys(kpis).length}`);
      expectKpi(kpis, 'Хосты up', '3 / 4');
      expectKpi(kpis, 'ICMP недоступны', '1');
      expectKpi(kpis, 'node-exporter недоступен', '1');
      expectKpi(kpis, 'Средний CPU', '49,3 %');
      expectKpi(kpis, 'Средняя RAM', '45,6 %');
      expectKpi(kpis, 'Средний диск', '56,7 %');
      expectKpi(kpis, 'fail2ban забанено', '2');
      expectKpi(kpis, 'UFW блокировок за 1ч', '3');
    });

    await step('таблица хостов: колонки, RTT в мс, null как «—», проблемные сверху и выделены', async () => {
      const rows = await dataRows(page);
      assert.equal(rows.length, 4);
      assert.ok(rows[0].className.includes('is-fail'), 'первая строка — проблемная (is-fail)');
      assert.ok(rows[0].cells['Хост'].startsWith('beta'), 'проблемный beta сверху');
      assert.ok(rows[0].cells['Хост'].includes('проблема'), 'метка «проблема»');

      expectCell(rows, 'beta', 'ICMP', 'down');
      expectCell(rows, 'beta', 'node-exporter', 'down');
      expectCell(rows, 'beta', 'RTT p50', '78,9 мс');
      expectCell(rows, 'beta', 'RTT p95', '—');
      expectCell(rows, 'beta', 'CPU %', '56,8 %');
      expectCell(rows, 'beta', 'RAM %', '45,6 %');
      expectCell(rows, 'beta', 'Диск %', '56,7 %');
      expectCell(rows, 'beta', 'load1', '1,5');
      expectCell(rows, 'beta', 'Аптайм', '2 ч 0 мин');

      expectCell(rows, 'alpha', 'ICMP', 'up');
      expectCell(rows, 'alpha', 'RTT p50', '12,3 мс');
      expectCell(rows, 'alpha', 'RTT p95', '45,6 мс');
      expectCell(rows, 'alpha', 'Аптайм', '1 д 0 ч');

      // delta есть только в ICMP: все node-метрики обязаны быть «—», а не 0.
      expectCell(rows, 'delta', 'ICMP', 'up');
      expectCell(rows, 'delta', 'node-exporter', '—');
      expectCell(rows, 'delta', 'CPU %', '—');
      expectCell(rows, 'delta', 'RAM %', '—');
      expectCell(rows, 'delta', 'Диск %', '—');
      expectCell(rows, 'delta', 'load1', '—');
      expectCell(rows, 'delta', 'Аптайм', '—');
      assert.ok(!rows.some((row) => /^0(,0)? %$/.test(row.cells['CPU %'] || '')), 'нет CPU 0 % у хостов без метрики');

      // null-ячейки помечены data-empty (на десктопе «—» остаётся видимым).
      const deltaCells = await page.evaluate(() => {
        const row = [...document.querySelectorAll('#monitor-hosts-body tr')].find((tr) =>
          (tr.querySelector('td[data-label="Хост"]')?.textContent ?? '').includes('delta'),
        );
        return [...row.querySelectorAll('td[data-label]')].map((td) => ({
          label: td.getAttribute('data-label'),
          empty: td.hasAttribute('data-empty'),
          display: getComputedStyle(td).display,
          text: (td.textContent ?? '').replace(/\s+/g, ' ').trim(),
        }));
      });
      const emptyLabels = deltaCells.filter((cell) => cell.empty).map((cell) => cell.label).sort();
      assert.deepEqual(
        emptyLabels,
        ['RTT p95', 'node-exporter', 'CPU %', 'RAM %', 'Диск %', 'load1', 'Аптайм'].sort(),
        `data-empty: ${emptyLabels.join(', ')}`,
      );
      assert.ok(
        deltaCells.filter((cell) => cell.empty).every((cell) => cell.display !== 'none'),
        'на десктопе data-empty-ячейки видны',
      );
      assert.ok(
        deltaCells.filter((cell) => cell.empty).every((cell) => cell.text === '—'),
        'в data-empty-ячейках «—»',
      );

      // gamma есть только в node-exporter: ICMP and RTT без данных.
      expectCell(rows, 'gamma', 'ICMP', '—');
      expectCell(rows, 'gamma', 'RTT p50', '—');
      expectCell(rows, 'gamma', 'CPU %', '78,9 %');
      assert.ok(rowByHost(rows, 'gamma').cells['Провайдер'].length > 0, 'провайдер заполнен');

      // up/down компактны, расшифровка живёт в title (доступно мышью и AT).
      const icmpTitles = await page.$$eval('#monitor-hosts-body td[data-label="ICMP"] .badge', (els) =>
        els.map((el) => el.getAttribute('title')),
      );
      assert.ok(icmpTitles.includes('ICMP: хост не отвечает'), `title ICMP: ${icmpTitles.join(' | ')}`);
      const nodeTitles = await page.$$eval('#monitor-hosts-body td[data-label="node-exporter"] .badge', (els) =>
        els.map((el) => el.getAttribute('title')),
      );
      assert.ok(nodeTitles.includes('node-exporter не отвечает'), `title node: ${nodeTitles.join(' | ')}`);
    });

    await step('сортировка числовых колонок: aria-sort ascending/descending и сброс', async () => {
      const cpuTh = page.locator('#monitor-hosts thead th[data-sort-key="cpu"]');
      const cpuButton = cpuTh.locator('button');
      assert.equal(await page.locator('#monitor-hosts thead th[aria-sort="ascending"]').count(), 0);

      await cpuButton.click();
      await waitForFunction(
        page,
        () => document.querySelector('#monitor-hosts thead th[data-sort-key="cpu"]').getAttribute('aria-sort') === 'ascending',
        'aria-sort ascending у CPU',
      );
      let rows = await dataRows(page);
      assert.ok(rows[0].cells['Хост'].startsWith('alpha'), `asc первая строка: ${rows[0].cells['Хост']}`);
      assert.ok(rows[rows.length - 1].cells['Хост'].startsWith('delta'), 'null-значения всегда последние');

      await cpuButton.click();
      await waitForFunction(
        page,
        () => document.querySelector('#monitor-hosts thead th[data-sort-key="cpu"]').getAttribute('aria-sort') === 'descending',
        'aria-sort descending у CPU',
      );
      rows = await dataRows(page);
      assert.ok(rows[0].cells['Хост'].startsWith('gamma'), `desc первая строка: ${rows[0].cells['Хост']}`);
      assert.ok(rows[rows.length - 1].cells['Хост'].startsWith('delta'), 'null остаются последними и при desc');

      await cpuButton.click();
      await waitForFunction(
        page,
        () => document.querySelector('#monitor-hosts thead th[data-sort-key="cpu"]').getAttribute('aria-sort') === 'none',
        'сброс сортировки',
      );
      rows = await dataRows(page);
      assert.ok(rows[0].cells['Хост'].startsWith('beta'), 'после сброса снова проблемные сверху');

      // Все th с scope, у sortable-колонок есть aria-sort и кнопка.
      const headers = await page.$$eval('#monitor-hosts thead th', (ths) =>
        ths.map((th) => ({
          scope: th.getAttribute('scope'),
          sort: th.getAttribute('aria-sort'),
          button: Boolean(th.querySelector('button.th-sort')),
        })),
      );
      assert.equal(headers.length, 12);
      for (const header of headers) {
        assert.equal(header.scope, 'col');
        assert.ok(['none', 'ascending', 'descending'].includes(header.sort));
        assert.ok(header.button, 'в каждом th есть кнопка сортировки');
      }
    });

    await step('фильтры по провайдеру/роли, «только проблемные», пустой результат и сброс', async () => {
      assert.equal(await page.locator('#monitor-reset').isHidden(), true, 'сброс скрыт без фильтров');

      await page.selectOption('#monitor-provider', 'play2go');
      await waitForFunction(page, () => document.querySelectorAll('#monitor-hosts-body tr td[data-label="Хост"]').length === 2, '2 хоста play2go');
      assert.equal((await page.locator('#monitor-hosts-count').textContent()).trim(), '2 из 4');
      assert.equal(await page.locator('#monitor-reset').isVisible(), true);

      await page.selectOption('#monitor-role', 'db');
      await waitForFunction(page, () => document.querySelectorAll('#monitor-hosts-body tr td[data-label="Хост"]').length === 1, '1 хост db');
      let rows = await dataRows(page);
      assert.ok(rows[0].cells['Хост'].startsWith('delta'));

      // kyonix + db = пусто: состояние «Ничего не найдено» с кнопкой сброса.
      await page.selectOption('#monitor-provider', 'kyonix');
      await waitForFunction(
        page,
        () => {
          const body = document.getElementById('monitor-hosts-body');
          return body.textContent.includes('Ничего не найдено');
        },
        'пустой результат фильтров',
      );
      assert.ok(await page.locator('[data-monitor-reset]').count(), 'кнопка «Сбросить фильтры»');
      await page.locator('[data-monitor-reset]').click();
      await waitForFunction(page, () => document.querySelectorAll('#monitor-hosts-body tr td[data-label="Хост"]').length === 4, 'сброс фильтров');
      assert.equal(await page.locator('#monitor-reset').isHidden(), true);

      await page.locator('#monitor-problems').check();
      await waitForFunction(page, () => document.querySelectorAll('#monitor-hosts-body tr td[data-label="Хост"]').length === 1, 'только проблемные');
      rows = await dataRows(page);
      assert.ok(rows[0].cells['Хост'].startsWith('beta'), 'единственный проблемный — beta');
      await page.locator('#monitor-problems').uncheck();
      await waitForFunction(page, () => document.querySelectorAll('#monitor-hosts-body tr td[data-label="Хост"]').length === 4, 'все хосты');
    });

    await step('видимое время обновления и кнопка «Обновить» перезапрашивают API', async () => {
      const meta = (await page.locator('#monitor-meta').textContent()).replace(/\s+/g, ' ').trim();
      assert.match(meta, /Обновлено: \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}/, `meta: ${meta}`);
      assert.match(meta, /автообновление раз в 60/);
      assert.equal((await page.locator('#monitor-refresh [data-refresh-label]').textContent()).trim(), 'Обновить');

      const before = monitorRequests;
      await clickMonitorRefresh(page);
      await waitUntil(async () => monitorRequests > before, 'запрос /api/monitor/overview после «Обновить»');
      await waitForFunction(page, () => !document.getElementById('monitor-refresh').disabled, 'кнопка снова активна');
    });

    await step('mock API с null-метриками: KPI и ячейки показывают «—», а не 0', async () => {
      const updatedAt = new Date().toISOString();
      const nullOverview = {
        available: true,
        updatedAt,
        cached: false,
        hosts: { total: 1, up: 1, down: 0, icmpDown: null, nodeDown: null },
        averages: { cpu: null, ram: null, disk: null },
        security: { ufwEnabled: null, ufwTotal: null, ufwBlocks1h: null, fail2banBanned: null },
        top: { cpu: [], ram: [], disk: [] },
      };
      const nullHosts = {
        available: true,
        updatedAt,
        cached: false,
        hosts: [
          {
            host: 'null-host',
            provider: null,
            role: null,
            env: null,
            instance: null,
            icmpUp: true,
            rttP50Ms: null,
            rttP95Ms: null,
            nodeUp: null,
            cpu: null,
            ram: null,
            disk: null,
            load1: null,
            bootTime: null,
            uptimeSec: null,
            ufwEnabled: null,
            ufwBlocks1h: null,
            fail2banBanned: null,
          },
        ],
      };
      await page.route('**/api/monitor/overview', (route) => route.fulfill({ json: nullOverview }));
      await page.route('**/api/monitor/hosts', (route) => route.fulfill({ json: nullHosts }));
      await clickMonitorRefresh(page);
      await waitForFunction(
        page,
        () => document.querySelectorAll('#monitor-hosts-body tr td[data-label="Хост"]').length === 1,
        'замоканный ответ применён',
      );

      const kpis = await kpiMap(page);
      expectKpi(kpis, 'ICMP недоступны', '—');
      expectKpi(kpis, 'node-exporter недоступен', '—');
      expectKpi(kpis, 'Средний CPU', '—');
      expectKpi(kpis, 'Средняя RAM', '—');
      expectKpi(kpis, 'Средний диск', '—');
      expectKpi(kpis, 'fail2ban забанено', '—');
      expectKpi(kpis, 'UFW блокировок за 1ч', '—');
      assert.ok(!Object.values(kpis).includes('0 %'), 'null не превращается в 0 %');

      const rows = await dataRows(page);
      assert.ok(rows[0].cells['Хост'].startsWith('null-host'));
      expectCell(rows, 'null-host', 'CPU %', '—');
      expectCell(rows, 'null-host', 'RAM %', '—');
      expectCell(rows, 'null-host', 'Диск %', '—');
      expectCell(rows, 'null-host', 'RTT p50', '—');
      expectCell(rows, 'null-host', 'load1', '—');
      expectCell(rows, 'null-host', 'Аптайм', '—');
      expectCell(rows, 'null-host', 'ICMP', 'up');

      await page.unroute('**/api/monitor/overview');
      await page.unroute('**/api/monitor/hosts');
      await clickMonitorRefresh(page);
      await waitForFunction(page, () => document.querySelectorAll('#monitor-hosts-body tr td[data-label="Хост"]').length === 4, 'возврат к живым данным');
    });

    await step('причины «проблемы»: текст на бейдже, полный список в title/aria-label, легенда с порогом', async () => {
      // Легенда живёт рядом с таблицей и называет правило с порогом из
      // MONITOR_PROBLEM_PCT (90), а не из копии числа в вёрстке.
      const legend = (await page.locator('#monitor-legend').textContent()).replace(/\s+/g, ' ').trim();
      assert.equal(
        legend,
        'Проблема: ICMP или node-exporter недоступны; CPU, RAM или диск ≥ 90%',
        `легенда: ${legend}`,
      );
      const legendVisible = await page.locator('#monitor-legend').isVisible();
      assert.ok(legendVisible, 'легенда видна рядом с таблицей');

      // Живые данные: beta проблемная по ICMP и node-exporter — причина не
      // прячется в title, а читается прямо на бейдже.
      const live = await page.evaluate(() => {
        const row = [...document.querySelectorAll('#monitor-hosts-body tr')].find((tr) =>
          (tr.querySelector('td[data-label="Хост"]')?.textContent ?? '').includes('beta'),
        );
        const flag = row?.querySelector('.monitor-flag');
        return flag
          ? {
              text: (flag.textContent ?? '').replace(/\s+/g, ' ').trim(),
              title: flag.getAttribute('title'),
              aria: flag.getAttribute('aria-label'),
            }
          : null;
      });
      assert.ok(live, 'у проблемного beta есть бейдж');
      assert.equal(live.text, 'проблема · ICMP down · node down', `видимый текст бейджа: ${live.text}`);
      assert.match(live.title, /^Проблема: ICMP недоступен; node-exporter недоступен$/, `title: ${live.title}`);
      assert.equal(live.aria, live.title, 'aria-label повторяет полный список причин');

      const updatedAt = new Date().toISOString();
      const mkHost = (over) => ({
        host: 'host',
        provider: 'landvps',
        role: 'app',
        env: 'prod',
        instance: null,
        icmpUp: true,
        rttP50Ms: 1,
        rttP95Ms: 2,
        nodeUp: true,
        cpu: 10,
        ram: 20,
        disk: 30,
        load1: 0.1,
        bootTime: null,
        uptimeSec: 100,
        ufwEnabled: 1,
        ufwBlocks1h: 0,
        fail2banBanned: 0,
        ...over,
      });
      const reasonHosts = {
        available: true,
        updatedAt,
        cached: false,
        hosts: [
          mkHost({ host: 'ok-host', cpu: 89, ram: 89.9, disk: 89 }),
          mkHost({ host: 'disk-host', disk: 95 }),
          mkHost({ host: 'multi-host', icmpUp: false, nodeUp: false, cpu: 95, ram: 96, disk: 97 }),
        ],
      };
      await page.route('**/api/monitor/hosts', (route) => route.fulfill({ json: reasonHosts }));
      await clickMonitorRefresh(page);
      await waitForFunction(
        page,
        () => document.querySelectorAll('#monitor-hosts-body tr td[data-label="Хост"]').length === 3,
        'замоканные строки с причинами',
      );

      const rows = await page.$$eval('#monitor-hosts-body tr[role="row"]', (trs) =>
        trs
          .filter((tr) => tr.querySelector('td[data-label="Хост"]'))
          .map((tr) => {
            const cell = tr.querySelector('td[data-label="Хост"]');
            const flag = cell.querySelector('.monitor-flag');
            return {
              host: (cell.querySelector('.truncate')?.textContent ?? '').trim(),
              isFail: tr.classList.contains('is-fail'),
              flag: flag
                ? {
                    text: (flag.textContent ?? '').replace(/\s+/g, ' ').trim(),
                    title: flag.getAttribute('title'),
                    aria: flag.getAttribute('aria-label'),
                  }
                : null,
            };
          }),
      );
      assert.equal(rows.length, 3, `строк: ${rows.length}`);
      const byHost = (prefix) => {
        const row = rows.find((item) => item.host.startsWith(prefix));
        assert.ok(row, `строка «${prefix}» не найдена: ${rows.map((r) => r.host).join(', ')}`);
        return row;
      };

      // Диск 95% — причина видимым текстом; полный список и порог в title/aria.
      const disk = byHost('disk-host');
      assert.ok(disk.isFail, 'disk-host подсвечен как проблемный');
      assert.ok(disk.flag, 'у disk-host есть бейдж');
      assert.equal(disk.flag.text, 'проблема · диск 95%', `бейдж disk-host: ${disk.flag.text}`);
      assert.match(disk.flag.title, /^Проблема: диск 95% \(порог 90%\)$/, `title disk-host: ${disk.flag.title}`);
      assert.equal(disk.flag.aria, disk.flag.title, 'aria-label disk-host содержит причину');

      // Больше двух причин: первые две + «+N», полный список — в title/aria.
      const multi = byHost('multi-host');
      assert.equal(multi.flag.text, 'проблема · ICMP down · node down +3', `бейдж multi-host: ${multi.flag.text}`);
      assert.match(
        multi.flag.title,
        /^Проблема: ICMP недоступен; node-exporter недоступен; CPU 95% \(порог 90%\); RAM 96% \(порог 90%\); диск 97% \(порог 90%\)$/,
        `title multi-host: ${multi.flag.title}`,
      );
      assert.equal(multi.flag.aria, multi.flag.title, 'aria-label multi-host содержит все причины');

      // Здоровый хост (все значения ниже порога) бейджа не получает.
      const healthy = byHost('ok-host');
      assert.equal(healthy.flag, null, 'у ok-host нет бейджа');
      assert.ok(!healthy.isFail, 'ok-host не подсвечен');
      const firstHealthy = rows.findIndex((row) => !row.flag);
      assert.ok(rows.slice(0, firstHealthy).every((row) => row.flag), 'проблемные строки сверху');

      // 360/768/1280/1600: длинные причины не переполняют ни карточку, ни
      // страницу; легенда переносится и остаётся в экране.
      for (const width of [360, 768, 1280, 1600]) {
        await page.setViewportSize({ width, height: 900 });
        await delay(250);
        const layout = await page.evaluate(() => {
          const doc = document.documentElement;
          const overflowing = [];
          for (const tr of document.querySelectorAll('#monitor-hosts-body tr')) {
            const cell = tr.querySelector('td[data-label="Хост"]');
            const flag = cell?.querySelector('.monitor-flag');
            if (!flag) continue;
            const cellRect = cell.getBoundingClientRect();
            const flagRect = flag.getBoundingClientRect();
            const cardRect = tr.getBoundingClientRect();
            const host = (cell.querySelector('.truncate')?.textContent ?? '').trim();
            if (flagRect.right > cellRect.right + 1 || flagRect.left < cellRect.left - 1) {
              overflowing.push(`${host}: бейдж вне ячейки`);
            }
            if (flagRect.right > cardRect.right + 1 || flagRect.left < cardRect.left - 1) {
              overflowing.push(`${host}: бейдж вне карточки`);
            }
            if (flag.scrollWidth > flag.clientWidth + 1) {
              overflowing.push(`${host}: текст бейджа обрезан (${flag.scrollWidth} > ${flag.clientWidth})`);
            }
          }
          const legendEl = document.getElementById('monitor-legend');
          const legendRect = legendEl.getBoundingClientRect();
          return {
            pageOverflow: doc.scrollWidth - doc.clientWidth,
            overflowing,
            legendOverflow: legendEl.scrollWidth - legendEl.clientWidth,
            legendFits: legendRect.width > 0 && legendRect.right <= doc.clientWidth + 1,
          };
        });
        const at = `${width}px`;
        assert.ok(layout.pageOverflow <= 1, `${at}: страница не скроллится по горизонтали (${layout.pageOverflow}px)`);
        assert.deepEqual(layout.overflowing, [], `${at}: ${layout.overflowing.join('; ')}`);
        assert.ok(layout.legendOverflow <= 1, `${at}: легенда переносится без обрезки (${layout.legendOverflow}px)`);
        assert.ok(layout.legendFits, `${at}: легенда помещается в экран`);

        // MONITOR_UI_SCREENSHOT_DIR — кадры состояния с причинами для ревью дизайна.
        if (process.env.MONITOR_UI_SCREENSHOT_DIR && (width === 360 || width === 1280)) {
          fs.mkdirSync(process.env.MONITOR_UI_SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({
            path: path.join(process.env.MONITOR_UI_SCREENSHOT_DIR, `monitor-reasons-${width}.png`),
            fullPage: true,
          });
        }
      }

      await page.setViewportSize({ width: 1280, height: 900 });
      await delay(200);
      await page.unroute('**/api/monitor/hosts');
      await clickMonitorRefresh(page);
      await waitForFunction(
        page,
        () => document.querySelectorAll('#monitor-hosts-body tr td[data-label="Хост"]').length === 4,
        'возврат к живым данным после причин',
      );
    });

    await step('пустой список хостов: понятное пустое состояние вместо таблицы', async () => {
      const updatedAt = new Date().toISOString();
      await page.route('**/api/monitor/overview', (route) =>
        route.fulfill({
          json: {
            available: true,
            updatedAt,
            cached: false,
            hosts: { total: 0, up: 0, down: 0, icmpDown: 0, nodeDown: 0 },
            averages: { cpu: null, ram: null, disk: null },
            security: { ufwEnabled: null, ufwTotal: null, ufwBlocks1h: null, fail2banBanned: null },
            top: { cpu: [], ram: [], disk: [] },
          },
        }),
      );
      await page.route('**/api/monitor/hosts', (route) =>
        route.fulfill({ json: { available: true, updatedAt, cached: false, hosts: [] } }),
      );
      await clickMonitorRefresh(page);
      await waitForFunction(
        page,
        () => document.getElementById('monitor-hosts-body').textContent.includes('Хостов нет'),
        'пустой список',
      );
      assert.equal(await page.locator('#monitor-hosts-body tr td[data-label="Хост"]').count(), 0);
      assert.equal((await page.locator('#monitor-hosts-count').textContent()).trim(), '—');
      await page.unroute('**/api/monitor/overview');
      await page.unroute('**/api/monitor/hosts');
      await clickMonitorRefresh(page);
      await waitForFunction(page, () => document.querySelectorAll('#monitor-hosts-body tr td[data-label="Хост"]').length === 4, 'данные вернулись');
    });

    await step('состояние «VM недоступна» (available:false): баннер с причиной, без пустой таблицы', async () => {
      const reason = 'VictoriaMetrics недоступна: connect ECONNREFUSED 127.0.0.1:8428';
      await page.route('**/api/monitor/**', (route) => {
        const isHosts = route.request().url().includes('/hosts');
        route.fulfill({
          json: isHosts
            ? { available: false, reason, updatedAt: null, cached: false, hosts: [] }
            : {
                available: false,
                reason,
                updatedAt: null,
                cached: false,
                hosts: { total: 0, up: 0, down: 0, icmpDown: 0, nodeDown: 0 },
                averages: { cpu: null, ram: null, disk: null },
                security: { ufwEnabled: null, ufwTotal: null, ufwBlocks1h: null, fail2banBanned: null },
                top: { cpu: [], ram: [], disk: [] },
              },
        });
      });
      await clickMonitorRefresh(page);
      await waitForFunction(
        page,
        () => !document.getElementById('monitor-banner').hidden && document.getElementById('monitor-banner-title').textContent.includes('VictoriaMetrics'),
        'баннер VM недоступна',
      );
      assert.match(await page.locator('#monitor-banner-text').textContent(), /ECONNREFUSED/);
      const offlineMeta = (await page.locator('#monitor-meta').textContent()).replace(/\s+/g, ' ').trim();
      assert.match(offlineMeta, /Данные недоступны/, `offline meta: ${offlineMeta}`);
      assert.match(offlineMeta, /проверено: \d{2}:\d{2}:\d{2}/, `offline meta: ${offlineMeta}`);
      assert.ok(!offlineMeta.includes('Обновлено'), 'при available:false нет подставленного времени снимка');
      assert.equal(await page.locator('#monitor-summary').isHidden(), true, 'KPI скрыт');
      assert.equal(await page.locator('#monitor-table-card').isHidden(), true, 'таблица скрыта');
      assert.equal(await page.locator('#monitor-refresh').isEnabled(), true, 'кнопка «Обновить» доступна');
      assert.equal((await page.locator('#monitor-banner-retry').textContent()).trim(), 'Обновить');

      await page.unroute('**/api/monitor/**');
      await page.locator('#monitor-banner-retry').click();
      await waitForFunction(
        page,
        () => document.getElementById('monitor-banner').hidden && document.querySelectorAll('#monitor-hosts-body tr td[data-label="Хост"]').length === 4,
        'возврат после VM недоступна',
      );
    });

    await step('ошибка запроса: баннер с понятным текстом и повтор', async () => {
      await page.route('**/api/monitor/**', (route) => route.abort());
      await clickMonitorRefresh(page);
      await waitForFunction(
        page,
        () => !document.getElementById('monitor-banner').hidden && document.getElementById('monitor-banner-title').textContent.includes('Не удалось'),
        'баннер ошибки запроса',
      );
      assert.match(await page.locator('#monitor-banner-text').textContent(), /Нет связи с сервером/);
      await page.unroute('**/api/monitor/**');
      await page.locator('#monitor-banner-retry').click();
      await waitForFunction(page, () => document.getElementById('monitor-banner').hidden, 'ошибка снята');
    });

    await step('адаптив 360/768/1280/1600: без горизонтального скролла страницы', async () => {
      const expected = [
        { width: 360, height: 800, sidebarHidden: 'true', card: true },
        { width: 768, height: 1024, sidebarHidden: 'true', card: false },
        { width: 1280, height: 900, sidebarHidden: null, card: false },
        { width: 1600, height: 1000, sidebarHidden: null, card: false },
      ];
      for (const viewport of expected) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await delay(200);
        const layout = await page.evaluate(() => {
          const doc = document.documentElement;
          const sidebar = document.getElementById('sidebar');
          const drawer = document.getElementById('drawer-btn');
          const table = document.getElementById('monitor-hosts');
          const wrap = table.closest('.table-wrap');
          const thead = table.querySelector('thead');
          const hostCell = table.querySelector('tbody td[data-label="Хост"]');
          return {
            pageOverflow: doc.scrollWidth - doc.clientWidth,
            sidebarHidden: sidebar.getAttribute('aria-hidden'),
            drawerVisible: getComputedStyle(drawer).display !== 'none',
            theadPosition: getComputedStyle(thead).position,
            wrapOverflowX: getComputedStyle(wrap).overflowX,
            wrapOverflow: wrap.scrollWidth - wrap.clientWidth,
            cardLabel: hostCell ? getComputedStyle(hostCell, '::before').content : '',
            rows: table.querySelectorAll('tbody tr td[data-label="Хост"]').length,
          };
        });
        const at = `${viewport.width}px`;
        assert.ok(layout.pageOverflow <= 1, `${at}: страница не скроллится по горизонтали (${layout.pageOverflow}px)`);
        assert.equal(layout.rows, 4, `${at}: строки таблицы на месте`);
        if (viewport.card) {
          assert.equal(layout.sidebarHidden, 'true', `${at}: сайдбар в drawer-режиме`);
          assert.equal(layout.drawerVisible, true, `${at}: кнопка меню видна`);
          assert.equal(layout.theadPosition, 'absolute', `${at}: таблица в карточном режиме`);
          assert.match(layout.cardLabel, /Хост/, `${at}: подписи ячеек в карточках`);
        } else if (viewport.width < 1024) {
          assert.equal(layout.sidebarHidden, 'true', `${at}: сайдбар в drawer-режиме`);
          assert.equal(layout.drawerVisible, true, `${at}: кнопка меню видна`);
          assert.equal(layout.wrapOverflowX, 'auto', `${at}: горизонтальный скролл только внутри .table-wrap`);
        } else {
          assert.equal(layout.sidebarHidden, null, `${at}: сайдбар закреплён`);
          assert.equal(layout.drawerVisible, false, `${at}: кнопка меню скрыта`);
          assert.ok(layout.wrapOverflow <= 1, `${at}: таблица помещается без скролла (${layout.wrapOverflow}px)`);
        }
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await delay(150);
    });

    // MONITOR_UI_SCREENSHOT_DIR=/tmp/shots — сохранить кадры вида для ревью дизайна.
    if (process.env.MONITOR_UI_SCREENSHOT_DIR) {
      const dir = process.env.MONITOR_UI_SCREENSHOT_DIR;
      fs.mkdirSync(dir, { recursive: true });
      await page.setViewportSize({ width: 1280, height: 900 });
      await delay(200);
      await page.screenshot({ path: path.join(dir, 'monitor-1280.png'), fullPage: true });
      await page.setViewportSize({ width: 360, height: 800 });
      await delay(200);
      await page.screenshot({ path: path.join(dir, 'monitor-360.png'), fullPage: true });
      await page.setViewportSize({ width: 1280, height: 900 });
      await delay(150);
    }

    await step('карточный режим: бейджи не растягиваются, пустые ячейки скрыты, сортировка через select', async () => {
      await page.setViewportSize({ width: 360, height: 800 });
      await delay(200);
      const card = await page.evaluate(() => {
        const statusCell = document.querySelector('#monitor-hosts-body td[data-label="ICMP"]');
        const badges = [...document.querySelectorAll('#monitor-hosts-body td.cell-status .badge')].map((el) => {
          const rect = el.getBoundingClientRect();
          const cell = el.closest('td').getBoundingClientRect();
          return {
            text: (el.textContent ?? '').trim(),
            width: Math.round(rect.width * 10) / 10,
            cellWidth: Math.round(cell.width * 10) / 10,
            justify: getComputedStyle(el).justifySelf,
          };
        });
        const deltaRow = [...document.querySelectorAll('#monitor-hosts-body tr')].find((tr) =>
          (tr.querySelector('td[data-label="Хост"]')?.textContent ?? '').includes('delta'),
        );
        const emptyCells = [...deltaRow.querySelectorAll('td[data-empty]')];
        return {
          statusCellWidth: statusCell ? Math.round(statusCell.getBoundingClientRect().width) : 0,
          badges,
          emptyCount: emptyCells.length,
          emptyDisplays: [...new Set(emptyCells.map((td) => getComputedStyle(td).display))],
          sortDisplay: getComputedStyle(document.getElementById('monitor-sort')).display,
        };
      });
      assert.ok(card.badges.length >= 2, `статус-бейджей: ${card.badges.length}`);
      for (const badge of card.badges) {
        assert.equal(badge.justify, 'start', `justify-self бейджа «${badge.text}»`);
        assert.ok(
          badge.width >= 38 && badge.width <= 64,
          `ширина бейджа «${badge.text}»: ${badge.width}px (ожидалось компактно ~40–54)`,
        );
        assert.ok(
          badge.width <= badge.cellWidth - 60,
          `бейдж «${badge.text}» не растянут: ${badge.width}px из ${badge.cellWidth}px`,
        );
      }
      assert.ok(card.emptyCount >= 6, `data-empty в карточке: ${card.emptyCount}`);
      assert.deepEqual(card.emptyDisplays, ['none'], 'null-ячейки скрыты в карточном режиме');
      assert.equal(card.sortDisplay, 'block', 'select «Сортировка» показан на <768');
      console.log(`  (360px бейджи: ${card.badges.map((badge) => `${badge.text}=${badge.width}px`).join(', ')})`);

      // 767 — верхняя граница карточного режима: бейджи такие же компактные.
      await page.setViewportSize({ width: 767, height: 1000 });
      await delay(200);
      const badges767 = await page.evaluate(() =>
        [...document.querySelectorAll('#monitor-hosts-body td.cell-status .badge')].map(
          (el) => Math.round(el.getBoundingClientRect().width * 10) / 10,
        ),
      );
      assert.ok(badges767.length > 0, 'бейджи на 767');
      assert.ok(
        badges767.every((width) => width >= 38 && width <= 64),
        `767px: ширины бейджей ${badges767.join(', ')}`,
      );
      const empty767 = await page.evaluate(() => {
        const cells = [...document.querySelectorAll('#monitor-hosts-body td[data-empty]')];
        return [...new Set(cells.map((td) => getComputedStyle(td).display))];
      });
      assert.deepEqual(empty767, ['none'], 'на 767 null-ячейки тоже скрыты');
      await page.setViewportSize({ width: 360, height: 800 });
      await delay(200);

      // Tab-обход: скрытые sort-кнопки thead не должны ловить фокус.
      await page.locator('#monitor-refresh').focus();
      const stops = [];
      for (let i = 0; i < 30; i += 1) {
        await page.keyboard.press('Tab');
        const info = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return {
            id: el.id,
            sortButton: el.classList.contains('th-sort'),
            visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden',
          };
        });
        if (!info) break;
        stops.push(info);
        if (info.id === 'monitor-sort') break;
      }
      assert.ok(stops.length > 0, 'Tab не двигает фокус');
      assert.ok(!stops.some((stop) => stop.sortButton), 'sort-кнопки thead вне tab-порядка в карточном режиме');
      assert.ok(stops.every((stop) => stop.visible), 'нет остановок Tab на невидимых элементах');
      assert.ok(stops.some((stop) => stop.id === 'monitor-sort'), 'select «Сортировка» достижим с клавиатуры');
      const ring = await page.evaluate(() => {
        const el = document.getElementById('monitor-sort');
        const cs = getComputedStyle(el);
        return { outline: cs.outlineStyle, width: cs.outlineWidth, shadow: cs.boxShadow };
      });
      assert.ok(
        ring.outline !== 'none' || (ring.shadow && ring.shadow !== 'none'),
        `видимый фокус-ринг на «Сортировка»: outline=${ring.outline} ${ring.width}, shadow=${ring.shadow}`,
      );

      // 12 колонок + сброс: select сортирует и возвращает «проблемные сверху».
      const values = await page.$$eval('#monitor-sort option', (options) => options.map((option) => option.value));
      assert.equal(values.filter(Boolean).length, 12, `колонок в сортировке: ${values.filter(Boolean).length}`);
      assert.equal(values.length, 13, `опций сортировки: ${values.length}`);
      await page.selectOption('#monitor-sort', 'cpu');
      await waitForFunction(
        page,
        () => (document.querySelector('#monitor-hosts-body tr td[data-label="Хост"]')?.textContent ?? '').includes('alpha'),
        'сортировка по CPU из select',
      );
      await page.selectOption('#monitor-sort', '');
      await waitForFunction(
        page,
        () => (document.querySelector('#monitor-hosts-body tr td[data-label="Хост"]')?.textContent ?? '').includes('beta'),
        'сброс сортировки из select',
      );
      await page.setViewportSize({ width: 1280, height: 900 });
      await delay(200);
    });

    await step('внешних запросов нет: только same-origin ассеты', async () => {
      assert.deepEqual(external, [], `внешние запросы: ${external.join(', ')}`);
      assert.deepEqual(pageErrors, [], `js-ошибки: ${pageErrors.join(' | ')}`);
    });

    await step('автообновление раз в 60 с с паузой при скрытой вкладке', async () => {
      const clockContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ru-RU' });
      await clockContext.addCookies([
        { name: cookie.name, value: cookie.value, url: app.base, httpOnly: true, sameSite: 'Lax' },
      ]);
      const clockPage = await clockContext.newPage();
      let overviewRequests = 0;
      clockPage.on('request', (request) => {
        if (request.url().includes('/api/monitor/overview')) overviewRequests += 1;
      });
      await clockPage.addInitScript(() => {
        Object.defineProperty(window, '__forceHidden', { value: false, writable: true, configurable: true });
        try {
          Object.defineProperty(Document.prototype, 'hidden', {
            configurable: true,
            get() {
              return window.__forceHidden === true;
            },
          });
          Object.defineProperty(Document.prototype, 'visibilityState', {
            configurable: true,
            get() {
              return window.__forceHidden === true ? 'hidden' : 'visible';
            },
          });
        } catch {
          // getter недоступен — тест ниже сообщит об этом.
        }
      });
      await clockPage.clock.install();
      await clockPage.goto(`${app.base}/#/monitor`, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
      await waitUntil(
        async () =>
          overviewRequests >= 1 &&
          (await clockPage.evaluate(
            () => document.querySelectorAll('#monitor-hosts-body tr td[data-label="Хост"]').length === 4,
          )),
        'первичная загрузка мониторинга',
      );

      await clockPage.clock.fastForward(61_000);
      await waitUntil(async () => overviewRequests >= 2, 'автообновление через 60 с');

      await clockPage.evaluate(() => {
        window.__forceHidden = true;
      });
      const afterHidden = overviewRequests;
      await clockPage.clock.fastForward(61_000);
      await delay(500);
      assert.equal(overviewRequests, afterHidden, 'скрытая вкладка не обновляется');

      await clockPage.evaluate(() => {
        window.__forceHidden = false;
      });
      await clockPage.clock.fastForward(61_000);
      await waitUntil(async () => overviewRequests > afterHidden, 'обновление после возврата на вкладку');

      await clockContext.close();
    });

    await step('сессия обязательна: без cookie / → /login', async () => {
      const anon = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const anonExternal = trackExternal(anon, app.base);
      const anonPage = await anon.newPage();
      await anonPage.goto(`${app.base}/`, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
      await waitForFunction(anonPage, () => location.pathname === '/login', 'редирект / → /login');
      assert.equal(new URL(anonPage.url()).pathname, '/login', `url: ${anonPage.url()}`);
      assert.equal(await anonPage.locator('#login').count(), 1, 'форма входа отрисована');
      assert.deepEqual(anonExternal, []);
      await anon.close();
    });

    await step('401 от /api/monitor => редирект на /login как в остальной панели', async () => {
      const expiring = cookiePair(await login(app));
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addCookies([{ name: expiring.name, value: expiring.value, url: app.base, httpOnly: true, sameSite: 'Lax' }]);
      const ctxPage = await ctx.newPage();
      await ctxPage.goto(`${app.base}/#/monitor`, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
      await waitForFunction(
        ctxPage,
        () => document.querySelectorAll('#monitor-hosts-body tr td[data-label="Хост"]').length === 4,
        'мониторинг загружен под сессией',
      );
      // Сессия умирает на сервере (истекла/отозвана) — API отвечает 401 JSON.
      const logout = await fetch(`${app.base}/api/logout`, {
        method: 'POST',
        headers: { cookie: `${expiring.name}=${expiring.value}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      assert.equal(logout.status, 200, `logout: ${logout.status}`);
      await ctxPage.locator('#monitor-refresh').click();
      await waitForFunction(ctxPage, () => location.pathname === '/login', 'редирект 401 → /login');
      assert.equal(new URL(ctxPage.url()).pathname, '/login', `url: ${ctxPage.url()}`);
      assert.equal(await ctxPage.locator('#login').count(), 1, 'форма входа отрисована');
      await ctx.close();
    });

    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopApp(app);
    await new Promise((resolve) => stub.server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\nmonitor UI smoke FAILED: ${failures}`);
    return 1;
  }
  console.log('\nmonitor UI smoke passed');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
