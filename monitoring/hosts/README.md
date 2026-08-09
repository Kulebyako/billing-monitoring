# Remote scrape targets

vmagent reads `targets.json` and `ping-targets.json` (Prometheus file_sd format).

Copy from examples:

```bash
cp targets.example.json targets.json
cp ping-targets.example.json ping-targets.json
```

Edit IPs and labels:

| Label | Example | Purpose |
|-------|---------|---------|
| `host` | `msk1` | Display name in Grafana |
| `env` | `prod` | Environment |
| `role` | `app`, `proxy`, `db` | Service role |
| `provider` | `landvps` | Optional — billing provider hint |

After edit, vmagent picks up changes within 5 minutes (or restart vmagent).

**Do not commit** real `targets.json` / `ping-targets.json` — they are gitignored.

**Firewall:** on each remote VPS allow TCP **9100** only from the monitoring server IP.

Install node_exporter:

```bash
sudo bash ../scripts/install-node-exporter.sh
```
