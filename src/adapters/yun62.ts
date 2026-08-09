import type {
  ProviderAdapter,
  ProviderAccountCredentials,
  SyncedService,
} from './types.js';
import {
  withPersistentContext,
  parseMoney,
  parseDateLoose,
} from './playwright-base.js';
import type { Page } from 'playwright';

function loginButton(page: Page) {
  // Header CTA calls openModal('login') — more reliable than text match (SVG + whitespace)
  return page.locator('.header__container_user_button-group_button[onclick*="openModal(\'login\')"]').first();
}

async function needsLogin(page: Page): Promise<boolean> {
  return loginButton(page).isVisible().catch(() => false);
}

async function ensureLoggedIn(page: Page, login: string, password: string): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  if (!(await needsLogin(page))) return;

  await loginButton(page).click();

  await page.locator('#modal-login.active').waitFor({ state: 'visible', timeout: 15_000 }).catch(async () => {
    // Fallback if class name differs: wait for password field visibility
    await page.locator('#modal-login input.modal-auth-password').waitFor({ state: 'visible', timeout: 10_000 });
  });

  const email = page.locator('#modal-login input.modal-auth-email, #modal-login #email');
  const passwordInput = page.locator('#modal-login input.modal-auth-password, #modal-login #password');
  await email.waitFor({ state: 'visible', timeout: 10_000 });
  await email.fill(login);
  await passwordInput.fill(password);
  await page.locator('#loginForm button[type="submit"]').first().click();

  // AJAX login returns success then reloads the page
  await loginButton(page)
    .waitFor({ state: 'hidden', timeout: 40_000 })
    .catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(500);

  if (await needsLogin(page)) {
    throw new Error('62yun: login failed — credentials rejected or modal did not close');
  }
}

function parseBalance(text: string): number | null {
  const m = text.replace(/\s/g, ' ').match(/(\d[\d\s]*[.,]\d+)\s*₽/);
  if (!m) return null;
  const n = Number(m[1].replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** 62yun.ru custom client area */
export const yun62Adapter: ProviderAdapter = {
  id: 'yun62',
  label: '62yun',

  async sync(credentials: ProviderAccountCredentials): Promise<SyncedService[]> {
    const login = credentials.login;
    const password = credentials.password;
    if (!login || !password) throw new Error('62yun requires login and password');

    const base = ((credentials.baseUrl as string | undefined) || 'https://62yun.ru').replace(/\/$/, '');
    const services: SyncedService[] = [];

    await withPersistentContext(`yun62_${login}`, async (page) => {
      await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await ensureLoggedIn(page, login, password);

      await page.goto(`${base}/servers`, { waitUntil: 'domcontentloaded', timeout: 40_000 });
      // Guests are bounced to `/`
      if (!page.url().includes('/servers') || (await needsLogin(page))) {
        throw new Error('62yun: not authenticated after login (cannot open /servers)');
      }
      await page.waitForSelector('.myservers__server, .myservers', { timeout: 25_000 });
      await page.waitForTimeout(800);

      const headerText = (await page.locator('header, .header, body').first().innerText().catch(() => '')).slice(
        0,
        500,
      );
      const accountBalance = parseBalance(headerText);

      const cards = await page.locator('.myservers__server:not(.order)').evaluateAll((els) =>
        els.map((el, i) => {
          const text = (el as HTMLElement).innerText || '';
          const ipEl = el.querySelector('.myservers__server_ip');
          const nameEl = el.querySelector('.myservers__server_name');
          const dateEl = el.querySelector('.myservers__server_date');
          const ipText = (ipEl?.textContent || '').trim();
          const name = (nameEl?.textContent || '').trim();
          const dateText = (dateEl?.textContent || '').trim();
          const ipMatch = ipText.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
          let externalId: string | null = null;
          for (const btn of el.querySelectorAll('button[onclick]')) {
            const oc = btn.getAttribute('onclick') || '';
            const m = oc.match(/sendAction\((\d+)/) || oc.match(/\/servers\/pay\/index\/(\d+)/);
            if (m?.[1]) {
              externalId = m[1];
              break;
            }
          }
          return {
            i,
            ipText,
            name,
            dateText,
            ip: ipMatch?.[0] || null,
            externalId: externalId || ipMatch?.[0] || `62yun-${i}`,
            cardText: text,
          };
        }),
      );

      if (!cards.length) {
        throw new Error('62yun: logged in but no servers found on /servers');
      }

      for (const card of cards.slice(0, 50)) {
        let cost: number | null = null;
        try {
          await page.goto(`${base}/servers/control/index/${card.externalId}`, {
            waitUntil: 'domcontentloaded',
            timeout: 25_000,
          });
          await page.waitForTimeout(600);
          const detail = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
          const priceMatch = detail.match(/Цена\s+([\d\s.,]+)\s*₽/i);
          if (priceMatch) cost = parseMoney(priceMatch[1]);
          else cost = parseMoney(detail.match(/([\d\s.,]+)\s*₽\s*в\s*месяц/i)?.[0] || '');
        } catch {
          // keep cost null
        }

        services.push({
          externalId: String(card.externalId),
          name: card.name || card.ip || `62yun-${card.externalId}`,
          ip: card.ip,
          cost,
          currency: 'RUB',
          dueAt: parseDateLoose(card.dateText),
          balance: accountBalance,
          status: /выключ|suspend|блок|просроч|останов/i.test(card.cardText)
            ? 'suspended'
            : 'active',
          billingUrl: `${base}/servers/pay/index/${card.externalId}`,
          raw: {
            ipText: card.ipText,
            name: card.name,
            dateText: card.dateText,
            accountBalance,
          },
        });
      }

      if (!services.length) {
        throw new Error('62yun: could not parse services from client area');
      }
    });

    const map = new Map(services.map((s) => [s.externalId, s]));
    return [...map.values()];
  },
};
