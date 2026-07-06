/**
 * Market Detail intelligence — Phase 4.3. Pure computation over a
 * market's own trades plus each trader's latest Smart Score (see
 * `./gatherMarketDetailInput.ts` for how both are fetched). No I/O of
 * any kind, same pure/impure split as every other analytics module in
 * this project.
 *
 * The market-scoped counterpart to `../walletStats/computeActivitySummary.ts`
 * (activity summary) and a market-scoped view of participation this
 * project's other modules only ever computed in aggregate (top wallets,
 * smart wallets actually trading here) — not a generalization of any
 * single existing module, several small pure functions purpose-built for
 * `GET /api/markets/:marketId`.
 *
 * Money fields stay decimal strings (`sumDecimalStrings`,
 * `../../utils/decimal.ts`), same discipline as every other analytics
 * module — except sorting `topWalletsInMarket` by volume, which (like
 * `computeWalletScore.ts`'s own documented exception) converts to
 * `Number` for comparison only, never for the stored/returned amount.
 */
import type { Trade } from '../../types/domain.js';
import type { WalletScoreSnapshotResult } from '../../db/repositories/walletScoresRepository.js';
import type { WalletScoreTier } from '../scoring/computeWalletScore.js';
import { sumDecimalStrings } from '../../utils/decimal.js';

export interface MarketActivitySummary {
  totalTrades: number;
  totalVolumeUsd: string;
  /** Distinct `ownerPubkey`s across every trade this project has ever ingested for this market — not just the recent window. */
  uniqueWallets: number;
  tradesLast24h: number;
  tradesLast7d: number;
  volumeLast24h: string;
  volumeLast7d: string;
  /** This market's earliest trade this project ever ingested. `null` if it has none. */
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

export function computeMarketActivitySummary(
  trades: Trade[],
  now: Date = new Date(),
): MarketActivitySummary {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      totalVolumeUsd: '0.000000',
      uniqueWallets: 0,
      tradesLast24h: 0,
      tradesLast7d: 0,
      volumeLast24h: '0.000000',
      volumeLast7d: '0.000000',
      firstSeenAt: null,
      lastSeenAt: null,
    };
  }

  const cutoff24hMs = now.getTime() - ONE_DAY_MS;
  const cutoff7dMs = now.getTime() - SEVEN_DAYS_MS;
  const last24h = trades.filter((trade) => trade.upstreamTimestamp.getTime() >= cutoff24hMs);
  const last7d = trades.filter((trade) => trade.upstreamTimestamp.getTime() >= cutoff7dMs);
  const timestamps = trades.map((trade) => trade.upstreamTimestamp.getTime());

  return {
    totalTrades: trades.length,
    totalVolumeUsd: sumDecimalStrings(trades.map((trade) => trade.amountUsd)),
    uniqueWallets: new Set(trades.map((trade) => trade.ownerPubkey)).size,
    tradesLast24h: last24h.length,
    tradesLast7d: last7d.length,
    volumeLast24h: sumDecimalStrings(last24h.map((trade) => trade.amountUsd)),
    volumeLast7d: sumDecimalStrings(last7d.map((trade) => trade.amountUsd)),
    firstSeenAt: new Date(Math.min(...timestamps)),
    lastSeenAt: new Date(Math.max(...timestamps)),
  };
}

export interface SideCounts {
  yes: number;
  no: number;
}

export function computeSideBreakdown(trades: Trade[]): SideCounts {
  return {
    yes: trades.filter((trade) => trade.side === 'yes').length,
    no: trades.filter((trade) => trade.side === 'no').length,
  };
}

export interface SideVolumes {
  yes: string;
  no: string;
}

export function computeVolumeBreakdown(trades: Trade[]): SideVolumes {
  return {
    yes: sumDecimalStrings(trades.filter((trade) => trade.side === 'yes').map((t) => t.amountUsd)),
    no: sumDecimalStrings(trades.filter((trade) => trade.side === 'no').map((t) => t.amountUsd)),
  };
}

export interface MarketWalletActivity {
  walletPubkey: string;
  tradeCount: number;
  volumeUsd: string;
}

const DEFAULT_TOP_WALLETS_LIMIT = 10;

/** Every distinct wallet that has traded this market, ranked by their own volume in it — descending. Not the same list/order as `smartWalletsInMarket` (that's filtered by Smart Score, this one isn't filtered at all). */
export function computeTopWalletsInMarket(
  trades: Trade[],
  limit = DEFAULT_TOP_WALLETS_LIMIT,
): MarketWalletActivity[] {
  const tradesByWallet = new Map<string, Trade[]>();
  for (const trade of trades) {
    const existing = tradesByWallet.get(trade.ownerPubkey);
    if (existing) {
      existing.push(trade);
    } else {
      tradesByWallet.set(trade.ownerPubkey, [trade]);
    }
  }

  const entries = Array.from(tradesByWallet.entries()).map(
    ([walletPubkey, walletTrades]): MarketWalletActivity => ({
      walletPubkey,
      tradeCount: walletTrades.length,
      volumeUsd: sumDecimalStrings(walletTrades.map((trade) => trade.amountUsd)),
    }),
  );

  entries.sort((a, b) => Number(b.volumeUsd) - Number(a.volumeUsd));
  return entries.slice(0, limit);
}

export interface MarketSmartWallet {
  walletPubkey: string;
  score: number;
  tier: WalletScoreTier;
}

/** Every distinct trader in `walletPubkeys` whose latest Smart Score snapshot (`scoresByWallet`) is `>= minScore`, sorted by score descending. A wallet absent from `scoresByWallet` (never scored) is simply not included — not treated as score `0`. */
export function computeSmartWalletsInMarket(
  walletPubkeys: string[],
  scoresByWallet: Map<string, WalletScoreSnapshotResult>,
  minScore: number,
): MarketSmartWallet[] {
  const entries: MarketSmartWallet[] = [];
  for (const walletPubkey of walletPubkeys) {
    const score = scoresByWallet.get(walletPubkey);
    if (score !== undefined && score.score >= minScore) {
      entries.push({ walletPubkey, score: score.score, tier: score.tier });
    }
  }
  entries.sort((a, b) => b.score - a.score);
  return entries;
}
