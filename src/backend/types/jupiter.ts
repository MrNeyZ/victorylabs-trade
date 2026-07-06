/**
 * Raw Jupiter Prediction REST API response shapes (`api.jup.ag/prediction/v1`).
 *
 * These mirror the official OpenAPI spec (`docs/samples/openapi-spec.json`)
 * and live probe samples (`docs/samples/*.json`) field-for-field — see
 * `docs/rest-api-capabilities.md` for the full analysis. Do NOT "clean up"
 * field names/casing/units here; that normalization happens in
 * `../types/domain.ts` and the (not-yet-built) ingestion layer.
 *
 * Two confirmed inconsistencies upstream, kept intentionally rather than
 * silently unified, since a mismatch here would be a real bug, not a style
 * choice:
 *   - `predictionsCount`/`correctPredictions`/`wrongPredictions` are `number`
 *     on `/leaderboards` but `string` on `/profiles/{ownerPubkey}` and
 *     `/profiles/batch`.
 *   - `Position.realizedPnlUsd` is a `number`; every other money field on
 *     `Position` (and on every other schema) is a numeric *string*
 *     (micro-USD, meant to be parsed as BigInt/decimal — see
 *     `docs/jupiter-prediction-discovery.md` §3).
 */

// ── /trades ──────────────────────────────────────────────────────────────────

export type JupiterTradeAction = 'buy' | 'sell';
export type JupiterTradeSide = 'yes' | 'no';

export interface JupiterMarketOption {
  label?: string;
  buyYes?: boolean;
  [key: string]: unknown;
}

export interface JupiterTrade {
  id: string;
  ownerPubkey: string;
  marketId: string;
  message: string;
  /** Unix seconds. */
  timestamp: number;
  action: JupiterTradeAction;
  side: JupiterTradeSide;
  eventTitle: string;
  marketTitle: string;
  /** Micro-USD, string (parse as BigInt/decimal — never `Number`). */
  amountUsd: string;
  /** Micro-USD, string. */
  priceUsd: string;
  eventImageUrl?: string;
  eventId?: string;
  isTeamMarket?: boolean;
  marketOptions?: JupiterMarketOption[] | null;
}

export interface JupiterTradesResponse {
  data: JupiterTrade[];
}

// ── /leaderboards ────────────────────────────────────────────────────────────

export type JupiterLeaderboardPeriod = 'all_time' | 'weekly' | 'monthly';
export type JupiterLeaderboardMetric = 'pnl' | 'volume' | 'win_rate';

