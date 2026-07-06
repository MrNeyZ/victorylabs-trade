/**
 * GET /api/dashboard — Phase 3.7. A single read-only response combining
 * everything the analytics phases so far (3.1-3.6) have already
 * computed/persisted: Smart Score, Smart Money Signals, and raw trade
 * activity. See `docs/dashboard-api.md` for the full response shape and
 * intended frontend usage.
 *
 * Purely a read over existing tables — no Jupiter API calls, no writes,
 * no new detection/scoring logic (`gatherDashboardData.ts` composes
 * already-existing repository reads only).
 */
import { Router } from 'express';
import { gatherDashboardData } from '../../analytics/dashboard/gatherDashboardData.js';
import { parseLimitParam, parsePositiveIntParam } from '../queryParams.js';

export const dashboardRouter = Router();

const DEFAULT_LOOKBACK_MINUTES = 1440;
const MAX_LOOKBACK_MINUTES = 10_080;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

dashboardRouter.get('/', async (req, res) => {
  const lookbackResult = parsePositiveIntParam(
    req.query['lookbackMinutes'],
    'lookbackMinutes',
    DEFAULT_LOOKBACK_MINUTES,
    MAX_LOOKBACK_MINUTES,
  );
  if (!lookbackResult.ok) {
    res.status(400).json({ error: 'invalid_lookback_minutes', message: lookbackResult.message });
    return;
  }

  const limitResult = parseLimitParam(req.query['limit'], DEFAULT_LIMIT, MAX_LIMIT);
  if (!limitResult.ok) {
    res.status(400).json({ error: 'invalid_limit', message: limitResult.message });
    return;
  }

  const dashboard = await gatherDashboardData(lookbackResult.value, limitResult.value);
  res.json(dashboard);
});
