/**
 * The impure half of trending-wallet discovery: fetches everything
 * `computeTrendingScore.ts` needs from Postgres and hands it over as a
 * plain array. All scoring happens in the pure functions — this file is
 * I/O only, same split as `../walletStats/gatherWalletStatsInput.ts`/
 * `../signals/gatherSignalDetectionInput.ts`.
 */
import { getWalletActivityWindows } from '../../db/repositories/tradesRepository.js';
import { getLatestScoresForWallets } from '../../db/repositories/walletScoresRepository.js';
import { getWalletSignalCounts } from '../../db/repositories/signalsRepository.js';
import { MIN_SIGNIFICANT_TRADE_USD } from '../../config/tradeThresholds.js';
import type { TrendingWalletInput } from './computeTrendingScore.js';

/** Candidate pool fetched from `trades` before scoring — generous for the same reason `gatherDashboardData.ts`'s `ACTIVE_WALLET_CANDIDATE_POOL` is: the API/dashboard's requested `limit` is how many *scored* wallets to return, not how many to consider. */
const DEFAULT_CANDIDATE_LIMIT = 500;

export async function gatherTrendingInput(
  lookbackMinutes: number,
  candidateLimit = DEFAULT_CANDIDATE_LIMIT,
): Promise<TrendingWalletInput[]> {
  // Stage 1 Stabilization Fix 1: Trending Wallet Score ignores trades
  // below the shared threshold entirely (including for `firstTradeAt`/
  // `lastTradeAt` — see `getWalletActivityWindows`'s doc comment).
  const activityWindows = await getWalletActivityWindows(lookbackMinutes, candidateLimit, {
    minAmountUsd: MIN_SIGNIFICANT_TRADE_USD,
  });
  const walletPubkeys = activityWindows.map((activity) => activity.walletPubkey);

  const [scores, signalCounts] = await Promise.all([
    getLatestScoresForWallets(walletPubkeys),
    getWalletSignalCounts(walletPubkeys, lookbackMinutes),
  ]);

  const scoresByWallet = new Map(scores.map((score) => [score.walletPubkey, score]));
  const signalCountsByWallet = new Map(signalCounts.map((counts) => [counts.walletPubkey, counts]));

  return activityWindows.map((activity) => ({
    activity,
    latestScore: scoresByWallet.get(activity.walletPubkey),
    signalCounts: signalCountsByWallet.get(activity.walletPubkey),
  }));
}
