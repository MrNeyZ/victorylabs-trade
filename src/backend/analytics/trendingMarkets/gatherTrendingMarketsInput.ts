/**
 * The impure half of trending-market discovery: fetches everything
 * `computeTrendingMarketScore.ts` needs from Postgres and hands it over
 * as a plain array. All scoring happens in the pure functions — this
 * file is I/O only, same split as `../trending/gatherTrendingInput.ts`.
 */
import {
  getMarketActivityWindows,
  getMarketTraderWallets,
} from '../../db/repositories/tradesRepository.js';
import { getLatestScoresForWallets } from '../../db/repositories/walletScoresRepository.js';
import { getMarketSignalCounts } from '../../db/repositories/signalsRepository.js';
import { SMART_WALLET_MIN_SCORE, type TrendingMarketInput } from './computeTrendingMarketScore.js';

/** Candidate pool fetched from `trades` before scoring — generous for the same reason `gatherTrendingInput.ts`'s equivalent constant is: the API's requested `limit` is how many *scored* markets to return, not how many to consider. */
const DEFAULT_CANDIDATE_LIMIT = 500;

export async function gatherTrendingMarketsInput(
  lookbackMinutes: number,
  candidateLimit = DEFAULT_CANDIDATE_LIMIT,
): Promise<TrendingMarketInput[]> {
  const activityWindows = await getMarketActivityWindows(lookbackMinutes, candidateLimit);
  const marketIds = activityWindows.map((activity) => activity.marketId);

  const [traderWalletsByMarket, signalCounts] = await Promise.all([
    getMarketTraderWallets(marketIds, lookbackMinutes),
    getMarketSignalCounts(marketIds, lookbackMinutes),
  ]);

  // Every trader across every candidate market, deduplicated, scored in
  // one batch — same reasoning as `gatherTrendingInput.ts`'s single
  // `getLatestScoresForWallets` call: one query for the whole candidate
  // set, not one query per market.
  const allTraderWallets = Array.from(
    new Set(traderWalletsByMarket.flatMap((entry) => entry.walletPubkeys)),
  );
  const scores = await getLatestScoresForWallets(allTraderWallets);
  const scoresByWallet = new Map(scores.map((score) => [score.walletPubkey, score]));

  const traderWalletsByMarketId = new Map(
    traderWalletsByMarket.map((entry) => [entry.marketId, entry.walletPubkeys]),
  );
  const signalCountsByMarket = new Map(signalCounts.map((counts) => [counts.marketId, counts]));

  return activityWindows.map((activity) => {
    const traderWallets = traderWalletsByMarketId.get(activity.marketId) ?? [];
    const smartWalletCount = traderWallets.filter((walletPubkey) => {
      const score = scoresByWallet.get(walletPubkey);
      return score !== undefined && score.score >= SMART_WALLET_MIN_SCORE;
    }).length;

    return {
      activity,
      smartWalletCount,
      signalCounts: signalCountsByMarket.get(activity.marketId),
    };
  });
}
