import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import cron from 'node-cron';
import { assertRuntimeConfig, config, ROOT_DIR } from './config.js';
import { initDb } from './db.js';
import { apiRouter } from './routes/api.js';
import { requireAuth, isValidSession, COOKIE } from './auth.js';
import { syncAll } from './sync.js';
import { runReminders, startTelegramPolling } from './reminders.js';
import { startMonitorAlerts, sendMonitorSummary } from './monitor-alerts.js';
import { renderMetrics } from './metrics.js';

const publicDir = path.join(ROOT_DIR, 'src', 'public');

assertRuntimeConfig();
initDb();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.get('/metrics', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(renderMetrics());
});

app.get('/login', (req, res) => {
  if (isValidSession(req.cookies?.[COOKIE])) {
    res.redirect('/');
    return;
  }
  res.sendFile(path.join(publicDir, 'login.html'));
});

app.use('/api', (req, res, next) => {
  if (req.path === '/login') return next();
  return requireAuth(req, res, next);
}, apiRouter);

app.use(requireAuth);
app.use(express.static(publicDir));
app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(config.port, () => {
  console.log(`server-billing listening on :${config.port}`);
});

if (cron.validate(config.syncCron)) {
  cron.schedule(config.syncCron, () => {
    console.log('[cron] sync start');
    void syncAll().then((r) => console.log('[cron] sync done', r));
  });
} else {
  console.warn('[cron] invalid SYNC_CRON', config.syncCron);
}

if (cron.validate(config.reminderCron)) {
  cron.schedule(config.reminderCron, () => {
    console.log('[cron] reminders');
    void runReminders().then((n) => console.log('[cron] reminders sent', n));
  });
} else {
  console.warn('[cron] invalid REMINDER_CRON', config.reminderCron);
}

if (cron.validate(config.monitorSummaryCron)) {
  cron.schedule(config.monitorSummaryCron, () => {
    console.log('[cron] monitor summary');
    void sendMonitorSummary().then((ok) => console.log('[cron] monitor summary', ok));
  });
} else {
  console.warn('[cron] invalid MONITOR_SUMMARY_CRON', config.monitorSummaryCron);
}

startMonitorAlerts();
startTelegramPolling();
