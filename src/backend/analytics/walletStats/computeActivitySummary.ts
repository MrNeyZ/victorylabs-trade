/**
 * Pure recent-activity summary for one wallet — Phase 3.4. Same input
 * shape as `computeMarketBreakdown.ts`/`computeWalletStats.ts`
 * (`ComputeWalletStatsInput`), no extra I/O. Takes the already-computed
 * `WalletStats` as a second argument specifically so `activeMarkets`
 * reuses `WalletStats.totalMarkets` rather than re-deriving the same
 * trades/positions/history-events market-union this project already
 * computes once in `computeWalletStats.ts`.
 *
 * `now` is an explicit parameter (defaulted to `new Date()`), same
 * pattern as `computeWalletScore.ts` — keeps this deterministic for
 * callers that supply a fixed clock.
 */
import type { ComputeWalletStatsInput, WalletStats } from './computeWalletStats.js';
import { sumDecimalStrings } from '../../utils/decimal.js';

export interface WalletActivitySummary {
  tradesLast24h: number;
  tradesLast7d: number;
  volumeLast24h: string;
  volumeLast7d: string;
  /** Same value as `WalletStats.totalMarkets` — distinct markets across trades + positions + history events, not just trades. */
  activeMarkets: number;
  /** Earliest of any trade's `upstreamTimestamp`, history event's `upstreamTimestamp`, or position's `openedAt`. `null` if this wallet has no data at all. Broader than `WalletStats.firstTrade` (trades only). */
  firstSeenAt: Date | null;
  /** Latest of the same three sources as `firstSeenAt`. `null` if this wallet has no data at all. Broader than `WalletStats.lastTrade` (trades only). */
  lastSeenAt: Date | null;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

export function computeActivitySummary(
  input: ComputeWalletStatsInput,
  stats: WalletStats,
  now: Date = new Date(),
): WalletActivitySummary {
  const { trades, historyEvents, positions } = input;

  const cutoff24hMs = now.getTime() - ONE_DAY_MS;
  const cutoff7dMs = now.getTime() - SEVEN_DAYS_MS;

  const tradesInLast24h = trades.filter(
    (trade) => trade.upstreamTimestamp.getTime() >= cutoff24hMs,
  );
  const tradesInLast7d = trades.filter((trade) => trade.upstreamTimestamp.getTime() >= cutoff7dMs);

  const allTimestamps: Array<Date | null> = [
    ...trades.map((trade): Date | null => trade.upstreamTimestamp),
    ...historyEvents.map((event) => event.upstreamTimestamp),
    ...positions.map((position) => position.openedAt),
  ];
  const presentTimestamps = allTimestamps.filter((ts): ts is Date => ts !== null);

  return {
    tradesLast24h: tradesInLast24h.length,
    tradesLast7d: tradesInLast7d.length,
    volumeLast24h: sumDecimalStrings(tradesInLast24h.map((trade) => trade.amountUsd)),
    volumeLast7d: sumDecimalStrings(tradesInLast7d.map((trade) => trade.amountUsd)),
    activeMarkets: stats.totalMarkets,
    firstSeenAt:
      presentTimestamps.length > 0
        ? presentTimestamps.reduce((earliest, ts) => (ts < earliest ? ts : earliest))
        : null,
    lastSeenAt:
      presentTimestamps.length > 0
        ? presentTimestamps.reduce((latest, ts) => (ts > latest ? ts : latest))
        : null,
  };
}