export interface JupiterLeaderboardEntry {
  ownerPubkey: string;
  realizedPnlUsd: string;
  totalVolumeUsd: string;
  /** `number` here — unlike `/profiles*`, confirmed via the OpenAPI spec. */
  predictionsCount: number;
  correctPredictions: number;
  wrongPredictions: number;
  winRatePct: string;
  period: JupiterLeaderboardPeriod;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface JupiterLeaderboardsResponse {
  data: JupiterLeaderboardEntry[];
  summary?: Record<string, { totalVolumeUsd: string; predictionsCount: number }>;
}

// ── /profiles/{ownerPubkey}, /profiles/batch ────────────────────────────────

export interface JupiterProfile {
  ownerPubkey: string;
  realizedPnlUsd: string;
  totalVolumeUsd: string;
  /** `string` here — unlike `/leaderboards` (`number`). */
  predictionsCount: string;
  correctPredictions: string;
  wrongPredictions: string;
  /** Legacy floored whole-contract quantity string. */
  totalActiveContracts: string;
  /** Exact active contracts in micro-contract units (1_000_000 = 1). */
  totalActiveContractsMicro: string;
  totalActiveContractsDecimal: string;
  totalPositionsValueUsd: string;
}

export interface JupiterProfileBatchPeriodEntry {
  ownerPubkey: string;
  realizedPnlUsd: string;
  totalVolumeUsd: string;
  predictionsCount: string;
  correctPredictions: string;
  wrongPredictions: string;
}

export interface JupiterProfileBatchEntry {
  weekly: JupiterProfileBatchPeriodEntry;
  monthly: JupiterProfileBatchPeriodEntry;
  all_time: JupiterProfileBatchPeriodEntry;
  totalActiveContracts: string;
  totalActiveContractsMicro: string;
  totalActiveContractsDecimal: string;
}

export interface JupiterProfileBatchResponse {
  data: Record<string, JupiterProfileBatchEntry>;
}

// ── /history (v1 — per-fill event log, `ownerPubkey` required) ─────────────

export type JupiterHistoryEventType =
  | 'order_created'
  | 'order_closed'
  | 'order_filled'
  | 'order_failed'
  | 'payout_claimed'
  | 'position_updated'
  | 'position_lost'
  | 'ticket_created'
  | 'ticket_accepted'
  | 'ticket_rejected'
  | 'ticket_settled'
  | 'ticket_claimed'
  | 'ticket_refunded'
  | 'ticket_closed';

export interface JupiterHistoryEventV1 {
  id: number;
  eventType: JupiterHistoryEventType;
  signature: string;
  /** u64 as string. */
  slot: string;
  /** Unix seconds. */
  timestamp: number;
  orderPubkey: string;
  positionPubkey: string;
  marketId: string;
  ownerPubkey: string;
  keeperPubkey: string;
  externalOrderId: string;
  orderId: string;
  isBuy: boolean;
  isYes: boolean;
  contracts: string;
  contractsMicro: string;
  contractsDecimal: string;
  filledContracts: string;
  filledContractsMicro: string;
  filledContractsDecimal: string;
  contractsSettled: string;
  contractsSettledMicro: string;
  contractsSettledDecimal: string;
  maxFillPriceUsd: string;
  avgFillPriceUsd: string;
  maxBuyPriceUsd: string | null;
  minSellPriceUsd: string | null;
  depositAmountUsd: string;
  totalCostUsd: string;
  feeUsd: string | null;
  grossProceedsUsd: string;
  netProceedsUsd: string;
  transferAmountToken: string | null;
  /**
   * Nullable per the OpenAPI spec AND confirmed live (2026-07-06 probe
   * against a real wallet, 6/8 sampled rows had `null` here) — the
   * original Phase 2.1 typing had this as non-nullable `string`, which was
   * wrong. Only populated once a fill/settlement has actually occurred.
   */
  realizedPnl: string | null;
  realizedPnlBeforeFees: string | null;
  payoutAmountUsd: string;
  eventId: string;
  marketMetadata?: JupiterMarketMetadata;
  /**
   * Present on every live-observed row (order and position events alike)
   * despite not being documented in Phase 2.1's original typing — added
   * after a live re-check for Phase 2.4. Optional here anyway since it's
   * unconfirmed for `ticket_*` event types (never observed live).
   */
  eventMetadata?: JupiterEventMetadata;
}

export interface JupiterPagination {
  start: number;
  end: number;
  total: number;
  hasNext: boolean;
}

export interface JupiterHistoryV1Response {
  data: JupiterHistoryEventV1[];
  pagination: JupiterPagination;
}

// ── Shared nested metadata shapes ───────────────────────────────────────────

export interface JupiterEventMetadata {
  eventId: string;
  title?: string;
  subtitle?: string;
  imageUrl?: string;
  isLive?: boolean;
  status?: string;
  tags?: string[];
  closeTime?: number;
  beginAt?: string | null;
  category?: string;
  subcategory?: string;
}

export interface JupiterMarketMetadata {
  marketId: string;
  eventId: string;
  provider?: 'kalshi' | 'polymarket' | 'gx' | 'bisonfi';
  title?: string;
  subtitle?: string;
  description?: string;
  status?: string;
  lifecycleStatus?: 'open' | 'resolving' | 'settled';
  tradable?: boolean;
  result?: 'yes' | 'no' | 'draw' | null;
  closeTime?: number;
  openTime?: number;
  isTeamMarket?: boolean;
  sportsMarketType?: string | null;
  outcomeSide?: 'up' | 'down';
  sideLabel?: 'Up' | 'Down';
  sportsLine?: string | null;
  providerSportsLine?: string | null;
  lineBasis?: 'provider' | 'score_snapshot' | null;
}

// ── /positions (v1: array; v2 on prediction-market-api.jup.ag: grouped by
//    owner — same `Position` schema either way, per the OpenAPI spec) ──────

export interface JupiterPosition {
  /** Position account public key. */
  pubkey: string;
  owner: string;
  /** Alias of `owner` — prefer this field going forward per the spec. */
  ownerPubkey: string;
  /** Deterministic market PDA derived from `marketId`. */
  market: string;
  marketId: string;
  marketIdHash: string;
  isYes: boolean;
  outcomeSide?: 'up' | 'down';
  sideLabel?: 'Up' | 'Down';
  contracts: string;
  contractsMicro: string;
  contractsDecimal: string;
  /** "0" when basis is unknown (Forecast self-custody ledger gap — see docs/rest-api-capabilities.md §3.3). */
  totalCostUsd: string;
  sizeUsd: string;
  valueUsd: string | null;
  avgPriceUsd: string | null;
  markPriceUsd: string | null;
  sellPriceUsd?: string | null;
  maxSlippageBps: number | null;
  pnlUsd: string | null;
  pnlUsdPercent: number | null;
  pnlUsdAfterFees: string | null;
  pnlUsdAfterFeesPercent: number | null;
  openOrders: number;
  feesPaidUsd: string;
  integratorFeeUsd?: string;
  /** `number` here — the one money field on `Position` that isn't a string. */
  realizedPnlUsd: number;
  claimed: boolean;
  claimedUsd: string;
  openedAt: number;
  updatedAt: number;
  claimableAt: number | null;
  payoutUsd: string;
  bump: number;
  eventId: string;
  eventMetadata?: JupiterEventMetadata;
  marketMetadata?: JupiterMarketMetadata;
  settlementDate: number | null;
  claimable: boolean;
  source?: string;
  claimMethod?: string;
  lifecycleStatus?: 'open' | 'resolving' | 'settled';
  tradable?: boolean;
}

export interface JupiterPositionsV1Response {
  data: JupiterPosition[];
}

export interface JupiterPositionsV2Response {
  data: Record<string, JupiterPosition[]>;
}

// ── /markets/{marketId} ──────────────────────────────────────────────────────

export interface JupiterMarketPricing {
  buyYesPriceUsd: number;
  buyNoPriceUsd: number;
  sellYesPriceUsd: number;
  sellNoPriceUsd: number;
  volume: number;
}

export interface JupiterMarketTeam {
  name: string;
  imageUrl: string | null;
  color: string | null;
  abbreviation: string | null;
}

export interface JupiterMarket {
  provider: 'polymarket';
  marketId: string;
  status: 'open' | 'closed';
  result: 'yes' | 'no' | 'draw' | null;
  marketResultPubkey: string | null;
  title: string;
  /** Unix seconds. */
  openTime: number;
  /** Unix seconds. */
  closeTime: number;
  isTeamMarket: boolean;
  rulesPrimary: string;
  rulesSecondary: string;
  /** ISO 8601 string — NOT unix seconds, unlike every other timestamp field here. */
  resolveAt: string | null;
  pricing: JupiterMarketPricing;
  imageUrl: string | null;
  team: JupiterMarketTeam | null;
  outcomes: string[] | null;
  clobTokenIds: string[] | null;
  marketOptions: JupiterMarketOption[] | null;
  sportsMarketType: string | null;
  sportsLine: string | null;
}

// ── Standardized error shape (confirmed across most 4xx/5xx responses) ─────

export type JupiterErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'idempotency_error'
  | 'rate_limit_error'
  | 'api_error';

export interface JupiterErrorResponse {
  type: JupiterErrorType;
  message: string;
  code?: string;
  param?: string;
  request_id: string;
  doc_url?: string;
}
