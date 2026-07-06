/**
 * Converts a raw `/positions` row into the normalized domain `Position`
 * shape. Pure function, no I/O — the caller keeps the raw payload
 * separately for the `raw` JSONB column (see
 * `src/backend/db/repositories/positionsRepository.ts`).
 *
 * A live re-probe against a real wallet with 9 open positions (2026-07-06)
 * confirmed Phase 2.1's original `JupiterPosition` typing needs no
 * corrections this time (unlike history's in Phase 2.4) — `realizedPnlUsd`
 * really is always a non-null `number` across all 9 rows, and
 * `pnlUsd`/`pnlUsdAfterFees`/`valueUsd`/`markPriceUsd` really are
 * nullable, exactly as typed.
 *
 * Two things handled explicitly rather than glossed over, per this
 * project's "handle nullable Forecast self-custody PnL fields honestly"
 * instruction:
 *   1. `pnlUsd`/`pnlUsdAfterFees` (unrealized PnL) are `null` once a
 *      market closes — kept `null` here too, not defaulted to `"0"` (a
 *      closed-market position genuinely has no unrealized PnL anymore,
 *      that's a different fact than "unrealized PnL is zero").
 *   2. `totalCostUsd`/`sizeUsd` are documented as `"0"` specifically when
 *      cost basis is unknown for Forecast self-custody positions (the
 *      ledger doesn't reconcile with the on-chain balance in that case —
 *      see `docs/rest-api-capabilities.md` §3.3). This is stored as-is,
 *      not corrected or hidden — a `total_cost_usd` of exactly `0` in this
 *      table can mean "genuinely free" or "basis unknown," and that
 *      ambiguity is upstream's, not manufactured by this normalization.
 */
import type { JupiterPosition } from '../types/jupiter.js';
import type { Position } from '../types/domain.js';
import { microUsdToUsd, microUsdToUsdOrNull } from '../utils/decimal.js';

/**
 * `realizedPnlUsd` is the one money field on `Position` that upstream
 * sends as a JS `number` rather than a string (see `types/jupiter.ts`).
 * Converting a `number` to micro-USD-shifted decimal risks float
 * precision loss if ever done via division — instead this stringifies
 * the (always-integer, i64) value first and reuses the same string-based
 * `microUsdToUsd` shift used everywhere else, with an explicit guard
 * against the (currently unrealistic, ~$9B+) case where the value would
 * exceed `Number.isSafeInteger` and the stringification itself could
 * already be lossy.
 */
function realizedPnlUsdToDecimalString(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `normalizePosition: realizedPnlUsd (${value}) exceeds Number.isSafeInteger — cannot convert without risking precision loss`,
    );
  }
  return microUsdToUsd(String(value));
}

function unixSecondsToDate(value: number | null | undefined): Date | null {
  return value === null || value === undefined ? null : new Date(value * 1000);
}

export function normalizePosition(raw: JupiterPosition, observedAt: Date): Position {
  return {
    positionPubkey: raw.pubkey,
    ownerPubkey: raw.ownerPubkey,
    marketId: raw.marketId,
    eventId: raw.eventId || null,
    isYes: raw.isYes,
    sideLabel: raw.sideLabel ?? null,
    contractsMicro: raw.contractsMicro,
    totalCostUsd: microUsdToUsd(raw.totalCostUsd),
    valueUsd: microUsdToUsdOrNull(raw.valueUsd),
    avgPriceUsd: microUsdToUsdOrNull(raw.avgPriceUsd),
    markPriceUsd: microUsdToUsdOrNull(raw.markPriceUsd),
    pnlUsd: microUsdToUsdOrNull(raw.pnlUsd),
    pnlUsdAfterFees: microUsdToUsdOrNull(raw.pnlUsdAfterFees),
    realizedPnlUsd: realizedPnlUsdToDecimalString(raw.realizedPnlUsd),
    feesPaidUsd: microUsdToUsd(raw.feesPaidUsd),
    claimed: raw.claimed,
    claimedUsd: microUsdToUsd(raw.claimedUsd),
    claimable: raw.claimable,
    payoutUsd: microUsdToUsd(raw.payoutUsd),
    lifecycleStatus: raw.lifecycleStatus ?? null,
    openedAt: unixSecondsToDate(raw.openedAt),
    updatedAt: unixSecondsToDate(raw.updatedAt),
    claimableAt: unixSecondsToDate(raw.claimableAt),
    settlementDate: unixSecondsToDate(raw.settlementDate),
    observedAt,
  };
}
