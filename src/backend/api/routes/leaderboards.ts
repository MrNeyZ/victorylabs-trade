/**
 * GET /api/leaderboards/latest — the most recent ingested snapshot bucket
 * for one period (`all_time` | `weekly` | `monthly`), not a live upstream
 * call. See `leaderboardsRepository.getLatestLeaderboardSnapshot` for how
 * "most recent bucket" is found.
 */
import { Router } from 'express';
import { getLatestLeaderboardSnapshot } from '../../db/repositories/leaderboardsRepository.js';
import type { LeaderboardPeriod } from '../../types/domain.js';
import { firstQueryString } from '../queryParams.js';

export const leaderboardsRouter = Router();

const VALID_PERIODS: LeaderboardPeriod[] = ['all_time', 'weekly', 'monthly'];

function isLeaderboardPeriod(value: string): value is LeaderboardPeriod {
  return (VALID_PERIODS as string[]).includes(value);
}

leaderboardsRouter.get('/latest', async (req, res) => {
  const period = firstQueryString(req.query['period']) ?? 'all_time';

  if (!isLeaderboardPeriod(period)) {
    res.status(400).json({
      error: 'invalid_period',
      message: `period must be one of: ${VALID_PERIODS.join(', ')}`,
    });
    return;
  }

  const snapshot = await getLatestLeaderboardSnapshot(period);
  res.json(snapshot);
});
