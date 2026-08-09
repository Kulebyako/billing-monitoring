import { config } from './config.js';
import { getDb, listServices, listAccounts, type ServiceRow } from './db.js';
import { sendTelegram, pollTelegramCommands } from './telegram.js';
import { syncAll, publicService } from './sync.js';
import { handleMonitorCommand } from './tg-monitor.js';
import { b, bullet, code, escMd, i, joinBlocks, kv, link, tracksBalance } from './tg-format.js';

function daysUntil(dueAt: string | null): number | null {
  if (!dueAt) return null;
  const due = new Date(dueAt.slice(0, 10) + 'T12:00:00');
  if (Number.isNaN(due.getTime())) return null;
  const now = new Date();
  const today = new Date(now.toISOString().slice(0, 10) + 'T12:00:00');
  return Math.round((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}

function alreadySent(serviceId: number, kind: string): boolean {
  const row = getDb()
    .prepare('SELECT id FROM reminder_log WHERE service_id = ? AND kind = ?')
    .get(serviceId, kind);
  return !!row;
}

function markSent(serviceId: number, kind: string): void {
  getDb()
    .prepare(
      `INSERT INTO reminder_log (service_id, kind) VALUES (?, ?)
       ON CONFLICT(service_id, kind) DO UPDATE SET sent_at = datetime('now')`,
    )
    .run(serviceId, kind);
}

function formatServiceHtml(s: ServiceRow): string {
  const lines = [b(`[${s.provider}] ${s.name}`)];
  if (s.ip) lines.push(kv('IP', code(s.ip)));
  if (s.due_at) {
    const d = daysUntil(s.due_at);
    lines.push(kv('Оплата', `${code(s.due_at)}${d != null ? escMd(` (${d}д)`) : ''}`));
  }
  if (s.cost != null) {
    lines.push(kv('Стоимость', escMd(`${s.cost} ${s.currency || ''}`.trim())));
  }
  if (tracksBalance(s.provider) && s.balance != null) {
    lines.push(kv('Баланс', escMd(`${s.balance} ${s.currency || ''}`.trim())));
  }
  if (s.billing_url) {
    lines.push(link(s.billing_url, 'Открыть биллинг'));
  }
  return lines.join('\n');
}

/** Plain one-liner for compact lists */
function formatService(s: ServiceRow): string {
  const parts = [`[${s.provider}] ${s.name}`];
  if (s.ip) parts.push(`IP ${s.ip}`);
  if (s.due_at) {
    const d = daysUntil(s.due_at);
    parts.push(`до ${s.due_at}` + (d != null ? ` (${d}д)` : ''));
  }
  if (s.cost != null) parts.push(`${s.cost} ${s.currency || ''}`.trim());
  if (tracksBalance(s.provider) && s.balance != null) {
    parts.push(`баланс ${s.balance} ${s.currency || ''}`.trim());
  }
  return parts.join(' · ');
}

export async function runReminders(): Promise<number> {
  const services = listServices().filter((s) => s.status !== 'missing' && s.status !== 'deleted');
  let sent = 0;

  for (const s of services) {
    const days = daysUntil(s.due_at);
    if (days != null && config.reminderDays.includes(days)) {
      const kind = `due:${s.due_at}:${days}`;
      if (!alreadySent(s.id, kind)) {
        const ok = await sendTelegram(
          joinBlocks([b('⏰ Оплата скоро'), formatServiceHtml(s)]),
        );
        if (ok) {
          markSent(s.id, kind);
          sent++;
        }
      }
    }

    if (
      tracksBalance(s.provider) &&
      s.balance != null &&
      s.balance <= config.balanceThreshold &&
      s.balance >= 0
    ) {
      const kind = `balance:${Math.floor(s.balance)}`;
      if (!alreadySent(s.id, kind)) {
        const ok = await sendTelegram(
          joinBlocks([
            b('💸 Низкий баланс'),
            formatServiceHtml(s),
            kv('Порог', String(config.balanceThreshold)),
          ]),
        );
        if (ok) {
          markSent(s.id, kind);
          sent++;
        }
      }
    }

    if (days != null && days < 0) {
      const kind = `overdue:${s.due_at}`;
      if (!alreadySent(s.id, kind)) {
        const ok = await sendTelegram(
          joinBlocks([b('🚨 Просрочено'), formatServiceHtml(s)]),
        );
        if (ok) {
          markSent(s.id, kind);
          sent++;
        }
      }
    }
  }

  return sent;
}

function formatListHtml(services: ServiceRow[], limit = 30): string {
  if (!services.length) return i('Пусто.');
  return services
    .slice(0, limit)
    .map((s, idx) => bullet(`${idx + 1}\\. ${escMd(formatService(s))}`))
    .join('\n');
}

export async function handleTgCommand(cmd: string, args: string): Promise<string> {
  try {
    const monitor = await handleMonitorCommand(cmd, args);
    if (monitor != null) return monitor;
  } catch (e) {
    return joinBlocks([b('Ошибка мониторинга'), escMd((e as Error).message)]);
  }

  switch (cmd) {
    case '/start':
    case '/help':
      return joinBlocks([
        b('server-billing'),
        [
          i('Биллинг'),
          bullet(`${code('/list')} — услуги`),
          bullet(`${code('/due')} — оплаты и баланс`),
          bullet(`${code('/sync')} — синхронизация`),
          bullet(`${code('/errors')} — ошибки sync`),
        ].join('\n'),
        [
          i('Мониторинг'),
          bullet(`${code('/status')} — сводка флота`),
          bullet(`${code('/down')} — недоступные`),
          bullet(`${code('/host NAME')} — карточка хоста`),
          bullet(`${code('/top')} — топ CPU/RAM/диск/RTT`),
          bullet(`${code('/sec')} — security`),
        ].join('\n'),
      ]);
    case '/list': {
      const all = listServices().filter((s) => s.status !== 'missing');
      return joinBlocks([b('Услуги'), formatListHtml(all)]);
    }
    case '/due': {
      const due = listServices().filter((s) => {
        const d = daysUntil(s.due_at);
        return d != null && d <= 7;
      });
      const low = listServices().filter(
        (s) =>
          tracksBalance(s.provider) &&
          s.balance != null &&
          s.balance <= config.balanceThreshold,
      );
      return joinBlocks([
        b('Оплаты ≤7 дней'),
        formatListHtml(due),
        b('Низкий баланс · hsvds / vpsville'),
        formatListHtml(low),
      ]);
    }
    case '/sync': {
      await sendTelegram(b('Синхронизация…'));
      const results = await syncAll();
      const lines = results.map((r) =>
        r.ok
          ? bullet(`${code(r.provider + '#' + r.accountId)} — ok \\(${r.count}\\)`)
          : bullet(
              `${code(r.provider + '#' + r.accountId)} — ${b('FAIL')} ${escMd(r.error || '')}`,
            ),
      );
      return joinBlocks([b('Результат sync'), lines.join('\n') || i('Нет аккаунтов')]);
    }
    case '/errors': {
      const errs = listAccounts().filter((a) => a.last_error);
      if (!errs.length) return joinBlocks([b('Sync'), escMd('Ошибок нет.')]);
      return joinBlocks([
        b('Ошибки sync'),
        errs
          .map((a) => bullet(`${code(a.provider + '#' + a.id)}\n${escMd(a.last_error || '')}`))
          .join('\n'),
      ]);
    }
    default:
      return `Неизвестная команда: ${code(cmd)}\n${code('/help')}`;
  }
}

export function startTelegramPolling(): void {
  if (!config.telegramBotToken) {
    console.warn('[telegram] polling disabled (no token)');
    return;
  }
  setInterval(() => {
    void pollTelegramCommands(handleTgCommand);
  }, 5_000);
  void pollTelegramCommands(handleTgCommand);
}

export { daysUntil, formatService, publicService };
