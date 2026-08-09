import type {
  ProviderAdapter,
  ProviderAccountCredentials,
  SyncedService,
  ServiceStatus,
} from './types.js';

type BillNode = Record<string, { $?: string } | string | undefined>;

function mapStatus(itemStatus: unknown): ServiceStatus {
  const raw = String(itemStatus ?? '').trim();
  const n = Number(raw);
  if (!Number.isNaN(n) && raw !== '') {
    switch (n) {
      case 2:
        return 'active';
      case 3:
        return 'suspended';
      case 4:
        return 'deleted';
      default:
        break;
    }
  }
  const s = raw.toLowerCase();
  if (/актив|active|работает|ok/.test(s)) return 'active';
  if (/приостанов|suspend|block|блок|выключ/.test(s)) return 'suspended';
  if (/удал|delet|закрыт/.test(s)) return 'deleted';
  return 'unknown';
}

function parseCost(cost: unknown): number | null {
  if (cost == null || cost === '') return null;
  const n = Number(String(cost).replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function getField(row: BillNode, key: string): string | undefined {
  const v = row[key];
  if (v == null) return undefined;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object' && '$' in v) return String((v as { $: string }).$);
  return undefined;
}

function billmgrUrl(base: string): URL {
  const cleaned = base.replace(/\/$/, '');
  return new URL(cleaned.includes('billmgr') ? cleaned : `${cleaned}/billmgr`);
}

async function billmgrJson(
  base: string,
  login: string,
  password: string,
  func: string,
): Promise<Record<string, unknown>> {
  const url = billmgrUrl(base);
  url.searchParams.set('authinfo', `${login}:${password}`);
  url.searchParams.set('func', func);
  url.searchParams.set('out', 'json');

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`LandVPS HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

function extractBalance(desktop: Record<string, unknown>): {
  balance: number | null;
  currency: string;
} {
  const doc = desktop.doc as Record<string, unknown> | undefined;
  const user = (doc?.user || {}) as Record<string, string>;
  const raw = user.$balance ?? user.balance;
  const balance = raw != null && raw !== '' ? parseCost(raw) : null;
  const currency = user.$currency || user.currency || 'RUB';
  return { balance, currency };
}

/**
 * LandVPS uses BILLmanager.
 * Default panel: https://my.landvps.ru/billmgr
 * Balance: func=desktop → doc.user.$balance
 */
export const landvpsAdapter: ProviderAdapter = {
  id: 'landvps',
  label: 'LandVPS (BILLmanager)',

  async sync(credentials: ProviderAccountCredentials): Promise<SyncedService[]> {
    const login = credentials.login;
    const password = credentials.password;
    if (!login || !password) {
      throw new Error('LandVPS requires login and password');
    }

    const base =
      (credentials.baseUrl as string | undefined)?.replace(/\/$/, '') ||
      'https://my.landvps.ru/billmgr';

    const billingUrl = base.includes('billmgr')
      ? base.replace(/\/billmgr.*/, '/')
      : base;

    let balance: number | null = null;
    let currency = 'RUB';
    try {
      const desktop = await billmgrJson(base, login, password, 'desktop');
      const bal = extractBalance(desktop);
      balance = bal.balance;
      currency = bal.currency;
    } catch (e) {
      console.warn('[landvps] desktop balance failed:', (e as Error).message);
    }

    const data = await billmgrJson(base, login, password, 'vds');
    const doc = data.doc as
      | {
          error?: { $?: string; msg?: { $?: string } };
          elem?: BillNode[];
        }
      | undefined;

    const err = doc?.error;
    if (err) {
      const msg = err.msg?.$ || err.$ || JSON.stringify(err);
      throw new Error(`LandVPS API error: ${msg}`);
    }

    const elems = doc?.elem;
    const list: BillNode[] = Array.isArray(elems)
      ? elems
      : Array.isArray((data as { elem?: BillNode[] }).elem)
        ? ((data as { elem: BillNode[] }).elem)
        : [];

    // Account balance from desktop is attached to each real VDS row (no synthetic balance-only service).
    return list.map((row) => {
      const id = getField(row, 'id') || getField(row, 'elid') || getField(row, 'serverid') || '';
      const name =
        getField(row, 'name') ||
        getField(row, 'domain') ||
        getField(row, 'serverid') ||
        getField(row, 'ip') ||
        `vds-${id}`;
      const costRaw =
        getField(row, 'cost') || getField(row, 'item_cost') || getField(row, 'periodcost');

      return {
        externalId: id || name,
        name,
        ip: getField(row, 'ip') || null,
        cost: parseCost(costRaw),
        currency,
        dueAt: getField(row, 'expiredate') || getField(row, 'expire') || null,
        balance,
        status: mapStatus(getField(row, 'item_status') || getField(row, 'status')),
        billingUrl,
        raw: row,
      } satisfies SyncedService;
    });
  },
};
