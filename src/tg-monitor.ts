import { config } from './config.js';
import { listAccounts, listServices } from './db.js';
import {
  b,
  bullet,
  code,
  escMd,
  i,
  joinBlocks,
  kv,
  nowMoscow,
  section,
  tracksBalance,
} from './tg-format.js';
import { hostQueries, PROMQL } from './monitor-queries.js';
import {
  byHost,
  fmtMs,
  fmtNum,
  fmtPct,
  queryVm,
  sampleHost,
  sampleNum,
  topN,
} from './vm.js';

function daysUntil(dueAt: string | null): number | null {
  if (!dueAt) return null;
  const due = new Date(dueAt.slice(0, 10) + 'T12:00:00');
  if (Number.isNaN(due.getTime())) return null;
  const now = new Date();
  const today = new Date(now.toISOString().slice(0, 10) + 'T12:00:00');
  return Math.round((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}

function billingSnapshot(): {
  urgent: number;
  low: number;
  syncErr: number;
  urgentNames: string[];
  lowNames: string[];
  balances: string[];
} {
  const services = listServices().filter((s) => s.status !== 'missing' && s.status !== 'deleted');
  const urgentList = services.filter((s) => {
    const d = daysUntil(s.due_at);
    return d != null && d <= 7;
  });
  const balanceServices = services.filter(
    (s) => tracksBalance(s.provider) && s.balance != null,
  );
  const lowList = balanceServices.filter(
    (s) => s.balance != null && s.balance <= config.balanceThreshold && s.balance >= 0,
  );
  const syncErr = listAccounts().filter((a) => a.last_error).length;
  return {
    urgent: urgentList.length,
    low: lowList.length,
    syncErr,
    urgentNames: urgentList
      .slice(0, 6)
      .map((s) => `${s.name}${s.due_at ? ` · ${s.due_at}` : ''}`),
    lowNames: lowList.map(
      (s) => `${s.name}: ${s.balance}${s.currency ? ` ${s.currency}` : ''}`,
    ),
    balances: balanceServices.map(
      (s) => `${s.provider}/${s.name}: ${s.balance}${s.currency ? ` ${s.currency}` : ''}`,
    ),
  };
}

async function requireVm() {
  if (!config.victoriaMetricsUrl) {
    throw new Error('VICTORIAMETRICS_URL не задан');
  }
}

function fmtUptime(bootUnix: number | undefined): string {
  if (bootUnix == null || !Number.isFinite(bootUnix)) return '—';
  const sec = Math.max(0, Date.now() / 1000 - bootUnix);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  if (d > 0) return `${d}д ${h}ч`;
  const m = Math.floor((sec % 3600) / 60);
  return `${h}ч ${m}м`;
}

function statusIcon(ok: boolean | undefined): string {
  if (ok == null) return '—';
  return ok ? '🟢' : '🔴';
}

function warnIcon(v: number | undefined, soft: number, hard: number): string {
  if (v == null || !Number.isFinite(v)) return '';
  if (v >= hard) return ' 🔴';
  if (v >= soft) return ' 🟡';
  return '';
}

/** Rich hourly /status report. */
export async function formatStatus(): Promise<string> {
  return formatFleetReport({ title: '📡 Статус флота', hourly: false });
}

/** Hourly digest — same data, labeled as сводка. */
export async function formatHourlySummary(): Promise<string> {
  return formatFleetReport({ title: '⏱ Сводка за час', hourly: true });
}

async function formatFleetReport(opts: { title: string; hourly: boolean }): Promise<string> {
  await requireVm();
  const [probeData, nodeData, rttP50, rttP95, cpu, ram, disk, blocks] = await Promise.all([
    queryVm(PROMQL.probe),
    queryVm(PROMQL.nodeUp),
    queryVm(PROMQL.rttP50),
    queryVm(PROMQL.rttP95),
    queryVm(PROMQL.cpu),
    queryVm(PROMQL.ram),
    queryVm(PROMQL.disk),
    queryVm(PROMQL.ufwBlocks),
  ]);

  const probes = probeData?.result ?? [];
  const icmpUp = probes.filter((s) => sampleNum(s) === 1);
  const icmpDown = probes.filter((s) => sampleNum(s) === 0);
  const nodes = nodeData?.result ?? [];
  const nodeUp = nodes.filter((s) => sampleNum(s) === 1);
  const nodeDown = nodes.filter((s) => sampleNum(s) === 0);

  const p50 = rttP50?.result?.[0] ? sampleNum(rttP50.result[0]) : undefined;
  const p95 = rttP95?.result?.[0] ? sampleNum(rttP95.result[0]) : undefined;

  const bill = billingSnapshot();
  const allOk = icmpDown.length === 0 && nodeDown.length === 0;

  const header = [
    b(opts.title),
    i(`${nowMoscow()} MSK`),
    '',
    `${escMd('ICMP')}  ${icmpUp.length}/${probes.length} ${statusIcon(icmpDown.length === 0)}`,
    `${escMd('node')}  ${nodeUp.length}/${nodes.length} ${statusIcon(nodeDown.length === 0)}`,
    `${escMd('RTT')}   p50 ${code(fmtMs(p50))} · p95 ${code(fmtMs(p95))}`,
  ].join('\n');

  const problemLines: string[] = [];
  if (icmpDown.length) {
    for (const s of icmpDown.sort((a, b) =>
      sampleHost(a.metric).localeCompare(sampleHost(b.metric)),
    )) {
      problemLines.push(
        bullet(`ICMP ${code(sampleHost(s.metric))} ${code(s.metric.instance || '—')}`),
      );
    }
  }
  if (nodeDown.length) {
    for (const s of nodeDown.sort((a, b) =>
      sampleHost(a.metric).localeCompare(sampleHost(b.metric)),
    )) {
      problemLines.push(bullet(`node ${code(sampleHost(s.metric))}`));
    }
  }
  const problems = allOk
    ? section('Проблемы', [`✅ ${escMd('всё в норме')}`])
    : section('Проблемы', problemLines);

  const hotCpu = topN(byHost(cpu), 3, true).filter((r) => r.value >= 70);
  const hotRam = topN(byHost(ram), 3, true).filter((r) => r.value >= 80);
  const hotDisk = topN(byHost(disk), 3, true).filter((r) => r.value >= 80);
  const hotLines: string[] = [];
  for (const r of hotCpu) {
    hotLines.push(bullet(`CPU ${code(r.host)} ${code(fmtPct(r.value))}${warnIcon(r.value, 70, 90)}`));
  }
  for (const r of hotRam) {
    hotLines.push(bullet(`RAM ${code(r.host)} ${code(fmtPct(r.value))}${warnIcon(r.value, 80, 90)}`));
  }
  for (const r of hotDisk) {
    hotLines.push(
      bullet(`disk ${code(r.host)} ${code(fmtPct(r.value))}${warnIcon(r.value, 80, 92)}`),
    );
  }
  const hotspots = hotLines.length
    ? section('Нагрузка', hotLines)
    : section('Нагрузка', [`✅ ${escMd('без пиков')}`]);

  const billLines: string[] = [
    `${escMd('Оплаты ≤7д')}: ${bill.urgent}`,
    `${escMd('Sync err')}: ${bill.syncErr}`,
  ];
  if (bill.urgentNames.length) {
    billLines.push('');
    for (const n of bill.urgentNames) billLines.push(bullet(escMd(n)));
  }
  if (bill.balances.length) {
    billLines.push('');
    billLines.push(i('Баланс hsvds / vpsville'));
    for (const n of bill.balances) billLines.push(bullet(escMd(n)));
  }
  if (bill.lowNames.length) {
    billLines.push('');
    billLines.push(i('Низкий баланс'));
    for (const n of bill.lowNames) billLines.push(bullet(escMd(n)));
  }
  const billing = section('Биллинг', billLines);

  // UFW: metric is rolling last-hour count from journalctl on each host
  const blockTop = topN(byHost(blocks), 5, true).filter((r) => r.value > 0);
  const sec = blockTop.length
    ? section(
        'UFW blocks · последний час',
        blockTop.map((r) => bullet(`${code(r.host)} ${code(String(Math.round(r.value)))}`)),
      )
    : '';

  return joinBlocks([header, problems, hotspots, billing, sec]);
}

export async function formatDown(): Promise<string> {
  await requireVm();
  const [probeData, nodeData] = await Promise.all([queryVm(PROMQL.probe), queryVm(PROMQL.nodeUp)]);

  const icmpDown = (probeData?.result ?? []).filter((s) => sampleNum(s) === 0);
  const nodeDown = (nodeData?.result ?? []).filter((s) => sampleNum(s) === 0);

  if (!icmpDown.length && !nodeDown.length) {
    return joinBlocks([b('Всё в сети'), escMd('Нет хостов down по ICMP и node_exporter.')]);
  }

  const lines: string[] = [b('Проблемные хосты'), i(`${nowMoscow()} MSK`)];
  if (icmpDown.length) {
    lines.push('', i('ICMP'));
    for (const s of icmpDown.sort((a, b) =>
      sampleHost(a.metric).localeCompare(sampleHost(b.metric)),
    )) {
      lines.push(bullet(`${code(sampleHost(s.metric))} ${code(s.metric.instance || '—')}`));
    }
  }
  if (nodeDown.length) {
    lines.push('', i('node'));
    for (const s of nodeDown.sort((a, b) =>
      sampleHost(a.metric).localeCompare(sampleHost(b.metric)),
    )) {
      lines.push(bullet(code(sampleHost(s.metric))));
    }
  }
  return lines.join('\n');
}

export async function formatHost(name: string): Promise<string> {
  await requireVm();
  const host = name.trim();
  if (!host) return `Укажите хост: ${code('/host NAME')}`;

  const esc = host.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const hq = hostQueries(esc);
  const [
    probeData,
    rttData,
    nodeData,
    cpuData,
    ramData,
    diskData,
    loadData,
    bootData,
    bannedData,
    blocksData,
  ] = await Promise.all([
    queryVm(hq.probe),
    queryVm(hq.rtt),
    queryVm(hq.nodeUp),
    queryVm(hq.cpu),
    queryVm(hq.ram),
    queryVm(hq.disk),
    queryVm(hq.load),
    queryVm(hq.boot),
    queryVm(hq.banned),
    queryVm(hq.ufwBlocks),
  ]);

  const probe = probeData?.result?.[0];
  const node = nodeData?.result?.[0];
  if (!probe && !node) {
    return `${escMd('Хост')} ${code(host)} ${escMd('не найден в метриках.')}`;
  }

  const pingOk = probe ? sampleNum(probe) === 1 : undefined;
  const nodeOk = node ? sampleNum(node) === 1 : undefined;
  const ip = probe?.metric.instance || node?.metric.instance || '—';
  const rtt = rttData?.result?.[0] ? sampleNum(rttData.result[0]) : undefined;
  const cpu = cpuData?.result?.[0] ? sampleNum(cpuData.result[0]) : undefined;
  const ram = ramData?.result?.[0] ? sampleNum(ramData.result[0]) : undefined;
  const disk = diskData?.result?.[0] ? sampleNum(diskData.result[0]) : undefined;
  const load = loadData?.result?.[0] ? sampleNum(loadData.result[0]) : undefined;
  const boot = bootData?.result?.[0] ? sampleNum(bootData.result[0]) : undefined;
  const banned = bannedData?.result?.[0] ? sampleNum(bannedData.result[0]) : undefined;
  const blocks = blocksData?.result?.[0] ? sampleNum(blocksData.result[0]) : undefined;

  return joinBlocks([
    `${b(host)}\n${code(ip)}`,
    [
      kv('ICMP', `${statusIcon(pingOk)} · RTT ${code(fmtMs(rtt))}`),
      kv('node', statusIcon(nodeOk)),
      kv('CPU', `${code(fmtPct(cpu))}${warnIcon(cpu, 70, 90)}`),
      kv('RAM', `${code(fmtPct(ram))}${warnIcon(ram, 80, 90)}`),
      kv('disk', `${code(fmtPct(disk))}${warnIcon(disk, 80, 92)}`),
      kv('load1', code(fmtNum(load, 2))),
      kv('uptime', code(fmtUptime(boot))),
      kv('fail2ban', banned != null ? code(String(banned)) : escMd('—')),
      kv('UFW 1h', blocks != null ? code(String(Math.round(blocks))) : escMd('—')),
    ].join('\n'),
  ]);
}

export async function formatTop(): Promise<string> {
  await requireVm();
  const [cpu, ram, disk, rtt] = await Promise.all([
    queryVm(PROMQL.cpu),
    queryVm(PROMQL.ram),
    queryVm(PROMQL.disk),
    queryVm(PROMQL.rtt),
  ]);

  const blocks: string[] = [b('Топ нагрузки'), i(`${nowMoscow()} MSK`)];
  const sections: Array<[string, Map<string, number>, (v: number) => string]> = [
    ['CPU', byHost(cpu), (v) => fmtPct(v)],
    ['RAM', byHost(ram), (v) => fmtPct(v)],
    ['disk', byHost(disk), (v) => fmtPct(v)],
    ['RTT', byHost(rtt), (v) => fmtMs(v)],
  ];

  for (const [title, map, fmt] of sections) {
    blocks.push('');
    blocks.push(i(title));
    const top = topN(map, 5, true);
    if (!top.length) {
      blocks.push(bullet(escMd('нет данных')));
      continue;
    }
    top.forEach((row, idx) => {
      blocks.push(bullet(`${idx + 1}\\. ${code(row.host)} — ${code(fmt(row.value))}`));
    });
  }
  return blocks.join('\n');
}

export async function formatSec(): Promise<string> {
  await requireVm();
  const [banned, blocks, ufwOn] = await Promise.all([
    queryVm(PROMQL.banned),
    queryVm(PROMQL.ufwBlocks),
    queryVm(PROMQL.ufwOn),
  ]);

  const bannedMap = byHost(banned);
  const blocksMap = byHost(blocks);
  const ufwMap = byHost(ufwOn);

  let bannedSum = 0;
  const withBans: Array<{ host: string; value: number }> = [];
  for (const [host, v] of bannedMap) {
    bannedSum += v;
    if (v > 0) withBans.push({ host, value: v });
  }
  withBans.sort((a, b) => b.value - a.value);

  const ufwEnabled = [...ufwMap.values()].filter((v) => v === 1).length;
  const ufwTotal = ufwMap.size;

  const lines = [
    b('Security'),
    i(`${nowMoscow()} MSK`),
    '',
    kv('fail2ban banned', code(String(bannedSum))),
    kv('UFW enabled', code(`${ufwEnabled}/${ufwTotal || '—'}`)),
  ];

  if (withBans.length) {
    lines.push('', i('Баны'));
    for (const row of withBans.slice(0, 12)) {
      lines.push(bullet(`${code(row.host)} — ${code(String(row.value))}`));
    }
  } else {
    lines.push('', escMd('Активных банов fail2ban нет.'));
  }

  const topBlocks = topN(blocksMap, 8, true).filter((r) => r.value > 0);
  if (topBlocks.length) {
    lines.push('', i('UFW blocks · последний час'));
    for (const row of topBlocks) {
      lines.push(bullet(`${code(row.host)} — ${code(String(row.value))}`));
    }
  }

  return lines.join('\n');
}

export function formatDownAlert(host: string, ip: string): string {
  return joinBlocks([
    b('DOWN'),
    [
      kv('Хост', code(host)),
      kv('IP', code(ip || '—')),
      kv('Время', i(`${nowMoscow()} MSK`)),
    ].join('\n'),
    i('ICMP probe_success = 0'),
  ]);
}

export function formatUpAlert(host: string, ip: string): string {
  return joinBlocks([
    b('UP'),
    [
      kv('Хост', code(host)),
      kv('IP', code(ip || '—')),
      kv('Время', i(`${nowMoscow()} MSK`)),
    ].join('\n'),
  ]);
}

export async function handleMonitorCommand(cmd: string, args: string): Promise<string | null> {
  switch (cmd) {
    case '/status':
      return formatStatus();
    case '/down':
      return formatDown();
    case '/host':
      return formatHost(args);
    case '/top':
      return formatTop();
    case '/sec':
      return formatSec();
    default:
      return null;
  }
}
