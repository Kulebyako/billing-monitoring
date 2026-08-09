import { decryptJson, encryptJson } from './crypto.js';
import {
  getAccount,
  getDb,
  listAccounts,
  type ProviderAccountRow,
  type ServiceRow,
} from './db.js';
import { getAdapter } from './adapters/registry.js';
import type { ProviderAccountCredentials, SyncedService } from './adapters/types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeDue(dueAt?: string | null): string | null {
  if (!dueAt) return null;
  const s = String(dueAt).trim();
  if (!s) return null;
  // BILLmanager often returns YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toISOString().slice(0, 10);
}

function upsertService(account: ProviderAccountRow, svc: SyncedService, seenAt: string): void {
  const db = getDb();
  const existing = db
    .prepare('SELECT id, tag, notes FROM services WHERE account_id = ? AND external_id = ?')
    .get(account.id, svc.externalId) as { id: number; tag: string; notes: string } | undefined;

  const dueAt = normalizeDue(svc.dueAt);
  const raw = svc.raw ? JSON.stringify(svc.raw) : null;

  if (existing) {
    db.prepare(
      `UPDATE services SET
        name = ?, ip = ?, cost = ?, currency = ?, due_at = ?, balance = ?, daily_cost = ?,
        status = ?, billing_url = ?, raw_json = ?, last_seen_at = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      svc.name,
      svc.ip ?? null,
      svc.cost ?? null,
      svc.currency ?? null,
      dueAt,
      svc.balance ?? null,
      svc.dailyCost ?? null,
      svc.status,
      svc.billingUrl ?? null,
      raw,
      seenAt,
      existing.id,
    );
  } else {
    db.prepare(
      `INSERT INTO services (
        account_id, provider, external_id, name, ip, cost, currency, due_at, balance, daily_cost,
        status, billing_url, raw_json, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      account.id,
      account.provider,
      svc.externalId,
      svc.name,
      svc.ip ?? null,
      svc.cost ?? null,
      svc.currency ?? null,
      dueAt,
      svc.balance ?? null,
      svc.dailyCost ?? null,
      svc.status,
      svc.billingUrl ?? null,
      raw,
      seenAt,
    );
  }
}

export async function syncAccount(accountId: number): Promise<{
  ok: boolean;
  count: number;
  error?: string;
}> {
  const account = getAccount(accountId);
  if (!account) return { ok: false, count: 0, error: 'Account not found' };
  if (!account.enabled) return { ok: false, count: 0, error: 'Account disabled' };

  const adapter = getAdapter(account.provider);
  if (!adapter) {
    const error = `No adapter for provider: ${account.provider}`;
    getDb()
      .prepare(
        `UPDATE provider_accounts SET last_error = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(error, account.id);
    return { ok: false, count: 0, error };
  }

  let credentials: ProviderAccountCredentials;
  try {
    credentials = decryptJson<ProviderAccountCredentials>(account.credentials_enc);
  } catch (e) {
    const error = `Failed to decrypt credentials: ${(e as Error).message}`;
    getDb()
      .prepare(
        `UPDATE provider_accounts SET last_error = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(error, account.id);
    return { ok: false, count: 0, error };
  }

  if (account.base_url && !credentials.baseUrl) {
    credentials.baseUrl = account.base_url;
  }

  const started = Date.now();
  try {
    const services = await adapter.sync(credentials);
    const seenAt = nowIso();
    const seenIds = new Set(services.map((s) => s.externalId));

    const tx = getDb().transaction(() => {
      for (const svc of services) {
        // Never persist known synthetic account-balance rows from adapters
        if (
          svc.externalId === 'kyonix-balance' ||
          svc.externalId === 'account-balance' ||
          /баланс\s*\(@kyonix/i.test(svc.name)
        ) {
          continue;
        }
        upsertService(account, svc, seenAt);
      }
      // Mark missing
      const existing = getDb()
        .prepare('SELECT id, external_id FROM services WHERE account_id = ?')
        .all(account.id) as { id: number; external_id: string }[];
      for (const row of existing) {
        if (!seenIds.has(row.external_id)) {
          // Drop synthetic/orphan rows instead of leaving "missing" clutter in the UI
          getDb().prepare('DELETE FROM services WHERE id = ?').run(row.id);
        }
      }
      getDb()
        .prepare(
          `UPDATE provider_accounts SET last_synced_at = ?, last_error = NULL, updated_at = datetime('now') WHERE id = ?`,
        )
        .run(seenAt, account.id);
    });
    tx();

    const { recordSyncResult } = await import('./metrics.js');
    recordSyncResult(account.provider, true, Date.now() - started);
    return { ok: true, count: services.length };
  } catch (e) {
    const { recordSyncResult } = await import('./metrics.js');
    recordSyncResult(account.provider, false, Date.now() - started);
    const err = e as Error & { partialServices?: SyncedService[] };
    const error = err.message || String(e);
    if (err.partialServices?.length) {
      const seenAt = nowIso();
      const tx = getDb().transaction(() => {
        for (const svc of err.partialServices!) {
          upsertService(account, svc, seenAt);
        }
        getDb()
          .prepare(
            `UPDATE provider_accounts SET last_synced_at = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?`,
          )
          .run(seenAt, error, account.id);
      });
      tx();
      return { ok: false, count: err.partialServices.length, error };
    }
    getDb()
      .prepare(
        `UPDATE provider_accounts SET last_error = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(error, account.id);
    return { ok: false, count: 0, error };
  }
}

export async function syncAll(): Promise<
  Array<{ accountId: number; provider: string; ok: boolean; count: number; error?: string }>
> {
  const accounts = listAccounts().filter((a) => a.enabled);
  const results = [];
  for (const a of accounts) {
    const r = await syncAccount(a.id);
    results.push({ accountId: a.id, provider: a.provider, ...r });
  }
  return results;
}

export function createAccount(input: {
  provider: string;
  label?: string;
  baseUrl?: string;
  credentials: ProviderAccountCredentials;
}): number {
  const enc = encryptJson(input.credentials);
  const info = getDb()
    .prepare(
      `INSERT INTO provider_accounts (provider, label, base_url, credentials_enc)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      input.provider,
      input.label || input.provider,
      input.baseUrl || input.credentials.baseUrl || null,
      enc,
    );
  return Number(info.lastInsertRowid);
}

export function updateAccount(
  id: number,
  input: {
    label?: string;
    baseUrl?: string | null;
    enabled?: boolean;
    credentials?: ProviderAccountCredentials;
  },
): void {
  const cur = getAccount(id);
  if (!cur) throw new Error('Account not found');
  const enc = input.credentials ? encryptJson(input.credentials) : cur.credentials_enc;
  getDb()
    .prepare(
      `UPDATE provider_accounts SET
        label = ?, base_url = ?, enabled = ?, credentials_enc = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(
      input.label ?? cur.label,
      input.baseUrl !== undefined ? input.baseUrl : cur.base_url,
      input.enabled === undefined ? cur.enabled : input.enabled ? 1 : 0,
      enc,
      id,
    );
}

export function deleteAccount(id: number): void {
  getDb().prepare('DELETE FROM provider_accounts WHERE id = ?').run(id);
}

export function publicAccount(a: ProviderAccountRow) {
  return {
    id: a.id,
    provider: a.provider,
    label: a.label,
    baseUrl: a.base_url,
    enabled: !!a.enabled,
    lastSyncedAt: a.last_synced_at,
    lastError: a.last_error,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

export function publicService(s: ServiceRow) {
  return {
    id: s.id,
    accountId: s.account_id,
    provider: s.provider,
    externalId: s.external_id,
    name: s.name,
    ip: s.ip,
    cost: s.cost,
    currency: s.currency,
    dueAt: s.due_at,
    balance: s.balance,
    dailyCost: s.daily_cost,
    status: s.status,
    billingUrl: s.billing_url,
    tag: s.tag,
    notes: s.notes,
    lastSeenAt: s.last_seen_at,
    updatedAt: s.updated_at,
  };
}
