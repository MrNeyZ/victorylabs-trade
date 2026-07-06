/**
 * GET /health — liveness + DB connectivity check. No ingestion, no
 * business data; just "is this process up and can it reach Postgres".
 */
import { Router } from 'express';
import { getPool } from '../../db/client.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  let dbOk = false;
  let dbError: string | null = null;

  try {
    await getPool().query('SELECT 1');
    dbOk = true;
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  res.status(dbOk ? 200 : 503).json({
    ok: dbOk,
    uptimeSeconds: process.uptime(),
    db: dbOk ? 'ok' : 'error',
    dbError,
  });
});
