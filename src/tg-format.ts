/** Telegram MarkdownV2 helpers (parse_mode=MarkdownV2). */

const MD_SPECIAL = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

export function escMd(s: string | number | null | undefined): string {
  return String(s ?? '').replace(MD_SPECIAL, '\\$1');
}

export function b(s: string | number): string {
  return `*${escMd(s)}*`;
}

export function i(s: string | number): string {
  return `_${escMd(s)}_`;
}

export function code(s: string | number): string {
  return `\`${String(s ?? '').replace(/([\`\\])/g, '\\$1')}\``;
}

export function link(url: string, label: string): string {
  const safeUrl = String(url).replace(/([)\\])/g, '\\$1');
  return `[${escMd(label)}](${safeUrl})`;
}

export function section(title: string, bodyLines: string[]): string {
  const body = bodyLines.filter((l) => l.length > 0).join('\n');
  return body ? `${b(title)}\n${body}` : b(title);
}

export function bullet(text: string): string {
  return `• ${text}`;
}

export function kv(key: string, value: string): string {
  return `${escMd(key)}: ${value}`;
}

export function nowMoscow(): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());
}

export function joinBlocks(blocks: string[]): string {
  return blocks.filter(Boolean).join('\n\n');
}

/** Prepaid balance is meaningful only for these providers. */
export const BALANCE_PROVIDERS = new Set(['hsvds', 'vpsville']);

export function tracksBalance(provider: string): boolean {
  return BALANCE_PROVIDERS.has(provider);
}
