/**
 * GET /api/trades/recent — read-only, filterable recent-trades feed from
 * Postgres (not a live upstream call; reflects whatever ingestion has
 * already written).
 */
import { Router } from 'express';
import {
  getRecentTrades,
  type GetRecentTradesOptions,
} from '../../db/repositories/tradesRepository.js';
import { firstQueryString, parseLimitParam } from '../queryParams.js';

export const tradesRouter = Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

tradesRouter.get('/recent', async (req, res) => {
  const limitResult = parseLimitParam(req.query['limit'], DEFAULT_LIMIT, MAX_LIMIT);
  if (!limitResult.ok) {
    res.status(400).json({ error: 'invalid_limit', message: limitResult.message });
    return;
  }

  const marketId = firstQueryString(req.query['marketId']);
  const ownerPubkey = firstQueryString(req.query['ownerPubkey']);

  const options: GetRecentTradesOptions = { limit: limitResult.value };
  if (marketId !== undefined) options.marketId = marketId;
  if (ownerPubkey !== undefined) options.ownerPubkey = ownerPubkey;

  const trades = await getRecentTrades(options);
  res.json({ data: trades });
});
