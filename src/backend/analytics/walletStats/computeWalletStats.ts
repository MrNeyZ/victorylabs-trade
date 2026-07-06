/**
 * Pure wallet-statistics computation. No I/O of any kind — takes
 * already-fetched rows as plain arguments and returns a plain object. The
 * caller (`gatherWalletStatsInput.ts`) is responsible for actually
 * reading `trades`/`history_events`/`positions`/`wallet_profiles` from
 * Postgres; this file never touches the database, HTTP, or Express.
 *
 * Money fields stay decimal strings throughout (via
 * `sumDecimalStrings`/`averageDecimalStrings`, `../../utils/decimal.ts`)
 * — never converted to `Number`, same discipline as the rest of this
 * project.
 *
 * Source-of-truth rules (per Phase 3.1's brief: "use our own database as
 * the primary source, only fall back to wallet_profiles when a value
 * cannot be reconstructed"):
 *   - `totalVolumeUsd`: reconstructed from `trades.amountUsd` when any
 *     trades exist; falls back to `wallet_profiles.totalVolumeUsd`
 *     otherwise.
 *   - `realizedPnlUsd`: reconstructed from `history_events.realizedPnlUsd`
 *     (the per-fill ledger — NOT also summed from `positions.realizedPnlUsd`,
 *     which would double-count the same underlying settlement) when any
 *     history events with a non-null realized PnL exist; falls back to
 *     `wallet_profiles.realizedPnlUsd` otherwise.
 *   - `unrealizedPnlUsd`: has no `wallet_profiles` equivalent at all — it's
 *     always reconstructed from `positions.pnlUsd` (open positions only),
 *     and is honestly `"0.000000"` (not a fallback) when there are none.
 */
import type { HistoryEvent, Position, Trade, WalletProfile } from '../../types/domain.js';
import { averageDecimalStrings, sumDecimalStrings } from '../../utils/decimal.js';

export type WalletStatsFallbackField = 'totalVolumeUsd' | 'realizedPnlUsd';

export interface WalletStats {
  walletPubkey: string;

  totalTrades: number;
  /** Distinct market IDs across trades + positions + history events. */
  totalMarkets: number;
  /** Positions still tracked as open — `pnlUsd !== null` (Jupiter nulls this once a market closes; see `core/normalizePosition.ts`). */
  currentOpenPositions: number;
  /** Positions ingested for this wallet that are no longer open. NOT a complete historical count — only positions this project has actually fetched via `/positions` for this wallet (see `docs/analytics-engine.md`). */
  closedPositions: number;

  totalVolumeUsd: string;
  realizedPnlUsd: string;
  unrealizedPnlUsd: string;

  /** Average `trades.priceUsd` where `action = 'buy'`. `null` if there are no buy trades. */
  averageEntryPrice: string | null;
  /** Average `trades.priceUsd` where `action = 'sell'`. `null` if there are no sell trades. */
  averageExitPrice: string | null;
  /** Average seconds between `openedAt` and `settlementDate ?? updatedAt`, across closed positions only. `null` if none have both timestamps. */
  averageHoldTimeSeconds: number | null;

  firstTrade: Date | null;
  lastTrade: Date | null;
  /** Distinct UTC calendar days (`YYYY-MM-DD` of `upstreamTimestamp`) with at least one trade. */
  activeDays: number;

  /** Which fields (if any) came from `wallet_profiles` because this wallet's own trades/history_events were empty — see the module doc comment. */
  usedProfileFallbackFor: WalletStatsFallbackField[];
}

export interface ComputeWalletStatsInput {
  walletPubkey: string;
  trades: Trade[];
  historyEvents: HistoryEvent[];
  positions: Position[];
  walletProfile: WalletProfile | null;
}

export function computeWalletStats(input: ComputeWalletStatsInput): WalletStats {
  const { walletPubkey, trades, historyEvents, positions, walletProfile } = input;

  const totalTrades = trades.length;

  const totalMarkets = new Set<string>([
    ...trades.map((trade) => trade.marketId),
    ...positions.map((position) => position.marketId),
    ...historyEvents.map((event) => event.marketId).filter((id): id is string => id !== null),
  ]).size;

  const openPositions = positions.filter((position) => position.pnlUsd !== null);
  const closedPositionsList = positions.filter((position) => position.pnlUsd === null);
  const currentOpenPositions = openPositions.length;
  const closedPositions = closedPositionsList.length;

  const usedProfileFallbackFor: WalletStatsFallbackField[] = [];

  let totalVolumeUsd: string;
  if (trades.length > 0) {
    totalVolumeUsd = sumDecimalStrings(trades.map((trade) => trade.amountUsd));
  } else if (walletProfile) {
    totalVolumeUsd = walletProfile.totalVolumeUsd;
    usedProfileFallbackFor.push('totalVolumeUsd');
  } else {
    totalVolumeUsd = '0.000000';
  }

  const historyRealizedPnlValues = historyEvents
    .map((event) => event.realizedPnlUsd)
    .filter((value): value is string => value !== null);
  let realizedPnlUsd: string;
  if (historyRealizedPnlValues.length > 0) {
    realizedPnlUsd = sumDecimalStrings(historyRealizedPnlValues);
  } else if (walletProfile) {
    realizedPnlUsd = walletProfile.realizedPnlUsd;
    usedProfileFallbackFor.push('realizedPnlUsd');
  } else {
    realizedPnlUsd = '0.000000';
  }

  const unrealizedPnlUsd = sumDecimalStrings(openPositions.map((position) => position.pnlUsd));

  const buyPrices = trades.filter((trade) => trade.action === 'buy').map((trade) => trade.priceUsd);
  const sellPrices = trades
    .filter((trade) => trade.action === 'sell')
    .map((trade) => trade.priceUsd);
  const averageEntryPrice = averageDecimalStrings(buyPrices);
  const averageExitPrice = averageDecimalStrings(sellPrices);

  const holdTimesSeconds: number[] = [];
  for (const position of closedPositionsList) {
    const closedAt = position.settlementDate ?? position.updatedAt;
    if (position.openedAt && closedAt) {
      const seconds = (closedAt.getTime() - position.openedAt.getTime()) / 1000;
      if (seconds >= 0) holdTimesSeconds.push(seconds);
    }
  }
  const averageHoldTimeSeconds =
    holdTimesSeconds.length > 0
      ? holdTimesSeconds.reduce((sum, value) => sum + value, 0) / holdTimesSeconds.length
      : null;

  let firstTradeMs = Infinity;
  let lastTradeMs = -Infinity;
  const activeDayKeys = new Set<string>();
  for (const trade of trades) {
    const ms = trade.upstreamTimestamp.getTime();
    if (ms < firstTradeMs) firstTradeMs = ms;
    if (ms > lastTradeMs) lastTradeMs = ms;
    activeDayKeys.add(trade.upstreamTimestamp.toISOString().slice(0, 10));
  }
  const firstTrade = trades.length > 0 ? new Date(firstTradeMs) : null;
  const lastTrade = trades.length > 0 ? new Date(lastTradeMs) : null;
  const activeDays = activeDayKeys.size;

  return {
    walletPubkey,
    totalTrades,
    totalMarkets,
    currentOpenPositions,
    closedPositions,
    totalVolumeUsd,
    realizedPnlUsd,
    unrealizedPnlUsd,
    averageEntryPrice,
    averageExitPrice,
    averageHoldTimeSeconds,
    firstTrade,
    lastTrade,
    activeDays,
    usedProfileFallbackFor,
  };
}
