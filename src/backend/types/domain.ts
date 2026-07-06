/**
 * Normalized internal domain model — what the database schema
 * (`src/backend/db/migrations/001_init.sql`) mirrors, and what the
 * (not-yet-built) ingestion layer maps raw `../types/jupiter.ts` shapes into.
 *
 * Money fields are typed `string` (exact decimal), not `number`: Postgres
 * `NUMERIC` columns are read back by `pg` as strings by default specifically
 * to avoid float precision loss, and upstream itself sends these as
 * BigInt-safe strings for the same reason (see
 * `docs/jupiter-prediction-discovery.md` §3). Converting to `number`
 * anywhere in this pipeline would reintroduce the exact precision risk both
 * sides were designed to avoid — so domain types stay `string` all the way
 * through, and any arithmetic on them must use a decimal-safe library, not
 * native JS numbers.
 *
 * Unlike `jupiter.ts`, these are already unit-normalized to actual USD
 * (not upstream's micro-USD), since that's the natural unit for anything
 * this project will threshold/compare/display on top of them.
 */

export type TradeAction = 'buy' | 'sell';
export type TradeSide = 'yes' | 'no';
export type LeaderboardPeriod = 'all_time' | 'weekly' | 'monthly';
export type LeaderboardMetric = 'pnl' | 'volume' | 'win_rate';
export type MarketStatus = 'open' | 'closed';
export type MarketResult = 'yes' | 'no' | 'draw';
export type PositionLifecycleStatus = 'open' | 'resolving' | 'settled';
export type IngestionRunStatus = 'running' | 'success' | 'error';

export interface Wallet {
  walletPubkey: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** Where we most recently observed this wallet, e.g. 'trade' | 'leaderboard' | 'profile' | 'position'. Free-form, not an enforced enum. */
  lastSeenContext: string | null;
}

export interface Trade {
  /** Upstream `Trade.id`, e.g. `"order-2357571"`. */
  id: string;
  ownerPubkey: string;
  marketId: string;
  eventId: string | null;
  action: TradeAction;
  side: TradeSide;
  /** Actual USD, decimal string (converted from upstream micro-USD). */
  amountUsd: string;
  priceUsd: string;
  eventTitle: string | null;
  marketTitle: string | null;
  message: string | null;
  isTeamMarket: boolean | null;
  upstreamTimestamp: Date;
  observedAt: Date;
}

/**
 * Wallet-scoped history event, normalized from `GET /history` (v1).
 * Deliberately narrower than the full ~35-property upstream shape — see
 * `src/backend/db/migrations/002_history_events.sql` for why, and
 * `src/backend/core/normalizeHistoryEvent.ts` for the exact field mapping
 * (`action`/`side` are derived from upstream booleans; there is no
 * upstream string field for either).
 */
export interface HistoryEvent {
  /** Upstream `HistoryEvent.id` (a number upstream), stringified. */
  id: string;
  ownerPubkey: string;
  marketId: string | null;
  positionPubkey: string | null;
  action: TradeAction | null;
  side: TradeSide | null;
  eventTitle: string | null;
  upstreamTimestamp: Date | null;
  amountUsd: string | null;
  price: string | null;
  realizedPnlUsd: string | null;
  transactionSignature: string | null;
  observedAt: Date;
}

export interface Market {
  marketId: string;
  eventId: string | null;
  provider: string | null;
  title: string | null;
  subtitle: string | null;
  status: MarketStatus | null;
  result: MarketResult | null;
  marketResultPubkey: string | null;
  isTeamMarket: boolean | null;
  sportsMarketType: string | null;
  openTime: Date | null;
  closeTime: Date | null;
  resolveAt: Date | null;
  buyYesPriceUsd: string | null;
  buyNoPriceUsd: string | null;
  sellYesPriceUsd: string | null;
  sellNoPriceUsd: string | null;
  volumeUsd: string | null;
  rulesPrimary: string | null;
  rulesSecondary: string | null;
  imageUrl: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/** Latest-known snapshot per wallet (upsert by `walletPubkey`) — NOT a time series. See `LeaderboardSnapshot` for the time-series equivalent. */
export interface WalletProfile {
  walletPubkey: string;
  realizedPnlUsd: string;
  totalVolumeUsd: string;
  predictionsCount: number;
  correctPredictions: number;
  wrongPredictions: number;
  totalActiveContracts: string | null;
  totalActiveContractsMicro: string | null;
  totalPositionsValueUsd: string | null;
  snapshotAt: Date;
}

/** Latest-known state per position (upsert by `positionPubkey`). */
export interface Position {
  positionPubkey: string;
  ownerPubkey: string;
  marketId: string;
  eventId: string | null;
  isYes: boolean | null;
  sideLabel: 'Up' | 'Down' | null;
  contractsMicro: string | null;
  /** "0" when basis is unknown upstream — not a bug in this layer, see `JupiterPosition.totalCostUsd`. */
  totalCostUsd: string | null;
  valueUsd: string | null;
  avgPriceUsd: string | null;
  markPriceUsd: string | null;
  pnlUsd: string | null;
  pnlUsdAfterFees: string | null;
  realizedPnlUsd: string | null;
  feesPaidUsd: string | null;
  claimed: boolean | null;
  claimedUsd: string | null;
  claimable: boolean | null;
  payoutUsd: string | null;
  lifecycleStatus: PositionLifecycleStatus | null;
  openedAt: Date | null;
  updatedAt: Date | null;
  claimableAt: Date | null;
  settlementDate: Date | null;
  observedAt: Date;
}

/** One point-in-time row per (walletPubkey, period, snapshotAt) — a genuine time series, unlike `WalletProfile`. */
export interface LeaderboardSnapshot {
  walletPubkey: string;
  period: LeaderboardPeriod;
  /** Position in the returned array at fetch time — direct mirror of upstream ordering, not a derived score. */
  rank: number | null;
  realizedPnlUsd: string;
  totalVolumeUsd: string;
  predictionsCount: number;
  correctPredictions: number;
  wrongPredictions: number;
  winRatePct: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  snapshotAt: Date;
}

export interface IngestionRun {
  id: number;
  /** Which upstream endpoint this run polled, e.g. 'trades' | 'history' | 'leaderboards' | 'profiles' | 'positions' | 'markets'. */
  endpoint: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: IngestionRunStatus;
  rowsFetched: number | null;
  rowsUpserted: number | null;
  errorMessage: string | null;
}
