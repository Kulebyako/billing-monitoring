import { config } from './config.js';
import { sendTelegram } from './telegram.js';
import { queryVm } from './vm.js';
import {
  formatDownAlert,
  formatHourlySummary,
  formatUpAlert,
} from './tg-monitor.js';
import { b, escMd, joinBlocks } from './tg-format.js';

type ProbeSample = {
  host: string;
  instance: string;
  success: number;
};

type HostState = {
  status: 'up' | 'down' | 'unknown';
  failTicks: number;
};

const hostState = new Map<string, HostState>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchProbes(): Promise<ProbeSample[]> {
  const data = await queryVm('probe_success{job="blackbox-icmp"}');
  if (!data) return [];
  return data.result.map((r) => ({
    host: r.metric.host || r.metric.instance || 'unknown',
    instance: r.metric.instance || '',
    success: Number(r.value[1]),
  }));
}

async function checkProbes(): Promise<void> {
  if (!config.victoriaMetricsUrl) return;
  if (!config.telegramBotToken || !config.telegramChatId) return;

  let probes: ProbeSample[];
  try {
    probes = await fetchProbes();
  } catch (e) {
    console.error('[monitor] probe query failed', (e as Error).message);
    return;
  }

  if (probes.length === 0) {
    console.warn('[monitor] no probe_success series');
    return;
  }

  const downTicksNeeded = Math.max(1, config.monitorDownTicks);

  for (const p of probes) {
    let st = hostState.get(p.host);
    if (!st) {
      st = { status: 'unknown', failTicks: 0 };
      hostState.set(p.host, st);
    }

    const isDown = p.success === 0;
    if (isDown) {
      st.failTicks += 1;
      if (st.failTicks >= downTicksNeeded && st.status !== 'down') {
        st.status = 'down';
        await sendTelegram(formatDownAlert(p.host, p.instance));
      }
    } else {
      st.failTicks = 0;
      if (st.status === 'down') {
        st.status = 'up';
        await sendTelegram(formatUpAlert(p.host, p.instance));
      } else {
        st.status = 'up';
      }
    }
  }
}

export async function sendMonitorSummary(): Promise<boolean> {
  try {
    const text = await formatHourlySummary();
    return sendTelegram(text);
  } catch (e) {
    console.error('[monitor] summary failed', (e as Error).message);
    await sendTelegram(
      joinBlocks([
        b('⚠️ Мониторинг'),
        `Не удалось опросить VictoriaMetrics:\n${escMd((e as Error).message)}`,
      ]),
    );
    return false;
  }
}

export function startMonitorAlerts(): void {
  if (!config.victoriaMetricsUrl) {
    console.warn('[monitor] VICTORIAMETRICS_URL empty — alerts disabled');
    return;
  }
  const ms = Math.max(15_000, config.monitorPollMs);
  console.log(`[monitor] ICMP alerts every ${ms}ms, downTicks=${config.monitorDownTicks}`);
  void checkProbes();
  pollTimer = setInterval(() => {
    void checkProbes();
  }, ms);
  if (typeof pollTimer === 'object' && 'unref' in pollTimer) {
    pollTimer.unref();
  }
}
