import type {
  ProviderAdapter,
  ProviderAccountCredentials,
  SyncedService,
  ServiceStatus,
} from './types.js';
import {
  withPersistentContext,
  fillFirst,
  clickFirst,
  parseMoney,
  CHROME_UA,
} from './playwright-base.js';

type HsvdsPrice = {
  PerDay?: string | number;
  PerMonth?: string | number;
  Currency?: string;
};

type HsvdsVm = {
  ID?: number | string;
  Name?: string;
  VMState?: string;
  IPs?: Array<{ IP?: string }>;
  FullPrice?: HsvdsPrice;
  Flavor?: { vCPU?: number; RAM?: number; Disk?: number };
  ImageName?: string;
  ImageOS?: string;
};

type HsvdsProfile = {
  user?: {
    points?: string | number;
    currency?: string;
    expenses?: Record<string, { PerDay?: string | number; Amount?: number }>;
  };
};

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') return parseMoney(v);
  return null;
}

function mapStatus(state: string | undefined): ServiceStatus {
  const s = (state || '').toLowerCase();
  if (/active|running|on/i.test(s)) return 'active';
  if (/suspend|block|shutoff|stop|off|error/i.test(s)) return 'suspended';
  if (/delet|termin/i.test(s)) return 'deleted';
  return s ? 'unknown' : 'active';
}

function estimateDueAt(balance: number | null, dailyBurn: number | null): string | null {
  if (balance == null || dailyBurn == null || dailyBurn <= 0 || balance <= 0) return null;
  const days = Math.floor(balance / dailyBurn);
  const due = new Date();
  due.setDate(due.getDate() + days);
  return due.toISOString().slice(0, 10);
}

function totalExpensesPerDay(profile: HsvdsProfile): number | null {
  const expenses = profile.user?.expenses;
  if (!expenses || typeof expenses !== 'object') return null;
  let sum = 0;
  let any = false;
  for (const part of Object.values(expenses)) {
    const d = num(part?.PerDay);
    if (d != null) {
      sum += d;
      any = true;
    }
  }
  return any ? sum : null;
}

