/**
 * GET /api/trending/wallets, GET /api/trending/markets — Phase 4.1/4.2.
 * "Wallets/markets becoming interesting RIGHT NOW", as distinct from
 * `/api/scores/latest`'s "wallets with the best all-time track record" —
 * see `docs/trending-wallets.md`/`docs/trending-markets.md` for the full
 * philosophy/formula writeups.
 *
 * Both computed fresh on every request (like
 * `/api/signals/recent?source=live`, not like the persisted
 * `source=persisted` default) — there is no `trending_wallets`/
 * `trending_markets` table; this is scoring purely over already-persisted
 * `trades`/`wallet_score_snapshots`/`smart_money_signals` data. No
 * Jupiter API calls, no writes, no ingestion triggered.
 */
import { Router, type Request, type Response } from 'express';
import { gatherTrendingInput } from '../../analytics/trending/gatherTrendingInput.js';
import { rankTrendingWallets } from '../../analytics/trending/computeTrendingScore.js';
import { gatherTrendingMarketsInput } from '../../analytics/trendingMarkets/gatherTrendingMarketsInput.js';
import { rankTrendingMarkets } from '../../analytics/trendingMarkets/computeTrendingMarketScore.js';
import { parseLimitParam, parsePositiveIntParam } from '../queryParams.js';

export const trendingRouter = Router();

const DEFAULT_LOOKBACK_MINUTES = 1440;
const MAX_LOOKBACK_MINUTES = 10_080;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function parseTrendingParams(
  req: Request,
  res: Response,
): { lookbackMinutes: number; limit: number } | undefined {
  const lookbackResult = parsePositiveIntParam(
    req.query['lookbackMinutes'],
    'lookbackMinutes',
    DEFAULT_LOOKBACK_MINUTES,
    MAX_LOOKBACK_MINUTES,
  );
  if (!lookbackResult.ok) {
    res.status(400).json({ error: 'invalid_lookback_minutes', message: lookbackResult.message });
    return undefined;
  }

  const limitResult = parseLimitParam(req.query['limit'], DEFAULT_LIMIT, MAX_LIMIT);
  if (!limitResult.ok) {
    res.status(400).json({ error: 'invalid_limit', message: limitResult.message });
    return undefined;
  }

  return { lookbackMinutes: lookbackResult.value, limit: limitResult.value };
}

trendingRouter.get('/wallets', async (req, res) => {
  const params = parseTrendingParams(req, res);
  if (!params) return;

  const inputs = await gatherTrendingInput(params.lookbackMinutes);
  const wallets = rankTrendingWallets(inputs).slice(0, params.limit);

  res.json({
    lookbackMinutes: params.lookbackMinutes,
    limit: params.limit,
    wallets,
  });
});

trendingRouter.get('/markets', async (req, res) => {
  const params = parseTrendingParams(req, res);
  if (!params) return;

  const inputs = await gatherTrendingMarketsInput(params.lookbackMinutes);
  const markets = rankTrendingMarkets(inputs).slice(0, params.limit);

  res.json({
    lookbackMinutes: params.lookbackMinutes,
    limit: params.limit,
    markets,
  });
});
