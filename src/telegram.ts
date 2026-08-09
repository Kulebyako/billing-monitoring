import { config } from './config.js';

export type SendTelegramOpts = {
  /** Default MarkdownV2. Pass null for plain text. */
  parseMode?: 'HTML' | 'MarkdownV2' | 'Markdown' | null;
};

export async function sendTelegram(
  text: string,
  opts: SendTelegramOpts = {},
): Promise<boolean> {
  if (!config.telegramBotToken || !config.telegramChatId) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skip send');
    return false;
  }
  const parseMode = opts.parseMode === undefined ? 'MarkdownV2' : opts.parseMode;
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  const body: Record<string, unknown> = {
    chat_id: config.telegramChatId,
    text,
    disable_web_page_preview: true,
  };
  if (parseMode) body.parse_mode = parseMode;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error('[telegram] send failed', res.status, await res.text());
    // Fallback plain text if Markdown parse fails
    if (parseMode && res.status === 400) {
      const plain = text
        .replace(/[*_`\\[\]]/g, '')
        .replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, '$1');
      return sendTelegram(plain, { parseMode: null });
    }
    return false;
  }
  return true;
}

export type TgCommandHandler = (cmd: string, args: string) => Promise<string>;

let offset = 0;

export async function pollTelegramCommands(handler: TgCommandHandler): Promise<void> {
  if (!config.telegramBotToken) return;
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/getUpdates?timeout=0&offset=${offset}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return;
    const data = (await res.json()) as {
      ok: boolean;
      result?: Array<{
        update_id: number;
        message?: { chat: { id: number | string }; text?: string };
      }>;
    };
    for (const upd of data.result || []) {
      offset = upd.update_id + 1;
      const text = upd.message?.text?.trim();
      const chatId = String(upd.message?.chat?.id ?? '');
      if (!text || !text.startsWith('/')) continue;
      if (config.telegramChatId && chatId !== String(config.telegramChatId)) continue;
      const [cmdRaw, ...rest] = text.split(/\s+/);
      const cmd = cmdRaw.replace(/@\w+$/, '').toLowerCase();
      const reply = await handler(cmd, rest.join(' '));
      await sendTelegram(reply);
    }
  } catch (e) {
    console.error('[telegram] poll error', (e as Error).message);
  }
}
