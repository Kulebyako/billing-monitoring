# Monitoring runbook

## Stack

| Service | Port | RAM limit |
|---------|------|-----------|
| VictoriaMetrics | 8428 | 512 MB |
| vmagent | — | 128 MB |
| Grafana | 3000 | 256 MB |
| node_exporter | 9100 | 64 MB |

## Daily checks

1. Grafana → **Fleet Overview**: any host `down`?
2. Grafana → **Billing Ops**: `sync_error_accounts > 0`?
3. `docker stats` on monitoring VPS — total RAM < 70% in idle

## Disk

VictoriaMetrics data: volume `vm-data`. Size grows with host count, scrape interval, and retention (`-retentionPeriod`).

```bash
docker exec vm du -sh /victoria-metrics-data
```

## Backups

Backup these paths (no secrets in metrics configs):

- `monitoring/vmagent/scrape.yml`
- `monitoring/hosts/targets.json`
- `monitoring/grafana/provisioning/`
- `monitoring/grafana/dashboards/`
- `monitoring/.env` (Grafana password)

VictoriaMetrics data is reproducible; optional tarball of `vm-data` volume weekly.

## Firewall

| From | To | Port |
|------|-----|------|
| Monitoring VPS | Remote VPS | 9100/tcp (node_exporter) |
| Your IP | Monitoring VPS | 3000/tcp (Grafana) |
| vmagent container | host | 3080/tcp (`/metrics`) |

Do **not** expose `:9100` or `:8428` to the public internet.

## Troubleshooting

### Target down in vmagent

```bash
cd monitoring && docker compose logs vmagent
curl -s http://REMOTE_IP:9100/metrics | head
```

### No billing metrics

```bash
curl -s http://127.0.0.1:3080/metrics | grep billing_
```

Ensure server-billing is running and vmagent target `host.docker.internal:3080` is reachable from container.

### High RAM on 2 GB VPS

1. Stop optional services first
2. Reduce Grafana refresh to 5m
3. Defer Loki (phase 2)
4. Increase scrape interval to 120s in `vmagent/scrape.yml`

### Playwright sync + monitoring spike

Stagger cron: don't run full provider sync at the same minute as heavy Grafana usage.

## Phase 2 — Loki (optional)

Uncomment `loki` service in `docker-compose.yml` only if idle RAM < 1.2 GB after 1 week. Use 7-day log retention, central host only.

## Phase 3 — Docker metrics (optional)

Uncomment `cadvisor` job in `vmagent/scrape.yml` for specific hosts. Install cAdvisor on that host only; do not roll out globally.

## Phase 4 — Alerts (optional)

- vmalert + Alertmanager, or Grafana alerting
- Route to Telegram (reuse billing bot channel)
