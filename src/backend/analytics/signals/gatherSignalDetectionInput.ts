/**
 * The impure half of signal detection: fetches everything
 * `detectSmartMoneySignals.ts` needs from Postgres and hands it over as a
 * plain object. All detection logic happens in the pure function — this
 * file is I/O only, same split as `../walletStats/gatherWalletStatsInput.ts`.
 */
import { getRecentTradesWithinMinutes } from '../../db/repositories/tradesRepository.js';
import {
  getLatestScoresForWallets,
  type WalletScoreSnapshotResult,
} from '../../db/repositories/walletScoresRepository.js';
import { MIN_SIGNIFICANT_TRADE_USD } from '../../config/tradeThresholds.js';
import type { DetectSmartMoneySignalsInput } from './detectSmartMoneySignals.js';

export async function gatherSignalDetectionInput(
  lookbackMinutes: number,
): Promise<DetectSmartMoneySignalsInput> {
  // Stage 1 Stabilization Fix 1: trades below the shared threshold are
  // excluded before they ever reach `detectSmartMoneySignals.ts`, so
  // every detector (`smart_wallet_trade`, `market_consensus`, etc.) only
  // ever sees qualifying trades. `whale_trade`'s own default ($1,000) is
  // already well above this floor, so it's unaffected in practice.
  const trades = await getRecentTradesWithinMinutes(lookbackMinutes, {
    minAmountUsd: MIN_SIGNIFICANT_TRADE_USD,
  });

  const walletPubkeys = Array.from(new Set(trades.map((trade) => trade.ownerPubkey)));
  const scoreSnapshots = await getLatestScoresForWallets(walletPubkeys);

  const latestScores = new Map<string, WalletScoreSnapshotResult>(
    scoreSnapshots.map((snapshot) => [snapshot.walletPubkey, snapshot]),
  );

  return { trades, latestScores };
}
