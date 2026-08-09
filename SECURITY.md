# Security

## Reporting

If you find a vulnerability in this project, please open a **private** GitHub security advisory on the repository, or contact the maintainer via GitHub. Do not open a public issue with exploit details until a fix is available.

## Secrets checklist

Never commit:

| Path | Why |
|------|-----|
| `.env` | Panel password, session secret, credentials key, Telegram bot token |
| `monitoring/.env` | Grafana admin password |
| `data/` | SQLite DB (encrypted creds) + Playwright session profiles |
| `monitoring/hosts/targets.json` | Your real server IPs |
| `monitoring/hosts/ping-targets.json` | Your real server IPs |

Use `.env.example` / `monitoring/.env.example` / `hosts/*.example.json` as templates.

## Runtime hardening (recommended)

- Strong unique `PANEL_PASSWORD` and `CREDENTIALS_KEY` (32+ random characters).
- Restrict panel and Grafana to VPN/SSH tunnel or firewall allowlists when possible.
- Rotate provider passwords if they were ever pasted into chat or tickets.
- Keep Playwright session directories private; they can contain logged-in cookies.
