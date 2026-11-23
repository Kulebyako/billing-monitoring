import { Router } from 'express';
import {
  getMonitorHosts,
  getMonitorOverview,
  unavailableHosts,
  unavailableOverview,
} from '../monitor-data.js';

/**
 * Read-only monitoring endpoints. Mounted in `index.ts` under `/api/monitor`
 * behind the session guard, before the generic `/api` router.
 */
export const monitorRouter = Router();

monitorRouter.get('/overview', async (_req, res) => {
  try {
    res.json(await getMonitorOverview());
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error('[monitor] overview route failed', reason);
    res.status(200).json(unavailableOverview(`Ошибка мониторинга: ${reason}`));
  }
});

monitorRouter.get('/hosts', async (_req, res) => {
  try {
    res.json(await getMonitorHosts());
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error('[monitor] hosts route failed', reason);
    res.status(200).json(unavailableHosts(`Ошибка мониторинга: ${reason}`));
  }
});
