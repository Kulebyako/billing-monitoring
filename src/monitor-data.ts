import { config } from './config.js';
import {
  MONITOR_QUERY_KEYS,
  PROMQL,
  type MonitorQueryKey,
} from './monitor-queries.js';
import {
  byHost,
  queryVm,
  sampleHost,
  type VmQueryData,
} from './vm.js';

/** Panel snapshot cache lifetime. */
export const MONITOR_CACHE_TTL_MS = 30_000;

const TOP_LIMIT = 5;
const ERROR_TEXT_LIMIT = 240;

export type MonitorTop = { host: string; value: number };

export type MonitorHost = {
  host: string;
  provider: string | null;
  role: string | null;
  env: string | null;
  instance: string | null;
  icmpUp: boolean | null;
  rttP50Ms: number | null;
  rttP95Ms: number | null;
  nodeUp: boolean | null;
  cpu: number | null;
  ram: number | null;
  disk: number | null;
  load1: number | null;
  bootTime: number | null;
  uptimeSec: number | null;
  ufwEnabled: boolean | null;
  ufwBlocks1h: number | null;
  fail2banBanned: number | null;
};

export type MonitorHostCounts = {
  total: number;
  up: number;
  down: number;
  icmpDown: number;
  nodeDown: number;
};

export type MonitorAverages = {
  cpu: number | null;
  ram: number | null;
  disk: number | null;
};

export type MonitorSecurity = {
  ufwEnabled: number | null;
  ufwTotal: number | null;
  ufwBlocks1h: number | null;
  fail2banBanned: number | null;
};

export type MonitorOverview = {
  available: boolean;
  reason?: string;
  updatedAt: string | null;
  cached: boolean;
  hosts: MonitorHostCounts;
  averages: MonitorAverages;
  security: MonitorSecurity;
  top: { cpu: MonitorTop[]; ram: MonitorTop[]; disk: MonitorTop[] };
};

export type MonitorHosts = {
  available: boolean;
  reason?: string;
  updatedAt: string | null;
  cached: boolean;
  hosts: MonitorHost[];
};

type FleetSnapshot = {
  available: boolean;
  reason?: string;
  updatedAt: string | null;
  hosts: MonitorHost[];
};

type HostProps = {
  provider?: string;
  role?: string;
  env?: string;
  instance?: string;
};

type SnapshotResult = { snapshot: FleetSnapshot; cached: boolean };

type HostMaps = {
  icmp: Map<string, number>;
  rttP50: Map<string, number>;
  rttP95: Map<string, number>;
  nodeUp: Map<string, number>;
  cpu: Map<string, number>;
  ram: Map<string, number>;
  disk: Map<string, number>;
  load: Map<string, number>;
  boot: Map<string, number>;
  ufwOn: Map<string, number>;
  ufwBlocks: Map<string, number>;
  banned: Map<string, number>;
};

function errorText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return message.length > ERROR_TEXT_LIMIT
    ? `${message.slice(0, ERROR_TEXT_LIMIT)}…`
    : message;
}

function round1(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 10) / 10;
}

function asBool(value: number | undefined): boolean | null {
  if (value === 1) return true;
  if (value === 0) return false;
  return null;
}

function cleanInstance(raw: string | undefined): string | null {
  if (!raw) return null;
  // node-exporter targets are usually exposed as "<ip>:9100"; show the IP.
  return raw.replace(/:9100$/, '');
}

function unavailable(reason: string): FleetSnapshot {
  return { available: false, reason, updatedAt: null, hosts: [] };
}

/** Keep the first non-empty label set for a host; probe labels win over node. */
function collectLabels(data: VmQueryData | undefined, out: Map<string, HostProps>): void {
  for (const sample of data?.result ?? []) {
    const host = sampleHost(sample.metric);
    const cur = out.get(host) ?? {};
    if (!cur.provider && sample.metric.provider) cur.provider = sample.metric.provider;
    if (!cur.role && sample.metric.role) cur.role = sample.metric.role;
    if (!cur.env && sample.metric.env) cur.env = sample.metric.env;
    if (!cur.instance && sample.metric.instance) cur.instance = sample.metric.instance;
    out.set(host, cur);
  }
}

