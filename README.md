# Billing + Monitoring

Open-source panel for **VPN / VPS fleet operators**: sync balances and due dates from hosting providers, remind you in Telegram before renewals, and optionally monitor hosts with VictoriaMetrics + Grafana.

No manual «paid» checkbox — after you pay at the provider, the next sync refreshes the data.

## Features

- Multi-provider billing sync (API or Playwright where needed)
- Encrypted provider credentials at rest (`CREDENTIALS_KEY`)
- Telegram reminders + fleet commands (`/list`, `/due`, `/sync`, `/status`, …)
- Optional monitoring stack: VictoriaMetrics, vmagent, Grafana, node_exporter, ICMP blackbox
- Docker-ready single-VPS deploy

## Providers

| ID | Method |
| --- | --- |
| `landvps` | BILLmanager API (`my.landvps.ru`) |
| `vpsville` | Playwright (client area) |
| `hsvds` | Playwright; due ≈ balance / daily spend |
| `play2go` | Billing panel login; optional Pterodactyl client key |
| `yun62` | Playwright (`62yun.ru`) |
| `kyonix` | JWT API on `beta.kyonix.com`; optional VMmanager merge (`vm.kyonix.com`) |

## Quick start (local)

```bash
cp .env.example .env
# Set PANEL_PASSWORD, CREDENTIALS_KEY (32+ chars), optional Telegram bot

npm install
npx playwright install chromium
npm run dev
```

Open http://localhost:3080 — password from `PANEL_PASSWORD`.

Add provider accounts in the UI → **Sync all**.

## Docker

```bash
cp .env.example .env
# edit .env
docker compose up -d --build
```

SQLite + Playwright sessions live under `./data` (gitignored).

## Telegram bot (your panel)

1. Create a bot with [@BotFather](https://t.me/BotFather).
2. Message `/start`, get `chat_id` (`@userinfobot` or getUpdates).
3. Put in `.env`:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Reminders: 7/3/1/0 days before `due_at`, and when balance ≤ `BALANCE_THRESHOLD` (default 500).

## Kyonix

- Primary: email + password for https://beta.kyonix.com → VDS list, cost, next payment, balance.
- Optional: same credentials against https://vm.kyonix.com (VMmanager) to enrich/merge VMs by id/IP/name.

## Scrapers

Panels without a public API are scraped with Playwright. Layouts change — if sync fails with a parse error, open the error in the UI and adjust selectors.

Debug: `PLAYWRIGHT_HEADLESS=0`. Browser sessions: `DATA_DIR/sessions/`.

## Security (read before publishing forks)

- **Never commit** `.env`, `monitoring/.env`, `data/`, or real `monitoring/hosts/targets.json` / `ping-targets.json`.
- Panel password: `PANEL_PASSWORD`. Provider secrets: AES-GCM with `CREDENTIALS_KEY`.
- Copy host inventories from `*.example.json` only.
- See [SECURITY.md](SECURITY.md).

## Scripts

- `npm run dev` — development (tsx watch)
- `npm run build && npm start` — production
- `npm run sync` — one-shot sync of all accounts
- `npm run monitoring:up` — VictoriaMetrics + Grafana (see `monitoring/README.md`)

## Monitoring

```bash
cp monitoring/.env.example monitoring/.env
cp monitoring/hosts/targets.example.json monitoring/hosts/targets.json
cp monitoring/hosts/ping-targets.example.json monitoring/hosts/ping-targets.json
# edit IPs/labels
npm run monitoring:up
```

Grafana: http://localhost:3000 · Billing metrics: http://localhost:3080/metrics

Details: [monitoring/README.md](monitoring/README.md)

## License

MIT — see [LICENSE](LICENSE).
