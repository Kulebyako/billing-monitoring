import { Router } from 'express';
import { listAdapters, getAdapter } from '../adapters/registry.js';
import { PROVIDER_IDS } from '../adapters/types.js';
import {
  listAccounts,
  listServices,
  updateServiceMeta,
  getAccount,
} from '../db.js';
import {
  createAccount,
  updateAccount,
  deleteAccount,
  syncAccount,
  syncAll,
  publicAccount,
  publicService,
} from '../sync.js';
import { config } from '../config.js';
import { daysUntil } from '../reminders.js';
import { COOKIE, tryLogin, destroySession } from '../auth.js';
import {
  checkLoginRateLimit,
  recordLoginFailure,
  recordLoginSuccess,
} from '../login-rate-limit.js';

export const apiRouter = Router();

apiRouter.post('/login', (req, res) => {
  if (!checkLoginRateLimit(req, res)) return;
  const password = String(req.body?.password || '');
  const token = tryLogin(password);
  if (!token) {
    recordLoginFailure(req);
    res.status(401).json({ error: 'Invalid password' });
    return;
  }
  recordLoginSuccess(req);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

apiRouter.post('/logout', (req, res) => {
  const token = req.cookies?.[COOKIE];
  if (token) destroySession(token);
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

apiRouter.get('/me', (_req, res) => {
  res.json({ ok: true });
});

apiRouter.get('/meta', (_req, res) => {
  res.json({
    providers: listAdapters(),
    providerIds: PROVIDER_IDS,
    reminderDays: config.reminderDays,
    balanceThreshold: config.balanceThreshold,
  });
});

apiRouter.get('/dashboard', (_req, res) => {
  const services = listServices().map(publicService);
  const accounts = listAccounts().map(publicAccount);
  const urgent = services.filter((s) => {
    const d = daysUntil(s.dueAt);
    return d != null && d <= 7 && s.status !== 'missing';
  });
  const lowBalance = services.filter(
    (s) => s.balance != null && s.balance <= config.balanceThreshold && s.status !== 'missing',
  );
  const syncErrors = accounts.filter((a) => a.lastError);
  res.json({ urgent, lowBalance, syncErrors, services, accounts });
});

apiRouter.get('/services', (req, res) => {
  const provider = req.query.provider ? String(req.query.provider) : undefined;
  const tag = req.query.tag ? String(req.query.tag) : undefined;
  const status = req.query.status ? String(req.query.status) : undefined;
  res.json(listServices({ provider, tag, status }).map(publicService));
});

apiRouter.patch('/services/:id', (req, res) => {
  const id = Number(req.params.id);
  const updated = updateServiceMeta(id, {
    tag: req.body?.tag,
    notes: req.body?.notes,
  });
  if (!updated) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json(publicService(updated));
});

apiRouter.get('/accounts', (_req, res) => {
  res.json(listAccounts().map(publicAccount));
});

apiRouter.post('/accounts', (req, res) => {
  const provider = String(req.body?.provider || '');
  if (!getAdapter(provider)) {
    res.status(400).json({ error: `Unknown provider: ${provider}` });
    return;
  }
  const credentials = req.body?.credentials || {};
  if (req.body?.login) credentials.login = req.body.login;
  if (req.body?.password) credentials.password = req.body.password;
  if (req.body?.token) credentials.token = req.body.token;
  if (req.body?.baseUrl) credentials.baseUrl = req.body.baseUrl;

  const id = createAccount({
    provider,
    label: req.body?.label,
    baseUrl: req.body?.baseUrl,
    credentials,
  });
  res.status(201).json(publicAccount(getAccount(id)!));
});

apiRouter.patch('/accounts/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!getAccount(id)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  try {
    const credentials = req.body?.credentials;
    updateAccount(id, {
      label: req.body?.label,
      baseUrl: req.body?.baseUrl,
      enabled: req.body?.enabled,
      credentials,
    });
    res.json(publicAccount(getAccount(id)!));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

apiRouter.delete('/accounts/:id', (req, res) => {
  const id = Number(req.params.id);
  deleteAccount(id);
  res.json({ ok: true });
});

apiRouter.post('/accounts/:id/sync', async (req, res) => {
  const id = Number(req.params.id);
  const result = await syncAccount(id);
  res.status(result.ok ? 200 : 500).json(result);
});

apiRouter.post('/sync', async (_req, res) => {
  const results = await syncAll();
  res.json({ results });
});
