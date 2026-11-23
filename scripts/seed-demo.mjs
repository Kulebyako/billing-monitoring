#!/usr/bin/env node
// Синтетические демо-данные из Приложения А docs/DESIGN.md.
// Только вымышленные провайдеры и IP из RFC 5737 — реальная инфраструктура не используется.
// Запуск: node scripts/seed-demo.mjs /tmp/<data-dir>  (сервер должен один раз создать схему)

import path from 'node:path';
import Database from 'better-sqlite3';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/seed-demo.mjs <DATA_DIR>');
  process.exit(2);
}

const db = new Database(path.join(dir, 'billing.db'));
db.pragma('foreign_keys = ON');

const hasSchema = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'services'")
  .get();
if (!hasSchema) {
  console.error('schema not found: start the server once so initDb() creates it');
  process.exit(2);
}

const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');

const accounts = [
  ['ozero.cloud', 'основной', iso(-10 * 60 * 1000), null],
  ['north-vds.example', 'резерв', null, null],
  ['protva.net', 'shop', iso(-2 * 60 * 60 * 1000), 'Timeout'],
];

const services = [
  // [id, accountId, provider, externalId, name, ip, cost, dueAt, balance, status, tag, notes]
  [1, 1, 'ozero.cloud', 'edge-msk-01', 'edge-msk-01', '192.0.2.10', 990, '2026-11-26', 2430, 'active', 'vpn', 'Основной VPN-узел для удалённого доступа'],
  [2, 2, 'north-vds.example', 'core-spb-02', 'core-spb-02', '198.51.100.24', 1290, '2026-11-30', 310, 'active', 'private', 'Тестовый контур, продление раз в месяц'],
  [3, 1, 'raduga-hosting.ru', 'node-ams-03', 'node-ams-03', '203.0.113.7', 890, '2026-11-26', 120, 'active', 'proxy', 'Прокси-выход в Амстердаме'],
  [4, 3, 'protva.net', 'shop-ru-04', 'shop-ru-04', '192.0.2.44', 450, '2026-11-20', 0, 'suspended', 'public', 'Витрина для внешних клиентов'],
  [5, 2, 'lesnoy-cloud.example', 'dev-nl-05', 'dev-nl-05', '198.51.100.88', 350, null, 1100, 'missing', 'other', 'Песочница разработки'],
];

const insertAccount = db.prepare(`
  INSERT INTO provider_accounts (id, provider, label, base_url, credentials_enc, enabled, last_synced_at, last_error)
  VALUES (?, ?, ?, NULL, 'demo-synthetic-credentials', 1, ?, ?)
`);
const insertService = db.prepare(`
  INSERT INTO services (id, account_id, provider, external_id, name, ip, cost, currency, due_at, balance, daily_cost,
                        status, billing_url, tag, notes, last_seen_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'RUB', ?, ?, NULL, ?, ?, ?, ?, ?)
`);

const seed = db.transaction(() => {
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM provider_accounts').run();
  accounts.forEach(([provider, label, syncedAt, error], i) => {
    insertAccount.run(i + 1, provider, label, syncedAt, error);
  });
  const now = iso(0);
  for (const s of services) {
    const [id, accountId, provider, externalId, name, ip, cost, dueAt, balance, status, tag, notes] = s;
    insertService.run(
      id,
      accountId,
      provider,
      externalId,
      name,
      ip,
      cost,
      dueAt,
      balance,
      status,
      `https://panel.example.com/${provider}/billing`,
      tag,
      notes,
      now,
    );
  }
});
seed();

const total = services
  .filter((s) => s[9] !== 'missing' && s[9] !== 'deleted')
  .reduce((sum, s) => sum + (s[6] || 0), 0);
console.log(`seeded ${accounts.length} accounts, ${services.length} services, monthly total ${total} RUB`);
