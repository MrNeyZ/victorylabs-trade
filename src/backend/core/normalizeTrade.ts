/**
 * Converts a raw `/trades` row into the normalized domain `Trade` shape.
 * Pure function, no I/O — the caller decides what to do with the result
 * (and separately keeps the raw payload for the `raw JSONB` column; see
 * `src/backend/db/repositories/tradesRepository.ts`).
 */
import type { JupiterTrade } from '../types/jupiter.js';
import type { Trade } from '../types/domain.js';
import { microUsdToUsd } from '../utils/decimal.js';

export function normalizeTrade(raw: JupiterTrade, observedAt: Date): Trade {
  return {
    id: raw.id,
    ownerPubkey: raw.ownerPubkey,
    marketId: raw.marketId,
    eventId: raw.eventId ?? null,
    action: raw.action,
    side: raw.side,
    amountUsd: microUsdToUsd(raw.amountUsd),
    priceUsd: microUsdToUsd(raw.priceUsd),
    eventTitle: raw.eventTitle ?? null,
    marketTitle: raw.marketTitle ?? null,
    message: raw.message ?? null,
    isTeamMarket: raw.isTeamMarket ?? null,
    // Upstream `timestamp` is unix seconds.
    upstreamTimestamp: new Date(raw.timestamp * 1000),
    observedAt,
  };
}
