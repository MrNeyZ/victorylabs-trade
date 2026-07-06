/**
 * GET /api/markets/:marketId — Market Detail intelligence, Phase 4.3.
 * Everything this project knows about one market: activity summary,
 * YES/NO side and volume breakdowns, top wallets trading it, which of
 * those are Smart-Score-qualified, its recent whale/consensus signals,
 * recent trades, and its current Trending Market Score if it has one.
 * See `docs/market-intelligence-api.md` for the full response shape.
 *
 * Purely a read over existing tables (`trades`, `wallet_score_snapshots`,
 * `smart_money_signals`) — no Jupiter API calls, no writes, no new
 * detection/scoring logic (`gatherMarketDetailInput.ts` composes
 * already-existing repository reads and Trending Market Score's own
 * gather function).
 *
 * A syntactically valid `marketId` this project has no trades for is not
 * an error — it returns 200 with `eventTitle`/`trendingMarket: null`,
 * zeroed `activitySummary`/breakdowns, and empty arrays, not a 404, same
 * "open identifier space" convention `GET /api/wallets/:walletPubkey`
 * already follows.
 */
import { Router } from 'express';
import { gatherMarketDetailInput } from '../../analytics/marketDetail/gatherMarketDetailInput.js';
import {
  computeMarketActivitySummary,
  computeSideBreakdown,
  computeVolumeBreakdown,
  computeTopWalletsInMarket,
  computeSmartWalletsInMarket,
} from '../../analytics/marketDetail/computeMarketDetail.js';
import { SMART_WALLET_MIN_SCORE } from '../../analytics/trendingMarkets/computeTrendingMarketScore.js';

export const marketsRouter = Router();

marketsRouter.get('/:marketId', async (req, res) => {
  const { marketId } = req.params;
  if (!marketId) {
    res.status(400).json({ error: 'invalid_market_id' });
    return;
  }

  const input = await gatherMarketDetailInput(marketId);

  const activitySummary = computeMarketActivitySummary(input.allTrades);
  const sideBreakdown = computeSideBreakdown(input.allTrades);
  const volumeBreakdown = computeVolumeBreakdown(input.allTrades);
  const topWalletsInMarket = computeTopWalletsInMarket(input.allTrades);
  const smartWalletsInMarket = computeSmartWalletsInMarket(
    input.distinctWallets,
    input.scoresByWallet,
    SMART_WALLET_MIN_SCORE,
  );

  const eventTitle = input.allTrades.find((trade) => trade.eventTitle !== null)?.eventTitle ?? null;

  res.json({
    marketId,
    eventTitle,
    activitySummary,
    trendingMarket: input.trendingMarket,
    recentTrades: input.recentTrades,
    topWalletsInMarket,
    smartWalletsInMarket,
    whaleSignals: input.whaleSignals,
    consensusSignals: input.consensusSignals,
    sideBreakdown,
    volumeBreakdown,
  });
});
