import { listAccounts, listServices } from './db.js';
import { config } from './config.js';
import { daysUntil } from './reminders.js';

/** In-memory sync telemetry (resets on process restart). */
const syncSuccess = new Map<string, number>();
const syncError = new Map<string, number>();
const syncLastDurationSec = new Map<string, number>();

function escLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

export function recordSyncResult(
  provider: string,
  ok: boolean,
  durationMs: number,
): void {
  const key = provider || 'unknown';
  if (ok) {
    syncSuccess.set(key, (syncSuccess.get(key) || 0) + 1);
  } else {
    syncError.set(key, (syncError.get(key) || 0) + 1);
  }
  syncLastDurationSec.set(key, durationMs / 1000);
}

export function renderMetrics(): string {
  const lines: string[] = [];
  const services = listServices().filter(
    (s) => s.status !== 'missing' && s.status !== 'deleted',
  );
  const accounts = listAccounts();

  const byStatus = new Map<string, number>();
  for (const s of services) {
    byStatus.set(s.status, (byStatus.get(s.status) || 0) + 1);
  }

  lines.push('# HELP billing_services_total Services by status');
  lines.push('# TYPE billing_services_total gauge');
  for (const [status, count] of byStatus) {
    lines.push(`billing_services_total{status="${escLabel(status)}"} ${count}`);
  }
  if (!byStatus.size) {
    lines.push('billing_services_total{status="none"} 0');
  }

  let urgent = 0;
  let lowBalance = 0;
  let monthlyCost = 0;
  const now = new Date();
  const daysLeft =
    new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate() + 1;
  let remainingCost = 0;

  for (const s of services) {
    const dueDays = daysUntil(s.due_at);
    if (dueDays != null && dueDays <= 7) urgent++;
    if (s.balance != null && s.balance <= config.balanceThreshold) lowBalance++;
    if (s.cost != null) {
      monthlyCost += s.cost;
      remainingCost += (s.cost / 30) * daysLeft;
    }
  }

  lines.push('# HELP billing_urgent_due_total Services due within 7 days');
  lines.push('# TYPE billing_urgent_due_total gauge');
  lines.push(`billing_urgent_due_total ${urgent}`);

  lines.push('# HELP billing_low_balance_total Services with balance at or below threshold');
  lines.push('# TYPE billing_low_balance_total gauge');
  lines.push(`billing_low_balance_total ${lowBalance}`);

  lines.push('# HELP billing_monthly_cost_total Sum of monthly service costs');
  lines.push('# TYPE billing_monthly_cost_total gauge');
  lines.push(`billing_monthly_cost_total ${round2(monthlyCost)}`);

  lines.push('# HELP billing_remaining_month_cost Estimated spend until month end');
  lines.push('# TYPE billing_remaining_month_cost gauge');
  lines.push(`billing_remaining_month_cost ${round2(remainingCost)}`);

  const syncErrorAccounts = accounts.filter((a) => a.last_error).length;
  lines.push('# HELP billing_sync_error_accounts Provider accounts with last sync error');
  lines.push('# TYPE billing_sync_error_accounts gauge');
  lines.push(`billing_sync_error_accounts ${syncErrorAccounts}`);

  lines.push('# HELP billing_last_sync_timestamp Last successful sync unix time');
  lines.push('# TYPE billing_last_sync_timestamp gauge');
  for (const a of accounts) {
    if (!a.last_synced_at) continue;
    const ts = Math.floor(new Date(a.last_synced_at).getTime() / 1000);
    lines.push(
      `billing_last_sync_timestamp{provider="${escLabel(a.provider)}"} ${ts}`,
    );
  }

  lines.push('# HELP billing_sync_total Sync operations since process start');
  lines.push('# TYPE billing_sync_total counter');
  const providers = new Set([...syncSuccess.keys(), ...syncError.keys()]);
  for (const p of providers) {
    const ok = syncSuccess.get(p) || 0;
    const err = syncError.get(p) || 0;
    if (ok) lines.push(`billing_sync_total{provider="${escLabel(p)}",result="ok"} ${ok}`);
    if (err) lines.push(`billing_sync_total{provider="${escLabel(p)}",result="error"} ${err}`);
  }

  lines.push('# HELP billing_sync_duration_seconds Duration of last sync');
  lines.push('# TYPE billing_sync_duration_seconds gauge');
  for (const [p, sec] of syncLastDurationSec) {
    lines.push(`billing_sync_duration_seconds{provider="${escLabel(p)}"} ${round2(sec)}`);
  }

  return `${lines.join('\n')}\n`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
