import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { SESSIONS_DIR, config } from '../config.js';

export const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export type PersistentContextOptions = {
  userAgent?: string;
  viewport?: { width: number; height: number };
  /** Hide navigator.webdriver via init script */
  stealth?: boolean;
};

export async function withPersistentContext(
  sessionKey: string,
  fn: (page: Page, context: BrowserContext) => Promise<void>,
  options: PersistentContextOptions = {},
): Promise<void> {
  const userDataDir = path.join(SESSIONS_DIR, sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_'));
  fs.mkdirSync(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: config.headless,
    viewport: options.viewport || { width: 1280, height: 900 },
    locale: 'ru-RU',
    userAgent: options.userAgent || CHROME_UA,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  if (options.stealth !== false) {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
  }

  try {
    const page = context.pages()[0] || (await context.newPage());
    await fn(page, context);
  } finally {
    await context.close();
  }
}

export async function withBrowser(
  fn: (page: Page, browser: Browser) => Promise<void>,
): Promise<void> {
  const browser = await chromium.launch({ headless: config.headless });
  try {
    const page = await browser.newPage({ locale: 'ru-RU' });
    await fn(page, browser);
  } finally {
    await browser.close();
  }
}

/** Parse first money-like number from text */
export function parseMoney(text: string): number | null {
  const m = text.replace(/\s/g, ' ').match(/(-?\d[\d\s]*[.,]?\d*)/);
  if (!m) return null;
  const n = Number(m[1].replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Parse YYYY-MM-DD or DD.MM.YYYY */
export function parseDateLoose(text: string): string | null {
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = text.match(/(\d{2})[./](\d{2})[./](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return null;
}

export async function fillFirst(
  page: Page,
  selectors: string[],
  value: string,
): Promise<boolean> {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if ((await el.count()) > 0) {
      await el.fill(value);
      return true;
    }
  }
  return false;
}

export async function clickFirst(page: Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if ((await el.count()) > 0) {
      await el.click();
      return true;
    }
  }
  return false;
}
