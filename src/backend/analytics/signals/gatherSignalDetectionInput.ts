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
import type { DetectSmartMoneySignalsInput } from './detectSmartMoneySignals.js';

export async function gatherSignalDetectionInput(
  lookbackMinutes: number,
): Promise<DetectSmartMoneySignalsInput> {
  const trades = await getRecentTradesWithinMinutes(lookbackMinutes);

  const walletPubkeys = Array.from(new Set(trades.map((trade) => trade.ownerPubkey)));
  const scoreSnapshots = await getLatestScoresForWallets(walletPubkeys);

  const latestScores = new Map<string, WalletScoreSnapshotResult>(
    scoreSnapshots.map((snapshot) => [snapshot.walletPubkey, snapshot]),
  );

  return { trades, latestScores };
}
