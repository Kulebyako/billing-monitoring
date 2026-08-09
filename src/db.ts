import fs from 'node:fs';
import Database from 'better-sqlite3';
import { DB_PATH, DATA_DIR, SESSIONS_DIR } from './config.js';

export type Db = Database.Database;

let db: Db;

export function getDb(): Db {
  if (!db) throw new Error('DB not initialized');
  return db;
}

export function initDb(): Db {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      base_url TEXT,
      credentials_enc TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_synced_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      name TEXT NOT NULL,
      ip TEXT,
      cost REAL,
      currency TEXT,
      due_at TEXT,
      balance REAL,
      daily_cost REAL,
      status TEXT NOT NULL DEFAULT 'unknown',
      billing_url TEXT,
      tag TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      raw_json TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(account_id, external_id)
    );

    CREATE TABLE IF NOT EXISTS reminder_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(service_id, kind)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
  `);

  return db;
}

export interface ProviderAccountRow {
  id: number;
  provider: string;
  label: string;
  base_url: string | null;
  credentials_enc: string;
  enabled: number;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServiceRow {
  id: number;
  account_id: number;
  provider: string;
  external_id: string;
  name: string;
  ip: string | null;
  cost: number | null;
  currency: string | null;
  due_at: string | null;
  balance: number | null;
  daily_cost: number | null;
  status: string;
  billing_url: string | null;
  tag: string;
  notes: string;
  raw_json: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export function listAccounts(): ProviderAccountRow[] {
  return getDb()
    .prepare('SELECT * FROM provider_accounts ORDER BY provider, id')
    .all() as ProviderAccountRow[];
}

export function getAccount(id: number): ProviderAccountRow | undefined {
  return getDb().prepare('SELECT * FROM provider_accounts WHERE id = ?').get(id) as
    | ProviderAccountRow
    | undefined;
}

export function listServices(filters?: {
  provider?: string;
  tag?: string;
  status?: string;
}): ServiceRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters?.provider) {
    where.push('provider = ?');
    params.push(filters.provider);
  }
  if (filters?.tag) {
    where.push('tag = ?');
    params.push(filters.tag);
  }
  if (filters?.status) {
    where.push('status = ?');
    params.push(filters.status);
  }
  const sql = `SELECT * FROM services ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY
    CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
    due_at ASC,
    provider, name`;
  return getDb().prepare(sql).all(...params) as ServiceRow[];
}

export function getService(id: number): ServiceRow | undefined {
  return getDb().prepare('SELECT * FROM services WHERE id = ?').get(id) as ServiceRow | undefined;
}

export function updateServiceMeta(
  id: number,
  data: { tag?: string; notes?: string },
): ServiceRow | undefined {
  const cur = getService(id);
  if (!cur) return undefined;
  getDb()
    .prepare(
      `UPDATE services SET tag = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(data.tag ?? cur.tag, data.notes ?? cur.notes, id);
  return getService(id);
}
