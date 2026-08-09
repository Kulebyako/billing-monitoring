# MVP metrics

Lightweight host + billing metrics only. No Docker/container metrics in phase 0–1.

## Host metrics (node_exporter)

Collected every **60s** via vmagent pull from `:9100`.

| Metric family | Use |
|---------------|-----|
| `node_cpu_seconds_total` | CPU usage % |
| `node_memory_*` | RAM used / available |
| `node_filesystem_*` | Disk usage %, inodes |
| `node_network_*` | RX/TX bytes, errors |
| `node_load1` | Load average |
| `node_boot_time_seconds` | Reboot detection |

Disabled collectors on remote hosts: wifi, infiniband, IPMI, hwmon, etc.

## Billing metrics (`GET /metrics` on server-billing)

| Metric | Type | Description |
|--------|------|-------------|
| `billing_services_total{status}` | gauge | Services by status |
| `billing_urgent_due_total` | gauge | Due within 7 days |
| `billing_low_balance_total` | gauge | Balance ≤ `BALANCE_THRESHOLD` |
| `billing_monthly_cost_total` | gauge | Sum of monthly `cost` |
| `billing_remaining_month_cost` | gauge | Projected spend until month end |
| `billing_sync_error_accounts` | gauge | Accounts with `last_error` |
| `billing_last_sync_timestamp{provider}` | gauge | Last sync time (unix) |
| `billing_sync_total{provider,result}` | counter | Sync ok/error since restart |
| `billing_sync_duration_seconds{provider}` | gauge | Last sync duration |

No high-cardinality labels (no per-service IDs, IPs, or user data).

## Future (not enabled)

- **Phase 2:** Loki logs (7d retention, central host only)
- **Phase 3:** cAdvisor / container metrics — see commented job in `vmagent/scrape.yml`
