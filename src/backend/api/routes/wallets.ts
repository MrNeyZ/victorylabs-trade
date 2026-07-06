/**
 * GET /api/wallets/:walletPubkey — the wallet intelligence API (Phase
 * 3.1-3.4): everything this project knows about one wallet in a single
 * read-only response. Profile snapshot, positions, recent trades/history,
 * computed `WalletStats`, the persisted Smart Score (latest + full
 * history), a per-market breakdown, and a recent-activity summary.
 *
 * All of it is derived from exactly one round of I/O
 * (`gatherWalletStatsInput`, `../../analytics/walletStats/`) — the same
 * trades/history/positions/profile fetch `computeWalletStats` already
 * needed is reused for `recentTrades`/`recentHistory` (sliced, not
 * re-queried) and fed into `computeMarketBreakdown`/
 * `computeActivitySummary` too, so this route makes no more queries than
 * it did before those two existed. `getWalletScoreHistory` is the one
 * additional query, for the persisted Smart Score snapshots (Phase 3.3).
 *
 * A syntactically valid pubkey we simply have no data for is not an
 * error — it returns 200 with `profile`/`latestSmartScore: null`, empty
 * arrays, and zeroed/null summary fields, not a 404 (this is a query over
 * an open identifier space, not a lookup of a resource that must exist).
 */
import { Router } from 'express';
import {
  gatherWalletStatsInput,
  computeWalletStats,
  computeMarketBreakdown,
  computeActivitySummary,
} from '../../analytics/walletStats/index.js';
import { getWalletScoreHistory } from '../../db/repositories/walletScoresRepository.js';

export const walletsRouter = Router();

const RECENT_TRADES_LIMIT = 50;
const RECENT_HISTORY_LIMIT = 50;

walletsRouter.get('/:walletPubkey', async (req, res) => {
  const { walletPubkey } = req.params;
  if (!walletPubkey) {
    res.status(400).json({ error: 'invalid_wallet_pubkey' });
    return;
  }

  const [statsInput, scoreHistory] = await Promise.all([
    gatherWalletStatsInput(walletPubkey),
    getWalletScoreHistory(walletPubkey),
  ]);

  const stats = computeWalletStats(statsInput);
  const marketBreakdown = computeMarketBreakdown(statsInput);
  const activitySummary = computeActivitySummary(statsInput, stats);

  res.json({
    walletPubkey,
    profile: statsInput.walletProfile,
    positions: statsInput.positions,
    // `statsInput.trades`/`historyEvents` are already ordered most-recent-first
    // (same ordering `getRecentTrades`/`getRecentHistoryForWallet` used
    // before this route switched to `gatherWalletStatsInput` — see module
    // doc comment), so slicing here is equivalent to a separate capped
    // query, without actually issuing one.
    recentTrades: statsInput.trades.slice(0, RECENT_TRADES_LIMIT),
    recentHistory: statsInput.historyEvents.slice(0, RECENT_HISTORY_LIMIT),
    stats,
    latestSmartScore: scoreHistory[0] ?? null,
    smartScoreHistory: scoreHistory,
    marketBreakdown,
    activitySummary,
  });
});
