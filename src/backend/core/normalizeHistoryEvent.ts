/**
 * Converts a raw `/history` (v1) row into the normalized domain
 * `HistoryEvent` shape. Pure function, no I/O — the caller keeps the raw
 * payload separately for the `raw` JSONB column (see
 * `src/backend/db/repositories/historyRepository.ts`).
 *
 * Two things this file exists specifically to get right, per Phase 2.4's
 * "support actual observed shape" instruction — both confirmed by a live
 * re-probe on 2026-07-06, not assumed from the OpenAPI spec alone:
 *
 *   1. `realizedPnl`/`realizedPnlBeforeFees` are `null` on the majority of
 *      real rows (only populated once a fill/settlement has occurred) —
 *      Phase 2.1's original typing had these as non-nullable `string`,
 *      which was wrong and has been corrected in `../types/jupiter.ts`.
 *   2. There is no upstream `action`/`side` string field on `HistoryEvent`
 *      (unlike `Trade`) — both are derived here from the `isBuy`/`isYes`
 *      booleans, which the OpenAPI spec documents as always present.
 */
import type { JupiterHistoryEventV1 } from '../types/jupiter.js';
import type { HistoryEvent } from '../types/domain.js';
import { microUsdToUsd } from '../utils/decimal.js';

/** Empty-string pubkey/id fields upstream (confirmed live, e.g. `orderPubkey: ""` on settlement-only events) are not meaningful identifiers — normalized to `null` rather than kept as `""`. */
function nullIfEmpty(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

function toMicroUsdOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return microUsdToUsd(value);
}

/**
 * There is no single upstream field that means "the dollar amount" for
 * every one of the 14 `eventType` values — `depositAmountUsd` (money in,
 * meaningful for order_created/order_filled), `payoutAmountUsd` (money
 * out, meaningful for payout_claimed), and `netProceedsUsd`/
 * `grossProceedsUsd` (meaningful for order_closed/sells) are each "0" when
 * not applicable to a given event. This precedence order is this
 * project's own normalization choice, not an upstream guarantee — pick
 * the first that's actually nonzero, defaulting to "0" if none are.
 */
function pickAmountUsd(raw: JupiterHistoryEventV1): string {
  const candidates = [
    raw.depositAmountUsd,
    raw.payoutAmountUsd,
    raw.netProceedsUsd,
    raw.grossProceedsUsd,
  ];
  for (const candidate of candidates) {
    if (candidate && candidate !== '0') {
      return microUsdToUsd(candidate);
    }
  }
  return '0.000000';
}

export function normalizeHistoryEvent(raw: JupiterHistoryEventV1, observedAt: Date): HistoryEvent {
  return {
    id: String(raw.id),
    ownerPubkey: raw.ownerPubkey,
    marketId: nullIfEmpty(raw.marketId),
    positionPubkey: nullIfEmpty(raw.positionPubkey),
    // No upstream action/side string exists on HistoryEvent — derived from
    // isBuy/isYes, which the spec documents as always present. Most
    // meaningful for fill-type events; still populated (not null) for
    // settlement/payout events, since the booleans are always present,
    // even though their business meaning is weaker there.
    action: raw.isBuy ? 'buy' : 'sell',
    side: raw.isYes ? 'yes' : 'no',
    eventTitle: raw.eventMetadata?.title ?? raw.marketMetadata?.title ?? null,
    upstreamTimestamp: Number.isFinite(raw.timestamp) ? new Date(raw.timestamp * 1000) : null,
    amountUsd: pickAmountUsd(raw),
    price: toMicroUsdOrNull(raw.avgFillPriceUsd),
    realizedPnlUsd: toMicroUsdOrNull(raw.realizedPnl),
    transactionSignature: nullIfEmpty(raw.signature),
    observedAt,
  };
}
