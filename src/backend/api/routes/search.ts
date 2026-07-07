/**
 * GET /api/search — global wallet + market search, Phase 5.1. Read-only
 * over already-ingested data (`trades`, `wallet_score_snapshots`) — no
 * Jupiter API calls, no writes, no new ingestion/analytics/scoring.
 *
 * `q` is required: minimum 2 characters, maximum 100 (after trimming),
 * `400` otherwise — including when it's absent or empty. See
 * `../queryParams.ts`'s `parseRequiredStringParam`.
 */
import { Router } from 'express';
import { parseRequiredStringParam } from '../queryParams.js';
import { gatherSearchInput } from '../../analytics/search/gatherSearchInput.js';
import {
  rankWalletSearchResults,
  rankMarketSearchResults,
} from '../../analytics/search/computeSearchResults.js';

export const searchRouter = Router();

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 100;
const MAX_RESULTS = 20;

searchRouter.get('/', async (req, res) => {
  const queryResult = parseRequiredStringParam(
    req.query['q'],
    'q',
    MIN_QUERY_LENGTH,
    MAX_QUERY_LENGTH,
  );
  if (!queryResult.ok) {
    res.status(400).json({ error: 'invalid_query', message: queryResult.message });
    return;
  }

  const input = await gatherSearchInput(queryResult.value, MAX_RESULTS);

  const wallets = rankWalletSearchResults(
    input.walletCandidates,
    input.scoresByWallet,
    MAX_RESULTS,
  );
  const markets = rankMarketSearchResults(input.marketCandidates, MAX_RESULTS);

  res.json({ wallets, markets });
});
