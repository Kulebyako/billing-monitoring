import type {
  ProviderAdapter,
  ProviderAccountCredentials,
  SyncedService,
} from './types.js';
import {
  withPersistentContext,
  fillFirst,
  clickFirst,
} from './playwright-base.js';

const DEFAULT_VM = 'https://vm.kyonix.com';
const DEFAULT_BETA = 'https://beta.kyonix.com';

type Json = Record<string, unknown>;

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[🟢🔴🟡⚪️]/gu, '')
    .replace(/\(vds\)|\(vps\)/gi, '')
    .replace(/[^a-z0-9а-яё]+/gi, '')
    .trim();
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[b.length]!;
}

/** Fuzzy match for Node.DE ↔ Noda-DE, MTProto ↔ MTProto (VDS), etc. */
function namesMatch(a: string, b: string): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  const maxLen = Math.max(x.length, y.length);
  if (maxLen >= 4 && editDistance(x, y) <= Math.max(1, Math.floor(maxLen / 5))) {
    return true;
  }
  return false;
}

function mapVmStatus(state: unknown): SyncedService['status'] {
  const s = String(state || '').toLowerCase();
  if (s === 'active' || s === 'running') return 'active';
  if (s === 'stopped' || s === 'suspended') return 'suspended';
  if (s === 'deleted') return 'deleted';
  return 'unknown';
}

function pickIp(host: Json): string | null {
  const candidates = [host.ip4, host.ip, host.ipv4, host.ip4_list, host.ip_list];
  for (const cand of candidates) {
    if (typeof cand === 'string' && cand.trim()) {
      const m = cand.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
      if (m) return m[0];
    }
    if (Array.isArray(cand)) {
      for (const item of cand) {
        if (typeof item === 'string' && item.trim()) {
          const m = item.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
          if (m) return m[0];
        }
        if (item && typeof item === 'object') {
          const obj = item as Json;
          const v = obj.ip || obj.name || obj.ip4;
          if (typeof v === 'string' && /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(v)) {
            return v.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)![0];
          }
        }
      }
    }
  }
  for (const key of ['ip_summary', 'main_ip', 'primary_ip']) {
    const v = host[key];
    if (typeof v === 'string') {
      const m = v.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
      if (m) return m[0];
    }
  }
  return null;
}

