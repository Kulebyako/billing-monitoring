/**
 * Single source of PromQL for the monitoring panel and the Telegram monitor.
 *
 * Every VictoriaMetrics query used by `/api/monitor/*` and `tg-monitor.ts`
 * lives here so the panel and the chat bot show the same numbers.
 * Metric families: node-exporter (`job=~"node.*"`), ICMP blackbox
 * (`job="blackbox-icmp"`) and textfile security metrics (`node_security_*`).
 */

const NODE_JOB = 'job=~"node.*"';
const ICMP_JOB = 'job="blackbox-icmp"';

export const PROMQL = {
  // --- ICMP blackbox -------------------------------------------------------
  probe: `probe_success{${ICMP_JOB}}`,
  rtt: `probe_icmp_duration_seconds{${ICMP_JOB},phase="rtt"}`,
  /** Fleet-wide percentile for the Telegram status report. */
  rttP50: `quantile(0.5, probe_icmp_duration_seconds{${ICMP_JOB},phase="rtt"})`,
  rttP95: `quantile(0.95, probe_icmp_duration_seconds{${ICMP_JOB},phase="rtt"})`,
  /** Per-host percentile over the last 5 minutes for the panel table. */
  rttP50ByHost: `quantile_over_time(0.5, probe_icmp_duration_seconds{${ICMP_JOB},phase="rtt"}[5m])`,
  rttP95ByHost: `quantile_over_time(0.95, probe_icmp_duration_seconds{${ICMP_JOB},phase="rtt"}[5m])`,

  // --- node-exporter ------------------------------------------------------
  nodeUp: `up{${NODE_JOB}}`,
  cpu: `100 - (avg by(host) (rate(node_cpu_seconds_total{mode="idle",${NODE_JOB}}[5m])) * 100)`,
  ram: `(1 - (node_memory_MemAvailable_bytes{${NODE_JOB}} / node_memory_MemTotal_bytes{${NODE_JOB}})) * 100`,
  disk: `(1 - (node_filesystem_avail_bytes{${NODE_JOB},mountpoint="/",fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes{${NODE_JOB},mountpoint="/",fstype!~"tmpfs|overlay"})) * 100`,
  load: `node_load1{${NODE_JOB}}`,
  boot: `node_boot_time_seconds{${NODE_JOB}}`,

  // --- security textfile metrics -----------------------------------------
  // fail2ban exposes one series per jail, so fold them per host.
  banned: `sum by(host) (node_security_fail2ban_banned{${NODE_JOB}})`,
  ufwBlocks: `sum by(host) (node_security_ufw_blocks_1h{${NODE_JOB}})`,
  ufwOn: `max by(host) (node_security_ufw_enabled{${NODE_JOB}})`,
} as const;

export type PromqlKey = keyof typeof PROMQL;

/** Queries fetched together for the panel snapshot (order is irrelevant). */
export const MONITOR_QUERY_KEYS = [
  'probe',
  'rttP50ByHost',
  'rttP95ByHost',
  'nodeUp',
  'cpu',
  'ram',
  'disk',
  'load',
  'boot',
  'ufwOn',
  'ufwBlocks',
  'banned',
] as const satisfies readonly PromqlKey[];

export type MonitorQueryKey = (typeof MONITOR_QUERY_KEYS)[number];

/**
 * Per-host PromQL for the Telegram `/host NAME` report.
 * `host` must already be escaped for a double-quoted PromQL string.
 */
export function hostQueries(host: string): {
  probe: string;
  rtt: string;
  nodeUp: string;
  cpu: string;
  ram: string;
  disk: string;
  load: string;
  boot: string;
  banned: string;
  ufwBlocks: string;
} {
  const h = `host="${host}"`;
  return {
    probe: `probe_success{${ICMP_JOB},${h}}`,
    rtt: `probe_icmp_duration_seconds{${ICMP_JOB},phase="rtt",${h}}`,
    nodeUp: `up{${NODE_JOB},${h}}`,
    cpu: `100 - (avg by(host) (rate(node_cpu_seconds_total{mode="idle",${NODE_JOB},${h}}[5m])) * 100)`,
    ram: `(1 - (node_memory_MemAvailable_bytes{${NODE_JOB},${h}} / node_memory_MemTotal_bytes{${NODE_JOB},${h}})) * 100`,
    disk: `(1 - (node_filesystem_avail_bytes{${NODE_JOB},${h},mountpoint="/",fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes{${NODE_JOB},${h},mountpoint="/",fstype!~"tmpfs|overlay"})) * 100`,
    load: `node_load1{${NODE_JOB},${h}}`,
    boot: `node_boot_time_seconds{${NODE_JOB},${h}}`,
    banned: `sum by(host) (node_security_fail2ban_banned{${NODE_JOB},${h}})`,
    ufwBlocks: `sum by(host) (node_security_ufw_blocks_1h{${NODE_JOB},${h}})`,
  };
}
