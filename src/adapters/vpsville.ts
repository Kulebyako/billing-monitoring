import type {
  ProviderAdapter,
  ProviderAccountCredentials,
  SyncedService,
} from './types.js';
import { withPersistentContext, parseMoney } from './playwright-base.js';

/**
 * VPSVille: https://vpsville.ru/login.php → /private/index.php
 * Login form id: #authorisation-form (other email fields on page are hidden popups).
 * Prepaid balance model: "ВАШ СЧЕТ" + "ХВАТИТ НА - N ДНЕЙ".
 */
export const vpsvilleAdapter: ProviderAdapter = {
  id: 'vpsville',
  label: 'VPSVille',

  async sync(credentials: ProviderAccountCredentials): Promise<SyncedService[]> {
    const login = credentials.login;
    const password = credentials.password;
    if (!login || !password) throw new Error('VPSVille requires login and password');

    const base = ((credentials.baseUrl as string | undefined) || 'https://vpsville.ru').replace(
      /\/$/,
      '',
    );

    let services: SyncedService[] = [];

    await withPersistentContext(
      `vpsville_${login}`,
      async (page) => {
      const isCaptchaWall = async () => {
        const t = await page.locator('body').innerText();
        // Real interstitial, not just the word in scripts
        return /заполните\s+капч/i.test(t) && !(await page.locator('#authorisation-form').count());
      };

      await page.goto(`${base}/login.php`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      await page.waitForTimeout(500);

      if (await isCaptchaWall()) {
        await page.waitForTimeout(2000);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(500);
      }
      if (await isCaptchaWall()) {
        throw new Error(
          'VPSVille: антибот-капча на входе. Повтори Sync через минуту; если снова — открой login.php в обычном Chrome на этой машине.',
        );
      }

      // Already logged in?
      if (!page.url().includes('/private')) {
        const form = page.locator('#authorisation-form');
        if ((await form.count()) === 0) {
          throw new Error('VPSVille: форма #authorisation-form не найдена на login.php');
        }
        await form.locator('input[type="email"], input[name="email"]').fill(login);
        await form.locator('input[type="password"]').fill(password);
        await Promise.all([
          page.waitForURL(/\/private\//, { timeout: 45_000 }),
          form.locator('button, input[type="submit"]').first().click(),
        ]);
      }

      await page.goto(`${base}/private/index.php`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      await page.waitForTimeout(1500);

      if (page.url().includes('login.php')) {
        throw new Error('VPSVille: логин не удался (остались на login.php). Проверь email/password.');
      }

      if (await isCaptchaWall()) {
        throw new Error('VPSVille: капча на /private/ после логина.');
      }

      const text = await page.locator('body').innerText();

      const html = await page.content();
      const billingUrl = `${base}/private/index.php`;

      const balance =
        parseMoney(text.match(/ваш\s*счет\s*[:\s]*([\d\s.,]+)\s*руб/i)?.[1] || '') ??
        parseMoney(text.match(/([\d\s.,]+)\s*рубл/i)?.[1] || '');

      const daysLeftMatch = text.match(/хватит\s*на\s*[-–—]?\s*(\d+)\s*дн/i);
      const daysLeft = daysLeftMatch ? Number(daysLeftMatch[1]) : null;
      let dueAt: string | null = null;
      if (daysLeft != null && Number.isFinite(daysLeft)) {
        const d = new Date();
        d.setDate(d.getDate() + daysLeft);
        dueAt = d.toISOString().slice(0, 10);
      }

      // Collect server ids from links like servers/...?name=vps257802 or #isvps257802
      const ids = new Set<string>();
      for (const m of html.matchAll(/(?:name=|#is|is)vps(\d+)/gi)) {
        ids.add(m[1]);
      }
      for (const m of text.matchAll(/\bvps(\d+)\b/gi)) {
        ids.add(m[1]);
      }

      // Sidebar / detail blocks: #RU-004 + IP + tariff + monthly fee
      const nameMatches = [...text.matchAll(/#(RU-\d+|[A-Z]{1,5}-?\d+)/g)].map((m) => m[0]);
      const ips = [...text.matchAll(/\bIP:\s*((?:\d{1,3}\.){3}\d{1,3})\b/gi)].map((m) => m[1]);
      const ipLoose = [...text.matchAll(/\b((?:\d{1,3}\.){3}\d{1,3})\b/g)]
        .map((m) => m[1])
        .filter((ip) => !ip.startsWith('127.') && !ip.startsWith('0.'));

      const fee = parseMoney(
        text.match(/ежемесячная\s*плата\s*[:：]?\s*([\d\s.,]+)/i)?.[1] ||
          text.match(/([\d\s.,]+)\s*руб\.?\s*(?:сменить\s*тариф|\/\s*мес)/i)?.[1] ||
          '',
      );
      const tariff =
        text.match(/тариф(?:ный\s*план)?\s*[:\s]*([A-Za-z0-9._+-]+)/i)?.[1] || null;

      const idList = [...ids];
      if (!idList.length && nameMatches.length) {
        // Fallback synthetic id from name
        idList.push(nameMatches[0].replace('#', ''));
      }

      if (!idList.length) {
        throw new Error(
          'VPSVille: вошли в /private/, но серверы не найдены (нет vpsNNNN / #RU-…).',
        );
      }

      services = idList.map((id, idx) => {
        const name = nameMatches[idx] || nameMatches[0] || `VPS ${id}`;
        const ip = ips[idx] || ipLoose[idx] || ips[0] || ipLoose[0] || null;
        return {
          externalId: `vps${id}`.replace(/^vpsvps/, 'vps'),
          name: tariff ? `${name} (${tariff})` : name,
          ip,
          cost: fee,
          currency: 'RUB',
          dueAt,
          balance,
          status: 'active' as const,
          billingUrl: `${billingUrl}#isvps${id.replace(/^vps/i, '')}`,
          raw: {
            id,
            tariff,
            daysLeft,
            balance,
          },
        };
      });

      // Normalize external ids to vps257802 form
      services = services.map((s) => ({
        ...s,
        externalId: s.externalId.startsWith('vps')
          ? s.externalId
          : `vps${s.externalId}`,
      }));
    });

    const map = new Map(services.map((s) => [s.externalId, s]));
    return [...map.values()];
  },
};
