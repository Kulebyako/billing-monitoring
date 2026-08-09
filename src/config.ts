import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
export const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'billing.db');

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

export const config = {
  port: Number(process.env.PORT || 3080),
  panelPassword: process.env.PANEL_PASSWORD || 'changeme',
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(24).toString('hex'),
  credentialsKey: process.env.CREDENTIALS_KEY || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  victoriaMetricsUrl: (process.env.VICTORIAMETRICS_URL || '').replace(/\/$/, ''),
  monitorPollMs: Number(process.env.MONITOR_POLL_MS || 60_000),
  monitorDownTicks: Number(process.env.MONITOR_DOWN_TICKS || 2),
  monitorSummaryCron: process.env.MONITOR_SUMMARY_CRON || '5 * * * *',
  tz: process.env.TZ || 'Europe/Moscow',
  syncCron: process.env.SYNC_CRON || '0 */6 * * *',
  reminderCron: process.env.REMINDER_CRON || '15 * * * *',
  balanceThreshold: Number(process.env.BALANCE_THRESHOLD || 500),
  reminderDays: (process.env.REMINDER_DAYS || '7,3,1,0')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n)),
  headless: process.env.PLAYWRIGHT_HEADLESS !== '0',
};

export function assertRuntimeConfig(): void {
  if (!config.credentialsKey || config.credentialsKey.length < 32) {
    console.warn(
      '[config] CREDENTIALS_KEY missing or short — generating ephemeral key (credentials will not survive restart). Set a 32+ char key in .env.',
    );
  }
}

export { requireEnv };
