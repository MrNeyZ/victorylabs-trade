/**
 * Pure per-market breakdown of one wallet's activity — Phase 3.4. Takes
 * the same already-fetched `ComputeWalletStatsInput`
 * (`./computeWalletStats.js`) `gatherWalletStatsInput.ts` already builds,
 * so the API route (`src/backend/api/routes/wallets.ts`) fetches trades/
 * history/positions exactly once and feeds them into both this and
 * `computeWalletStats`/`computeActivitySummary` — no extra queries, no
 * new I/O.
 *
 * Money fields stay decimal strings (`sumDecimalStrings`,
 * `../../utils/decimal.ts`), same discipline as `computeWalletStats.ts`.
 */
import type { ComputeWalletStatsInput } from './computeWalletStats.js';
import { sumDecimalStrings } from '../../utils/decimal.js';

export interface MarketBreakdownEntry {
  marketId: string;
  /** Best-effort title: first non-null `trades.eventTitle` for this market, falling back to `history_events.eventTitle`. `null` if neither has one. */
  eventTitle: string | null;
  totalTrades: number;
  /** Sum of `trades.amountUsd` for this market. `"0.000000"` (not `null`) if this wallet has no trades here — unlike `realizedPnlUsd`/`currentPositionUsd`, trade volume has no "unknown" state, only "zero". */
  volumeUsd: string;
  /** Sum of `history_events.realizedPnlUsd` for this market — same source-of-truth as `computeWalletStats`'s wallet-level `realizedPnlUsd` (never `positions.realizedPnlUsd`, which would double-count the same settlement). `null` if no history event with a non-null realized PnL exists for this market — distinct from a real `"0.000000"`. */
  realizedPnlUsd: string | null;
  /** Sum of `positions.valueUsd` across every position this wallet holds in this market. `null` if no position has been ingested for this market at all. */
  currentPositionUsd: string | null;
  /** Most recent of: any trade's `upstreamTimestamp`, any history event's `upstreamTimestamp`, any position's `updatedAt` (falling back to `openedAt`) in this market. `null` if none of the three have a timestamp. */
  lastActivityAt: Date | null;
}

function latestTimestamp(timestamps: Array<Date | null>): Date | null {
  const present = timestamps.filter((ts): ts is Date => ts !== null);
  if (present.length === 0) return null;
  return present.reduce((latest, ts) => (ts > latest ? ts : latest));
}

/** Computed per market this wallet has any trade, history event, or position in — same "which markets" definition `computeWalletStats.totalMarkets` counts, just broken out per market instead of summed to one number. Sorted by `lastActivityAt` descending (nulls last), most recently active market first. */
export function computeMarketBreakdown(input: ComputeWalletStatsInput): MarketBreakdownEntry[] {
  const { trades, historyEvents, positions } = input;

  const marketIds = new Set<string>([
    ...trades.map((trade) => trade.marketId),
    ...positions.map((position) => position.marketId),
    ...historyEvents.map((event) => event.marketId).filter((id): id is string => id !== null),
  ]);

  const entries = Array.from(marketIds).map((marketId): MarketBreakdownEntry => {
    const marketTrades = trades.filter((trade) => trade.marketId === marketId);
    const marketHistory = historyEvents.filter((event) => event.marketId === marketId);
    const marketPositions = positions.filter((position) => position.marketId === marketId);

    const eventTitle =
      marketTrades.find((trade) => trade.eventTitle !== null)?.eventTitle ??
      marketHistory.find((event) => event.eventTitle !== null)?.eventTitle ??
      null;

    const realizedPnlValues = marketHistory
      .map((event) => event.realizedPnlUsd)
      .filter((value): value is string => value !== null);
    const realizedPnlUsd =
      realizedPnlValues.length > 0 ? sumDecimalStrings(realizedPnlValues) : null;

    const positionValues = marketPositions
      .map((position) => position.valueUsd)
      .filter((value): value is string => value !== null);
    const currentPositionUsd = positionValues.length > 0 ? sumDecimalStrings(positionValues) : null;

    const lastActivityAt = latestTimestamp([
      ...marketTrades.map((trade) => trade.upstreamTimestamp),
      ...marketHistory.map((event) => event.upstreamTimestamp),
      ...marketPositions.map((position) => position.updatedAt ?? position.openedAt),
    ]);

    return {
      marketId,
      eventTitle,
      totalTrades: marketTrades.length,
      volumeUsd: sumDecimalStrings(marketTrades.map((trade) => trade.amountUsd)),
      realizedPnlUsd,
      currentPositionUsd,
      lastActivityAt,
    };
  });

  entries.sort((a, b) => {
    const aTime = a.lastActivityAt?.getTime() ?? -Infinity;
    const bTime = b.lastActivityAt?.getTime() ?? -Infinity;
    return bTime - aTime;
  });

  return entries;
}
