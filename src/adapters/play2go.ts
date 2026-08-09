import type {
  ProviderAdapter,
  ProviderAccountCredentials,
  SyncedService,
  ServiceStatus,
} from './types.js';

const DEFAULT_BILLING = 'https://play2go.cloud';
const DEFAULT_PANEL = 'https://control.play2go.cloud';

type Json = Record<string, unknown>;

function apiRoot(base: string): string {
  const b = base.replace(/\/$/, '');
  return b.endsWith('/api') ? b : `${b}/api`;
}

function mergeSetCookie(existing: string, setCookie: string[]): string {
  const map = new Map<string, string>();
  for (const part of existing.split(';')) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq > 0) map.set(p.slice(0, eq), p.slice(eq + 1));
  }
  for (const sc of setCookie) {
    const first = sc.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) map.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function loginBilling(
  billingBase: string,
  email: string,
  password: string,
  totp = '',
): Promise<string> {
  const res = await fetch(`${apiRoot(billingBase)}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ email, password, token: totp }),
    signal: AbortSignal.timeout(60_000),
  });

  const setCookie =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];

  // Success is HTTP 204 with access_token cookie (body empty)
  if (res.status !== 204 && res.status !== 200) {
    const text = await res.text();
    throw new Error(`Play2Go login HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const cookie = mergeSetCookie('', setCookie);
  if (!cookie.includes('access_token=')) {
    throw new Error(
      'Play2Go login: нет cookie access_token. Проверь email/password биллинга play2go.cloud',
    );
  }

  // Detect 2FA challenge if body present
  const text = await res.text();
  if (text) {
    try {
      const json = JSON.parse(text) as Json;
      const data = (json.data && typeof json.data === 'object' ? json.data : json) as Json;
      if (data.is_totp_enabled) {
        throw new Error(
          'Play2Go: включена 2FA — укажи текущий TOTP в поле Token (не ptlc_ ключ).',
        );
      }
    } catch (e) {
      if ((e as Error).message.startsWith('Play2Go:')) throw e;
    }
  }

  return cookie;
}

async function apiGet(billingBase: string, path: string, cookie: string): Promise<unknown> {
  const res = await fetch(`${apiRoot(billingBase)}${path}`, {
    headers: { Accept: 'application/json', Cookie: cookie },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Play2Go ${path}: non-JSON HTTP ${res.status}`);
  }
  if (res.status >= 400) {
    throw new Error(`Play2Go ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return json;
}

function mapStatus(raw: unknown): ServiceStatus {
  const s = String(raw ?? '').toUpperCase();
  if (!s) return 'unknown';
  if (['ACTIVE', 'RUNNING', 'OK', 'PAID'].includes(s)) return 'active';
  if (['SUSPENDED', 'BLOCKED', 'STOPPED', 'EXPIRED', 'FROZEN'].includes(s)) return 'suspended';
  if (['DELETED', 'TERMINATED'].includes(s)) return 'deleted';
  return 'unknown';
}

function normalizeVm(item: Json, billingUrl: string): SyncedService {
  const id = String(item.id ?? item.uuid ?? '');
  const paid = item.paid_up_to ? String(item.paid_up_to).slice(0, 10) : null;
  const cost =
    typeof item.cost === 'number'
      ? item.cost
      : typeof item.cost_per_month === 'number'
        ? item.cost_per_month
        : null;

  return {
    externalId: `vm:${id}`,
    name: String(item.name || `VM ${id}`),
    ip: (item.vm6_ip || item.ip || item.ipv4 || null) as string | null,
    cost,
    currency: 'RUB',
    dueAt: paid,
    status: mapStatus(item.status),
    billingUrl: `${billingUrl.replace(/\/$/, '')}/me/virtual-services`,
    raw: item,
  };
}

async function fetchPteroServers(
  panelBase: string,
  token: string,
): Promise<SyncedService[]> {
  if (!token.startsWith('ptlc_')) return [];
  const res = await fetch(`${panelBase.replace(/\/$/, '')}/api/client`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'Application/vnd.pterodactyl.v1+json',
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as {
    data?: Array<{ attributes?: Json }>;
  };
  return (body.data || [])
    .map((row) => {
      const a = row.attributes || {};
      const id = String(a.identifier || a.uuid || '');
      if (!id) return null;
      return {
        externalId: `ptero:${id}`,
        name: String(a.name || id),
        ip: null,
        status: a.is_suspended ? ('suspended' as const) : ('active' as const),
        billingUrl: panelBase,
        currency: 'RUB',
        raw: a,
      } satisfies SyncedService;
    })
    .filter(Boolean) as SyncedService[];
}

/**
 * Play2Go billing lives at https://play2go.cloud (not control.play2go.cloud).
 * List VMs: GET /api/servicesvm/vm_my after POST /api/auth/login (cookie access_token).
 */
export const play2goAdapter: ProviderAdapter = {
  id: 'play2go',
  label: 'Play2Go',

  async sync(credentials: ProviderAccountCredentials): Promise<SyncedService[]> {
    const billingBase =
      (credentials.baseUrl as string | undefined) || DEFAULT_BILLING;
    const panelBase =
      (credentials.panelUrl as string | undefined) || DEFAULT_PANEL;
    const email = credentials.login;
    const password = credentials.password;
    const token = (credentials.token as string | undefined) || '';

    if (!email || !password) {
      throw new Error(
        'Play2Go: нужен email+password от https://play2go.cloud (не от control.play2go.cloud).',
      );
    }

    const totp = token && !token.startsWith('ptlc_') ? token : '';
    const cookie = await loginBilling(billingBase, email, password, totp);

    const meJson = (await apiGet(billingBase, '/users/me', cookie)) as {
      data?: Json;
    };
    const balance =
      typeof meJson.data?.balance === 'number' ? meJson.data.balance : null;

    const vmJson = (await apiGet(billingBase, '/servicesvm/vm_my', cookie)) as {
      data?: Json[];
    };
    const vms = (vmJson.data || []).map((item) => {
      const svc = normalizeVm(item, billingBase);
      // attach account balance for low-balance reminders
      svc.balance = balance;
      return svc;
    });

    const ptero =
      token.startsWith('ptlc_')
        ? await fetchPteroServers(panelBase, token)
        : [];

    const out = [...vms, ...ptero];
    if (!out.length) {
      throw new Error(
        'Play2Go: /servicesvm/vm_my вернул пустой список. Если VPS есть в кабинете — напиши.',
      );
    }
    return out;
  },
};
