/**
 * GET /api/trending/wallets — Phase 4.1. "Wallets becoming interesting
 * RIGHT NOW", as distinct from `/api/scores/latest`'s "wallets with the
 * best all-time track record" — see `docs/trending-wallets.md` for the
 * full philosophy/formula writeup.
 *
 * Computed fresh on every request (like `/api/signals/recent?source=live`,
 * not like the persisted `source=persisted` default) — there is no
 * `trending_wallets` table; this is scoring purely over already-persisted
 * `trades`/`wallet_score_snapshots`/`smart_money_signals` data. No
 * Jupiter API calls, no writes, no ingestion triggered.
 */
import { Router } from 'express';
import { gatherTrendingInput } from '../../analytics/trending/gatherTrendingInput.js';
import { rankTrendingWallets } from '../../analytics/trending/computeTrendingScore.js';
import { parseLimitParam, parsePositiveIntParam } from '../queryParams.js';

export const trendingRouter = Router();

const DEFAULT_LOOKBACK_MINUTES = 1440;
const MAX_LOOKBACK_MINUTES = 10_080;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

trendingRouter.get('/wallets', async (req, res) => {
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

  const inputs = await gatherTrendingInput(lookbackResult.value);
  const wallets = rankTrendingWallets(inputs).slice(0, limitResult.value);

  res.json({
    lookbackMinutes: lookbackResult.value,
    limit: limitResult.value,
    wallets,
  });
});
