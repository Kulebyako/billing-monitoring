# Monitoring (VictoriaMetrics)

Lightweight self-hosted monitoring: **VictoriaMetrics + vmagent + Grafana + node_exporter**.

- Host metrics only (no Docker/container monitoring in phase 0–1)
- Scrape interval: **60s**
- Retention: **30 days**
- Billing app exposes `GET /metrics` (Prometheus format)

## Quick start (local)

1. Start server-billing on `:3080` (`npm run dev` or `npm start`).
2. Copy env and start monitoring:

```bash
cp monitoring/.env.example monitoring/.env
cd monitoring && docker compose up -d
```

3. Open:
   - Grafana: http://localhost:3000 (admin / password from `monitoring/.env`)
   - VictoriaMetrics UI: http://localhost:8428/vmui
   - Dashboards: **Fleet Overview**, **Billing Ops**, **Security Overview**, **Server Availability**

4. Check targets in vmagent logs:

```bash
docker compose -f monitoring/docker-compose.yml logs vmagent | tail -20
```

## Add remote VPS

On each remote server:

```bash
scp monitoring/scripts/install-node-exporter.sh root@YOUR_VPS:/tmp/
ssh root@YOUR_VPS 'bash /tmp/install-node-exporter.sh'
# Firewall: allow :9100 only from monitoring VPS IP
```

On monitoring VPS, edit `monitoring/hosts/targets.json` (see `targets.example.json`):

```json
[
  {
    "targets": ["203.0.113.10:9100"],
    "labels": { "host": "msk1", "env": "prod", "role": "app" }
  }
]
```

vmagent reloads targets every 5 minutes.

How many hosts you can scrape depends on the monitoring VPS CPU/RAM/disk and retention — see hardware notes in the [root README](../README.md#требования-к-железу).

## Resource limits

Compose sets default `mem_limit` / `cpus` suitable for a small VPS; raise them if your host has more resources. See [RUNBOOK.md](./RUNBOOK.md).

## Metrics reference

See [METRICS.md](./METRICS.md).

## Future phases

- **Phase 2:** Loki (commented in `docker-compose.yml`)
- **Phase 3:** cAdvisor job (commented in `vmagent/scrape.yml`)
