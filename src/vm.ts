import { config } from './config.js';

export type VmSample = {
  metric: Record<string, string>;
  value: [number, string];
};

export type VmQueryData = {
  resultType: string;
  result: VmSample[];
};

type VmVectorResult = {
  status: string;
  data?: VmQueryData;
};

export async function queryVm(promql: string): Promise<VmQueryData | undefined> {
  if (!config.victoriaMetricsUrl) return undefined;
  const url = `${config.victoriaMetricsUrl}/api/v1/query?query=${encodeURIComponent(promql)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`VM query ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as VmVectorResult;
  if (body.status !== 'success') {
    throw new Error(`VM status=${body.status}`);
  }
  return body.data;
}

export function sampleHost(m: Record<string, string>): string {
  return m.host || m.instance || 'unknown';
}

export function sampleNum(s: VmSample): number {
  return Number(s.value[1]);
}

/** Map host → numeric value from instant vector. */
export function byHost(data: VmQueryData | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!data) return out;
  for (const s of data.result) {
    out.set(sampleHost(s.metric), sampleNum(s));
  }
  return out;
}

export function topN(
  map: Map<string, number>,
  n: number,
  desc = true,
): Array<{ host: string; value: number }> {
  const arr = [...map.entries()].map(([host, value]) => ({ host, value }));
  arr.sort((a, b) => (desc ? b.value - a.value : a.value - b.value));
  return arr.slice(0, n);
}

export function fmtPct(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v.toFixed(0)}%`;
}

export function fmtMs(seconds: number | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  return `${(seconds * 1000).toFixed(1)} ms`;
}

export function fmtNum(v: number | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}