function buildHostRow(
  host: string,
  maps: HostMaps,
  labels: Map<string, HostProps>,
  nowSec: number,
): MonitorHost {
  const props = labels.get(host);
  const rawBoot = maps.boot.get(host);
  const bootTime =
    rawBoot != null && Number.isFinite(rawBoot) ? Math.round(rawBoot) : null;
  const uptimeSec =
    bootTime == null ? null : Math.max(0, Math.round(nowSec - bootTime));
  const rttP50 = maps.rttP50.get(host);
  const rttP95 = maps.rttP95.get(host);

  return {
    host,
    provider: props?.provider ?? null,
    role: props?.role ?? null,
    env: props?.env ?? null,
    instance: cleanInstance(props?.instance),
    icmpUp: asBool(maps.icmp.get(host)),
    rttP50Ms: round1(rttP50 == null ? undefined : rttP50 * 1000),
    rttP95Ms: round1(rttP95 == null ? undefined : rttP95 * 1000),
    nodeUp: asBool(maps.nodeUp.get(host)),
    cpu: round1(maps.cpu.get(host)),
    ram: round1(maps.ram.get(host)),
    disk: round1(maps.disk.get(host)),
    load1: round1(maps.load.get(host)),
    bootTime,
    uptimeSec,
    ufwEnabled: asBool(maps.ufwOn.get(host)),
    ufwBlocks1h: round1(maps.ufwBlocks.get(host)),
    fail2banBanned: round1(maps.banned.get(host)),
  };
}

function buildSnapshot(data: Partial<Record<MonitorQueryKey, VmQueryData>>): FleetSnapshot {
  const updatedAt = new Date().toISOString();
  const nowSec = Date.now() / 1000;
  const maps: HostMaps = {
    icmp: byHost(data.probe),
    rttP50: byHost(data.rttP50ByHost),
    rttP95: byHost(data.rttP95ByHost),
    nodeUp: byHost(data.nodeUp),
    cpu: byHost(data.cpu),
    ram: byHost(data.ram),
    disk: byHost(data.disk),
    load: byHost(data.load),
    boot: byHost(data.boot),
    ufwOn: byHost(data.ufwOn),
    ufwBlocks: byHost(data.ufwBlocks),
    banned: byHost(data.banned),
  };

  const labels = new Map<string, HostProps>();
  // Probe first so its plain IP instance wins over the node-exporter ":9100".
  collectLabels(data.probe, labels);
  collectLabels(data.nodeUp, labels);
  collectLabels(data.cpu, labels);
  collectLabels(data.ram, labels);
  collectLabels(data.disk, labels);
  collectLabels(data.load, labels);
  collectLabels(data.boot, labels);
  collectLabels(data.ufwOn, labels);
  collectLabels(data.ufwBlocks, labels);
  collectLabels(data.banned, labels);

  const hosts = new Set<string>(labels.keys());
  for (const map of Object.values(maps)) {
    for (const host of map.keys()) hosts.add(host);
  }

  const rows = [...hosts]
    .map((host) => buildHostRow(host, maps, labels, nowSec))
    .sort((a, b) => a.host.localeCompare(b.host));

  return { available: true, updatedAt, hosts: rows };
}

async function fetchFleetSnapshot(): Promise<FleetSnapshot> {
  if (!config.victoriaMetricsUrl) {
    return unavailable('VICTORIAMETRICS_URL не задан');
  }

  const settled = await Promise.allSettled(
    MONITOR_QUERY_KEYS.map((key) => queryVm(PROMQL[key])),
  );

  const data: Partial<Record<MonitorQueryKey, VmQueryData>> = {};
  const errors: string[] = [];
  settled.forEach((result, index) => {
    const key = MONITOR_QUERY_KEYS[index];
    if (result.status === 'fulfilled') {
      if (result.value) data[key] = result.value;
      return;
    }
    errors.push(`${key}: ${errorText(result.reason)}`);
  });

  if (errors.length === MONITOR_QUERY_KEYS.length) {
    const first = errors[0] ?? 'unknown error';
    return unavailable(`VictoriaMetrics недоступна: ${first}`);
  }
  if (errors.length > 0) {
    console.warn(
      `[monitor] ${errors.length}/${MONITOR_QUERY_KEYS.length} VM queries failed (${errors[0]})`,
    );
  }
  return buildSnapshot(data);
}

let cache: { at: number; snapshot: FleetSnapshot } | null = null;
let inflight: Promise<FleetSnapshot> | null = null;