function dueDateFromIso(iso: unknown): string | null {
  if (typeof iso !== 'string' || !iso) return null;
  const d = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

function monthlyRub(svc: Json): { cost: number | null; currency: string | null } {
  const price = svc.price as Json | undefined;
  const monthly = price?.monthly as Json | undefined;
  if (monthly && typeof monthly.RUB === 'number') return { cost: monthly.RUB, currency: 'RUB' };
  if (monthly && typeof monthly.USD === 'number') return { cost: monthly.USD, currency: 'USD' };
  if (monthly && typeof monthly.EUR === 'number') return { cost: monthly.EUR, currency: 'EUR' };
  return { cost: null, currency: null };
}

/** Strip secrets before persisting provider payload. */
function sanitizeServiceRaw(svc: Json): Json {
  const copy = structuredClone(svc) as Json;
  const server = copy.server as Json | undefined;
  if (server?.config && typeof server.config === 'object') {
    const cfg = { ...(server.config as Json) };
    delete cfg.password;
    server.config = cfg;
  }
  return copy;
}

type BetaBilling = {
  balance: number | null;
  currency: string | null;
  services: SyncedService[];
};

/**
 * Billing panel https://beta.kyonix.com — JWT API (no Playwright):
 *   POST /v1/auth/login → accessToken + user.balance
 *   GET  /v1/users/me, GET /v1/services/me
 */
async function syncBetaPanel(
  credentials: ProviderAccountCredentials,
): Promise<BetaBilling> {
  const login = credentials.login;
  const password = credentials.password;
  if (!login || !password) {
    throw new Error('Kyonix beta: нужен email+password от https://beta.kyonix.com');
  }

  const root = (
    (credentials.billingUrl as string | undefined) ||
    (credentials.betaUrl as string | undefined) ||
    DEFAULT_BETA
  ).replace(/\/$/, '');

  const loginRes = await fetch(`${root}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email: login, password }),
  });
  const loginText = await loginRes.text();
  if (!loginRes.ok) {
    throw new Error(`Kyonix beta login HTTP ${loginRes.status}: ${loginText.slice(0, 200)}`);
  }

  let loginJson: Json;
  try {
    loginJson = JSON.parse(loginText) as Json;
  } catch {
    throw new Error(`Kyonix beta login: не JSON (${loginText.slice(0, 120)})`);
  }

  const token = String(loginJson.accessToken || loginJson.access_token || '');
  if (!token) {
    throw new Error('Kyonix beta: в ответе логина нет accessToken');
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };

  const [meRes, svcRes] = await Promise.all([
    fetch(`${root}/v1/users/me`, { headers }),
    fetch(`${root}/v1/services/me`, { headers }),
  ]);
  const meText = await meRes.text();
  const svcText = await svcRes.text();

  if (!meRes.ok) {
    throw new Error(`Kyonix /v1/users/me HTTP ${meRes.status}: ${meText.slice(0, 200)}`);
  }
  if (!svcRes.ok) {
    throw new Error(`Kyonix /v1/services/me HTTP ${svcRes.status}: ${svcText.slice(0, 200)}`);
  }

  const me = JSON.parse(meText) as Json;
  const loginUser = (loginJson.user || {}) as Json;
  let balance: number | null = null;
  if (typeof me.balance === 'number') balance = me.balance;
  else if (typeof loginUser.balance === 'number') balance = loginUser.balance;

  let currency: string | null = 'RUB';
  const services: SyncedService[] = [];
  const list = JSON.parse(svcText) as Json[];

  for (const svc of list) {
    if (!svc || typeof svc !== 'object') continue;
    const id = String(svc.id ?? '');
    if (!id) continue;
    // Skip non-server products if any appear later
    const type = String(svc.type || '').toUpperCase();
    if (type && type !== 'VDS' && type !== 'VPS' && type !== 'DEDICATED') continue;

    const server = (svc.server || {}) as Json;
    const externalVmId =
      server.externalVmId ?? (server.config as Json | undefined)?.externalVmId;
    const externalId =
      externalVmId != null && String(externalVmId) ? `vm:${externalVmId}` : `svc:${id}`;

    const { cost, currency: cur } = monthlyRub(svc);
    if (cur) currency = cur;
    const ip =
      typeof server.ipAddress === 'string' && server.ipAddress ? server.ipAddress : null;

    services.push({
      externalId,
      name: String(svc.name || server.name || `Service ${id}`),
      ip,
      cost,
      currency: cur || currency,
      dueAt: dueDateFromIso(svc.nextPaymentAt),
      balance,
      status: mapVmStatus(svc.status),
      billingUrl: `${root}/services/vds`,
      raw: {
        source: 'beta.kyonix.com',
        serviceId: id,
        ...sanitizeServiceRaw(svc),
      },
    });
  }

  return { balance, currency, services };
}

/**
 * Sync VMs from VMmanager 6 (vm.kyonix.com) — optional IP enrichment.
 */
async function syncVmPanel(
  credentials: ProviderAccountCredentials,
): Promise<SyncedService[]> {
  const login = credentials.login;
  const password = credentials.password;
  if (!login || !password) {
    throw new Error('Kyonix VMmanager: нужен email+password от https://vm.kyonix.com');
  }

  const base =
    (credentials.baseUrl as string | undefined) ||
    (credentials.panelUrl as string | undefined) ||
    DEFAULT_VM;
  const root = base.replace(/\/$/, '');
  const services: SyncedService[] = [];

  await withPersistentContext(`kyonix_vm_${login}`, async (page) => {
    await page.goto(`${root}/auth/login`, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });
    await page.waitForSelector('input[type="password"]', { timeout: 90_000 });

    await fillFirst(
      page,
      ['input[type="email"]', 'input[name="email"]'],
      login,
    );
    await fillFirst(page, ['input[type="password"]'], password);
    await clickFirst(page, [
      'button[type="submit"]',
      'button:has-text("Войти")',
      'button:has-text("Sign in")',
      'button:has-text("Log in")',
    ]);

    await page.waitForURL((u) => !u.pathname.includes('/auth/login'), {
      timeout: 60_000,
    }).catch(() => undefined);
    await page.waitForTimeout(2000);

    if (page.url().includes('/auth/login')) {
      throw new Error('Kyonix VMmanager: логин не удался (остались на /auth/login)');
    }

    const payload = await page.evaluate(async () => {
      const selfRes = await fetch('/auth/v4/self', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const selfText = await selfRes.text();
      const hostRes = await fetch('/vm/v3/host?orderby=id%20desc&limit=0,100', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const hostText = await hostRes.text();
      return {
        selfStatus: selfRes.status,
        selfText: selfText.slice(0, 2000),
        hostStatus: hostRes.status,
        hostText: hostText.slice(0, 100_000),
      };
    });

    if (payload.selfStatus !== 200) {
      throw new Error(`Kyonix /auth/v4/self HTTP ${payload.selfStatus}`);
    }

    if (payload.hostStatus !== 200) {
      throw new Error(`Kyonix /vm/v3/host HTTP ${payload.hostStatus}: ${payload.hostText.slice(0, 200)}`);
    }
    const hosts = JSON.parse(payload.hostText) as { list?: Json[] };
    for (const host of hosts.list || []) {
      const id = String(host.id ?? '');
      if (!id) continue;
      services.push({
        externalId: `vm:${id}`,
        name: String(host.name || `VM ${id}`),
        ip: pickIp(host),
        cost: null,
        currency: null,
        dueAt: null,
        balance: null,
        status: mapVmStatus(host.state),
        billingUrl: `${root}/vm/manager/host/list`,
        raw: host,
      });
    }
  });

  return services;
}

/**
 * Kyonix:
 * - Billing (primary): https://beta.kyonix.com JWT API (email+password) → balance, due, cost, IP
 * - Optional: vm.kyonix.com for extra VMs / IP merge
 */
export const kyonixAdapter: ProviderAdapter = {
  id: 'kyonix',
  label: 'Kyonix',

  async sync(credentials: ProviderAccountCredentials): Promise<SyncedService[]> {
    const errors: string[] = [];
    let vms: SyncedService[] = [];
    let billingServices: SyncedService[] = [];
    let accountBalance: number | null = null;
    let accountCurrency: string | null = null;

    try {
      const beta = await syncBetaPanel(credentials);
      billingServices = beta.services;
      accountBalance = beta.balance;
      accountCurrency = beta.currency;
    } catch (e) {
      errors.push(`beta: ${(e as Error).message}`);
      console.warn('[kyonix] beta panel:', (e as Error).message);
    }

    try {
      vms = await syncVmPanel(credentials);
    } catch (e) {
      errors.push(`vm: ${(e as Error).message}`);
      console.warn('[kyonix] VM panel:', (e as Error).message);
    }

    const hasBilling = accountBalance != null || billingServices.length > 0;

    // Start from beta services; merge VM-only hosts
    let out: SyncedService[] = [...billingServices];

    if (accountBalance != null) {
      for (const s of out) {
        s.balance = accountBalance;
        if (accountCurrency) s.currency = accountCurrency;
      }
      for (const vm of vms) {
        vm.balance = accountBalance;
        if (accountCurrency) vm.currency = accountCurrency;
      }
    }

    for (const vm of vms) {
      const match = out.find(
        (b) =>
          b.externalId === vm.externalId ||
          (b.ip && vm.ip && b.ip === vm.ip) ||
          namesMatch(vm.name, b.name) ||
          vm.name.toLowerCase() === b.name.toLowerCase(),
      );
      if (match) {
        if (!match.ip && vm.ip) match.ip = vm.ip;
        match.raw = {
          ...(typeof match.raw === 'object' && match.raw ? (match.raw as object) : {}),
          vm: vm.raw,
        };
      } else {
        out.push(vm);
      }
    }

    // Legacy synthetic balance rows
    out = out.filter(
      (v) =>
        v.externalId !== 'kyonix-balance' &&
        !/баланс\s*\(@kyonix/i.test(v.name),
    );

    if (!out.length) {
      throw new Error(
        `Kyonix: ничего не синхронизировано. ` +
          `Нужен email+password от https://beta.kyonix.com ` +
          (errors.length ? `| ${errors.join(' | ')}` : ''),
      );
    }

    if (!hasBilling && errors.some((e) => e.startsWith('beta:'))) {
      const billErr = errors.filter((e) => e.startsWith('beta:')).join(' | ');
      const err = new Error(
        `Kyonix ВМ ок (${out.length}), биллинг не подтянулся: ${billErr}`,
      ) as Error & { partialServices?: SyncedService[] };
      err.partialServices = out;
      throw err;
    }

    return out;
  },
};
