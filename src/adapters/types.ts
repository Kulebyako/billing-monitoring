export type ServiceStatus = 'active' | 'suspended' | 'deleted' | 'missing' | 'unknown';

export interface SyncedService {
  externalId: string;
  name: string;
  ip?: string | null;
  cost?: number | null;
  currency?: string | null;
  dueAt?: string | null; // ISO date YYYY-MM-DD or full ISO
  balance?: number | null;
  dailyCost?: number | null;
  status: ServiceStatus;
  billingUrl?: string | null;
  raw?: unknown;
}

export interface ProviderAccountCredentials {
  login?: string;
  password?: string;
  token?: string;
  baseUrl?: string;
  /** Extra free-form fields per provider */
  [key: string]: unknown;
}

export interface ProviderAdapter {
  id: string;
  label: string;
  sync(credentials: ProviderAccountCredentials): Promise<SyncedService[]>;
}

export const PROVIDER_IDS = [
  'landvps',
  'vpsville',
  'hsvds',
  'play2go',
  'yun62',
  'kyonix',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
