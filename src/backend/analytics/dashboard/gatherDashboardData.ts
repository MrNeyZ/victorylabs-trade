/**
 * The Smart Money Dashboard — Phase 3.7. Purely a read-side aggregation
 * over tables earlier phases already populate: `smart_money_signals`
 * (Phase 3.6), `wallet_score_snapshots` (Phase 3.3), and `trades` (Phase
 * 2). No new analytics/detection logic lives here — every field is
 * either a direct repository read or a light composition of two existing
 * reads (see `activeSmartWallets` below). No Jupiter API calls, no
 * writes.
 *
 * Unlike `gatherWalletStatsInput.ts`/`gatherSignalDetectionInput.ts`,
 * this file's output is NOT fed into a further pure "compute" step — the
 * six sections below are already the dashboard's final shape, just
 * assembled from several sources into one object for
 * `GET /api/dashboard` to serialize directly.
 */
import { getRecentSignals, type PersistedSignal } from '../../db/repositories/signalsRepository.js';
import {
  getLatestWalletScores,
  getLatestScoresForWallets,
  type WalletScoreSnapshotResult,
} from '../../db/repositories/walletScoresRepository.js';
import {
  getRecentActiveWallets,
  getTopActiveMarkets,
  type TopActiveMarket,
} from '../../db/repositories/tradesRepository.js';

export interface DashboardData {
  generatedAt: Date;
  lookbackMinutes: number;
  /** Latest persisted signals of any type, most-recent `occurredAt` first. */
  signals: PersistedSignal[];
  /** Top wallets from the most recent `analytics:scores` snapshot bucket, ordered by score descending — same data `/api/scores/latest` serves. */
  topWallets: WalletScoreSnapshotResult[];
  /** Persisted `whale_trade` signals only. */
  whaleTrades: PersistedSignal[];
  /** Persisted `market_consensus` signals only. */
  consensus: PersistedSignal[];
  topMarkets: TopActiveMarket[];
  /** Wallets that both traded within `lookbackMinutes` AND meet `MIN_SMART_SCORE_FOR_ACTIVE_WALLETS`, ordered by score descending. */
  activeSmartWallets: WalletScoreSnapshotResult[];
}

/** Same threshold `detectSmartMoneySignals.ts` defaults `minSmartScore` to for `smart_wallet_trade` — "smart" means the same thing here as it does everywhere else in this project. */
const MIN_SMART_SCORE_FOR_ACTIVE_WALLETS = 35;

/** Candidate pool size for "recently active wallets" before filtering down to smart ones — generous for the same reason `gatherCandidateWallets.ts` uses 500 per source: most recently-active wallets won't meet the score bar, so the pool needs headroom above `limit`. */
const ACTIVE_WALLET_CANDIDATE_POOL = 500;

export async function gatherDashboardData(
  lookbackMinutes: number,
  limit: number,
): Promise<DashboardData> {
  const [signals, whaleTrades, consensus, latestScores, topMarkets, recentlyActiveWalletPubkeys] =
    await Promise.all([
      getRecentSignals({ lookbackMinutes, limit }),
      getRecentSignals({ lookbackMinutes, limit, type: 'whale_trade' }),
      getRecentSignals({ lookbackMinutes, limit, type: 'market_consensus' }),
      getLatestWalletScores({ limit }),
      getTopActiveMarkets(lookbackMinutes, limit),
      getRecentActiveWallets({
        sinceMinutes: lookbackMinutes,
        limit: ACTIVE_WALLET_CANDIDATE_POOL,
      }),
    ]);

  // Depends on `recentlyActiveWalletPubkeys` above, so it can't join the
  // same Promise.all — everything else here is independent of it.
  const activeWalletScores = await getLatestScoresForWallets(recentlyActiveWalletPubkeys);
  const activeSmartWallets = activeWalletScores
    .filter((score) => score.score >= MIN_SMART_SCORE_FOR_ACTIVE_WALLETS)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    generatedAt: new Date(),
    lookbackMinutes,
    signals,
    topWallets: latestScores.rows,
    whaleTrades,
    consensus,
    topMarkets,
    activeSmartWallets,
  };
}