/** Cached (30 s) fleet snapshot shared by overview and hosts. */
export async function getMonitorSnapshot(): Promise<SnapshotResult> {
  const now = Date.now();
  if (cache && now - cache.at < MONITOR_CACHE_TTL_MS) {
    return { snapshot: cache.snapshot, cached: true };
  }
  if (!inflight) {
    inflight = fetchFleetSnapshot()
      .then((snapshot) => {
        // Do not cache VM outages: the next request should retry immediately.
        if (snapshot.available) cache = { at: Date.now(), snapshot };
        return snapshot;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return { snapshot: await inflight, cached: false };
}

function emptyCounts(): MonitorHostCounts {
  return { total: 0, up: 0, down: 0, icmpDown: 0, nodeDown: 0 };
}

function emptyAverages(): MonitorAverages {
  return { cpu: null, ram: null, disk: null };
}

function emptySecurity(): MonitorSecurity {
  return { ufwEnabled: null, ufwTotal: null, ufwBlocks1h: null, fail2banBanned: null };
}

export function unavailableOverview(reason: string): MonitorOverview {
  return {
    available: false,
    reason,
    updatedAt: null,
    cached: false,
    hosts: emptyCounts(),
    averages: emptyAverages(),
    security: emptySecurity(),
    top: { cpu: [], ram: [], disk: [] },
  };
}

export function unavailableHosts(reason: string): MonitorHosts {
  return { available: false, reason, updatedAt: null, cached: false, hosts: [] };
}

function numericValues(rows: MonitorHost[], key: 'cpu' | 'ram' | 'disk'): number[] {
  const values: number[] = [];
  for (const row of rows) {
    const value = row[key];
    if (value != null) values.push(value);
  }
  return values;
}

function average(rows: MonitorHost[], key: 'cpu' | 'ram' | 'disk'): number | null {
  const values = numericValues(rows, key);
  if (values.length === 0) return null;
  return round1(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function sumMetric(
  rows: MonitorHost[],
  key: 'ufwBlocks1h' | 'fail2banBanned',
): number | null {
  const values: number[] = [];
  for (const row of rows) {
    const value = row[key];
    if (value != null) values.push(value);
  }
  if (values.length === 0) return null;
  return round1(values.reduce((sum, value) => sum + value, 0));
}

function topBy(rows: MonitorHost[], key: 'cpu' | 'ram' | 'disk'): MonitorTop[] {
  const out: MonitorTop[] = [];
  for (const row of rows) {
    const value = row[key];
    if (value != null) out.push({ host: row.host, value });
  }
  out.sort((a, b) => b.value - a.value);
  return out.slice(0, TOP_LIMIT);
}

export async function getMonitorOverview(): Promise<MonitorOverview> {
  try {
    const { snapshot, cached } = await getMonitorSnapshot();
    if (!snapshot.available) {
      return {
        ...unavailableOverview(snapshot.reason ?? 'VictoriaMetrics недоступна'),
        cached,
      };
    }

    const rows = snapshot.hosts;
    const icmpDown = rows.filter((row) => row.icmpUp === false).length;
    const nodeDown = rows.filter((row) => row.nodeUp === false).length;
    // Availability is ICMP-first; for hosts without a probe fall back to node up.
    const down = rows.filter(
      (row) => row.icmpUp === false || (row.icmpUp == null && row.nodeUp === false),
    ).length;
    const total = rows.length;

    const ufwRows = rows.filter((row) => row.ufwEnabled != null);
    const ufwEnabled = ufwRows.length
      ? ufwRows.filter((row) => row.ufwEnabled === true).length
      : null;

    return {
      available: true,
      updatedAt: snapshot.updatedAt,
      cached,
      hosts: { total, up: total - down, down, icmpDown, nodeDown },
      averages: {
        cpu: average(rows, 'cpu'),
        ram: average(rows, 'ram'),
        disk: average(rows, 'disk'),
      },
      security: {
        ufwEnabled,
        ufwTotal: ufwRows.length || null,
        ufwBlocks1h: sumMetric(rows, 'ufwBlocks1h'),
        fail2banBanned: sumMetric(rows, 'fail2banBanned'),
      },
      top: {
        cpu: topBy(rows, 'cpu'),
        ram: topBy(rows, 'ram'),
        disk: topBy(rows, 'disk'),
      },
    };
  } catch (e) {
    const reason = `Ошибка мониторинга: ${errorText(e)}`;
    console.error('[monitor] overview failed', errorText(e));
    return unavailableOverview(reason);
  }
}

export async function getMonitorHosts(): Promise<MonitorHosts> {
  try {
    const { snapshot, cached } = await getMonitorSnapshot();
    if (!snapshot.available) {
      return {
        ...unavailableHosts(snapshot.reason ?? 'VictoriaMetrics недоступна'),
        cached,
      };
    }
    return {
      available: true,
      updatedAt: snapshot.updatedAt,
      cached,
      hosts: snapshot.hosts,
    };
  } catch (e) {
    const reason = `Ошибка мониторинга: ${errorText(e)}`;
    console.error('[monitor] hosts failed', errorText(e));
    return unavailableHosts(reason);
  }
}