async function csrfHeaders(page: import('playwright').Page): Promise<Record<string, string>> {
  const csrf = await page
    .evaluate(() => document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '')
    .catch(() => '');
  const headers: Record<string, string> = {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (csrf) headers['X-CSRF-Token'] = csrf;
  return headers;
}

async function apiJson<T>(
  page: import('playwright').Page,
  url: string,
  method: 'GET' | 'POST' = 'GET',
): Promise<T | null> {
  const headers = await csrfHeaders(page);
  const resp = await page.request.fetch(url, { method, headers });
  if (!resp.ok()) return null;
  const text = await resp.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function parseBalanceFromUi(text: string): number | null {
  // Navbar topup link: "597,56 ₽"
  const m = text.match(/(\d[\d\s]*[.,]\d+)\s*₽/);
  return m ? parseMoney(m[1]) : null;
}

/**
 * HSVDS — prepaid daily billing from account balance.
 * LK: https://hsvds.ru/login/ → /server/
 * API: /apiv1/user/profile/ (points = balance), /apiv1/vm/list/
 */
export const hsvdsAdapter: ProviderAdapter = {
  id: 'hsvds',
  label: 'HSVDS',

  async sync(credentials: ProviderAccountCredentials): Promise<SyncedService[]> {
    const login = credentials.login;
    const password = credentials.password;
    if (!login || !password) throw new Error('HSVDS requires login and password');

    const base = ((credentials.baseUrl as string | undefined) || 'https://hsvds.ru').replace(
      /\/$/,
      '',
    );
    const loginUrl = `${base}/login/`;
    const serverUrl = `${base}/server/`;
    const out: SyncedService[] = [];

    await withPersistentContext(
      `hsvds_${login}`,
      async (page) => {
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page
          .waitForSelector(
            'input[placeholder="Email"], input[placeholder="Пароль"], input[type="password"]',
            { timeout: 20_000 },
          )
          .catch(() => undefined);

        // Already logged in (persistent session) redirects off /login/
        const needsLogin =
          page.url().includes('/login') ||
          (await page.locator('input[placeholder="Пароль"], input[type="password"]').count()) > 0;

        if (needsLogin) {
          const filledEmail = await fillFirst(
            page,
            [
              'input[placeholder="Email"]',
              'input[placeholder="email"]',
              'input[type="email"]',
              'input[name="email"]',
            ],
            login,
          );
          if (!filledEmail) {
            throw new Error('HSVDS: email field not found on /login/');
          }
          await fillFirst(page, ['input[placeholder="Пароль"]', 'input[type="password"]'], password);

          const loginRespPromise = page
            .waitForResponse(
              (r) =>
                r.url().includes('/apiv1/user/login-common') && r.request().method() === 'POST',
              { timeout: 30_000 },
            )
            .catch(() => null);

          await clickFirst(page, [
            'button.vds-button:has-text("Вход")',
            'button.btn-primary:has-text("Вход")',
            'button:has-text("Вход")',
            'button[type="submit"]',
          ]);

          const loginResp = await loginRespPromise;
          if (loginResp) {
            const body = await loginResp.text().catch(() => '');
            if (loginResp.status() >= 400) {
              let msg = `HSVDS: login failed HTTP ${loginResp.status()}`;
              try {
                const err = JSON.parse(body) as { errors?: Record<string, string[]> };
                const first = err.errors && Object.values(err.errors).flat()[0];
                if (first) msg = `HSVDS: ${first}`;
              } catch {
                /* keep */
              }
              throw new Error(msg);
            }
            if (/code|2fa|двухфактор/i.test(body) && /required|необходим|отправ/i.test(body)) {
              throw new Error(
                'HSVDS: требуется код 2FA/SMS — отключи 2FA в профиле или войди вручную в сессии sync-хоста.',
              );
            }
          }

          await page
            .waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30_000 })
            .catch(() => undefined);
          await page.waitForTimeout(1500);

          if (page.url().includes('/login')) {
            const snippet = (await page.locator('body').innerText()).slice(0, 400);
            throw new Error(`HSVDS: login did not leave /login/. ${snippet.replace(/\s+/g, ' ')}`);
          }
        }

        // Ensure we're on the panel so CSRF meta + session cookies are present
        if (!page.url().includes('/server')) {
          await page.goto(serverUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        } else {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
        }
        await page.waitForTimeout(1500);

        // Explicit API: profile is POST-only; vm/list is GET (SPA uses X-CSRF-Token)
        const profile = await apiJson<HsvdsProfile>(page, `${base}/apiv1/user/profile/`, 'POST');
        let vms: HsvdsVm[] = [];
        const list = await apiJson<HsvdsVm[] | { vms?: HsvdsVm[] }>(
          page,
          `${base}/apiv1/vm/list/?_=${Date.now()}`,
          'GET',
        );
        if (Array.isArray(list)) vms = list;
        else if (list && Array.isArray(list.vms)) vms = list.vms;

        let balance = num(profile?.user?.points);
        if (balance == null) {
          const bodyText = await page.locator('body').innerText().catch(() => '');
          balance = parseBalanceFromUi(bodyText);
        }
        const burnFromProfile = totalExpensesPerDay(profile || {});
        let totalDaily = 0;

        for (const vm of vms) {
          const id = vm.ID != null ? String(vm.ID) : '';
          if (!id) continue;
          const daily = num(vm.FullPrice?.PerDay);
          const monthly = num(vm.FullPrice?.PerMonth);
          if (daily != null) totalDaily += daily;
          const ip = vm.IPs?.[0]?.IP || null;
          const flavor = vm.Flavor
            ? `${vm.Flavor.vCPU || '?'}vCPU/${vm.Flavor.RAM || '?'}G/${vm.Flavor.Disk || '?'}G`
            : '';
          const os = vm.ImageOS || vm.ImageName || '';
          const nameParts = [vm.Name || `HSVDS #${id}`, flavor, os].filter(Boolean);

          out.push({
            externalId: id,
            name: nameParts.join(' · ').slice(0, 120),
            ip,
            cost: monthly ?? daily,
            dailyCost: daily,
            currency: 'RUB',
            balance,
            status: mapStatus(vm.VMState),
            billingUrl: `${base}/server/`,
            raw: {
              id: vm.ID,
              name: vm.Name,
              state: vm.VMState,
              fullPrice: vm.FullPrice,
              flavor: vm.Flavor,
            },
          });
        }

        const burn =
          (burnFromProfile != null && burnFromProfile > 0 ? burnFromProfile : null) ||
          (totalDaily > 0 ? totalDaily : null);
        const dueAt = estimateDueAt(balance, burn);

        for (const s of out) {
          s.balance = balance;
          if (dueAt) s.dueAt = dueAt;
        }

        // No VMs but we have balance — still record account burn as a synthetic row
        if (!out.length && balance != null) {
          out.push({
            externalId: 'hsvds-account',
            name: 'HSVDS account',
            balance,
            dailyCost: burn,
            currency: 'RUB',
            dueAt,
            status: 'active',
            billingUrl: `${base}/server/`,
            raw: { profile: profile?.user },
          });
        }

        if (balance == null && !out.length) {
          const snippet = (await page.locator('body').innerText().catch(() => '')).slice(0, 400);
          throw new Error(
            `HSVDS: could not parse balance or services from panel (${page.url()}). ${snippet.replace(/\s+/g, ' ')}`,
          );
        }
      },
      { userAgent: CHROME_UA, stealth: true, viewport: { width: 1400, height: 900 } },
    );

    return out;
  },
};
