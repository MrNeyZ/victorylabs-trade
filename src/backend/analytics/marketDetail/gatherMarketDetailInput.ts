/**
 * The impure half of Market Detail intelligence: fetches everything
 * `GET /api/markets/:marketId` needs from Postgres and hands it over as
 * a plain object. All computation happens in `computeMarketDetail.ts`'s
 * pure functions — this file is I/O only, same split as every other
 * analytics module in this project.
 *
 * Reuses tables/functions already built for other phases —
 * `trades` (Phase 2), `wallet_score_snapshots` (Phase 3.3),
 * `smart_money_signals` (Phase 3.6), and Trending Market Score's own
 * gather function (Phase 4.2/4.3) — no new ingestion, no Jupiter API
 * calls. `positions`/`history_events` are deliberately NOT read here:
 * none of this endpoint's required fields need them (see
 * `docs/market-intelligence-api.md` §3 for the full reasoning).
 */
import { getAllTradesForMarket } from '../../db/repositories/tradesRepository.js';
import type { Trade } from '../../types/domain.js';
import {
  getLatestScoresForWallets,
  type WalletScoreSnapshotResult,
} from '../../db/repositories/walletScoresRepository.js';
import { getRecentSignals, type PersistedSignal } from '../../db/repositories/signalsRepository.js';
import { gatherTrendingMarketInputForMarket } from '../trendingMarkets/gatherTrendingMarketsInput.js';
import {
  computeTrendingMarketScore,
  type TrendingMarket,
} from '../trendingMarkets/computeTrendingMarketScore.js';

/** Same default lookback `/api/trending/markets`/`/api/dashboard` use — this endpoint's `trendingMarket` field should mean the same thing ("trending over the last 24h") a caller would already see on the dashboard, not a different window. */
const TRENDING_LOOKBACK_MINUTES = 1440;
const RECENT_TRADES_LIMIT = 50;
const SIGNALS_LIMIT = 20;

export interface MarketDetailInput {
  marketId: string;
  /** Every trade this project has ever ingested for this market — the basis for `activitySummary`/`sideBreakdown`/`volumeBreakdown`/`topWalletsInMarket`. */
  allTrades: Trade[];
  /** `allTrades`, capped and already most-recent-first (see `getAllTradesForMarket`'s underlying ordering) — for direct display, not further computation. */
  recentTrades: Trade[];
  /** Every distinct trader in `allTrades`. */
  distinctWallets: string[];
  /** Latest Smart Score snapshot per distinct trader — a wallet absent here has never been scored. */
  scoresByWallet: Map<string, WalletScoreSnapshotResult>;
  whaleSignals: PersistedSignal[];
  consensusSignals: PersistedSignal[];
  /** `null` if this market had no activity within `TRENDING_LOOKBACK_MINUTES` — i.e. it wouldn't appear on `/api/trending/markets` at all right now. */
  trendingMarket: TrendingMarket | null;
}

export async function gatherMarketDetailInput(marketId: string): Promise<MarketDetailInput> {
  const allTrades = await getAllTradesForMarket(marketId);
  const distinctWallets = Array.from(new Set(allTrades.map((trade) => trade.ownerPubkey)));

  const [scores, whaleSignals, consensusSignals, trendingInput] = await Promise.all([
    getLatestScoresForWallets(distinctWallets),
    getRecentSignals({ marketId, type: 'whale_trade', limit: SIGNALS_LIMIT }),
    getRecentSignals({ marketId, type: 'market_consensus', limit: SIGNALS_LIMIT }),
    gatherTrendingMarketInputForMarket(marketId, TRENDING_LOOKBACK_MINUTES),
  ]);

  const scoresByWallet = new Map(scores.map((score) => [score.walletPubkey, score]));

  return {
    marketId,
    allTrades,
    // `getAllTradesForMarket` delegates to `getRecentTrades`, already
    // ordered most-recent-first by `upstream_timestamp` — slicing here
    // is equivalent to a separate capped query, without issuing one.
    recentTrades: allTrades.slice(0, RECENT_TRADES_LIMIT),
    distinctWallets,
    scoresByWallet,
    whaleSignals,
    consensusSignals,
    trendingMarket: trendingInput ? computeTrendingMarketScore(trendingInput) : null,
  };
}
