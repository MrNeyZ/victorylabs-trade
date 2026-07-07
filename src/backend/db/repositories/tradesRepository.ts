/**
 * Data-access layer for the `trades` table. No business logic here — just
 * SQL. Callers are responsible for normalization (`../../core/normalizeTrade.ts`).
 */
import { getPool } from '../client.js';
import type { Trade } from '../../types/domain.js';
import type { JupiterTrade } from '../../types/jupiter.js';

export interface TradeUpsertInput {
  trade: Trade;
  /** Full upstream payload, stored verbatim in the `raw` JSONB column. */
  raw: JupiterTrade;
}

const COLUMNS = [
  'id',
  'owner_pubkey',
  'market_id',
  'event_id',
  'action',
  'side',
  'amount_usd',
  'price_usd',
  'event_title',
  'market_title',
  'message',
  'is_team_market',
  'upstream_timestamp',
  'raw',
  'observed_at',
] as const;

function toRowValues({ trade, raw }: TradeUpsertInput): unknown[] {
  return [
    trade.id,
    trade.ownerPubkey,
    trade.marketId,
    trade.eventId,
    trade.action,
    trade.side,
    trade.amountUsd,
    trade.priceUsd,
    trade.eventTitle,
    trade.marketTitle,
    trade.message,
    trade.isTeamMarket,
    trade.upstreamTimestamp,
    JSON.stringify(raw),
    trade.observedAt,
  ];
}

/**
 * Bulk upsert, keyed by upstream `id`. Trade fills are immutable once
 * recorded upstream (a given trade `id` never changes shape after the
 * fact), so this is `ON CONFLICT DO NOTHING`, not an update — re-ingesting
 * an already-seen trade is a cheap, safe no-op. Returns the number of NEW
 * rows actually inserted (already-seen duplicates are not counted), so
 * callers can report "N new / M fetched" without a separate query.
 */
export async function upsertTrades(inputs: TradeUpsertInput[]): Promise<number> {
  if (inputs.length === 0) return 0;

  const pool = getPool();
  const valuesSql: string[] = [];
  const params: unknown[] = [];

  inputs.forEach((input, rowIndex) => {
    const rowValues = toRowValues(input);
    const placeholders = rowValues.map(
      (_, colIndex) => `$${rowIndex * rowValues.length + colIndex + 1}`,
    );
    valuesSql.push(`(${placeholders.join(', ')})`);
    params.push(...rowValues);
  });

  const sql = `
    INSERT INTO trades (${COLUMNS.join(', ')})
    VALUES ${valuesSql.join(', ')}
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;

  const result = await pool.query(sql, params);
  return result.rowCount ?? 0;
}

export async function countTrades(): Promise<number> {
  const pool = getPool();
  const result = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM trades');
  return Number(result.rows[0]?.count ?? '0');
}

export async function getLatestTradeTimestamp(): Promise<Date | null> {
  const pool = getPool();
  const result = await pool.query<{ upstream_timestamp: Date }>(
    'SELECT upstream_timestamp FROM trades ORDER BY upstream_timestamp DESC LIMIT 1',
  );
  return result.rows[0]?.upstream_timestamp ?? null;
}

/**
 * Phase 6.1 — the continuous trades poller's own "did this actually
 * write anything recently" signal. Deliberately `observed_at` (our own
 * ingestion wall-clock), not `upstream_timestamp`
 * (`getLatestTradeTimestamp` above, Jupiter's trade-execution time) — an
 * all-duplicates poll leaves `observed_at` unchanged (nothing was
 * written, per `ON CONFLICT DO NOTHING`), so this is the one number that
 * actually goes stale if ingestion stops, which is exactly what a
 * long-running poller's per-iteration log needs to report.
 */
export async function getLatestObservedAt(): Promise<Date | null> {
  const pool = getPool();
  const result = await pool.query<{ observed_at: Date }>(
    'SELECT observed_at FROM trades ORDER BY observed_at DESC LIMIT 1',
  );
  return result.rows[0]?.observed_at ?? null;
}

export interface GetRecentActiveWalletsOptions {
  /** How far back to look, by our own ingestion wall-clock (`observed_at`), not upstream's trade timestamp. Default: 60. */
  sinceMinutes?: number;
  /** Default: 100. */
  limit?: number;
}

/**
 * Reconciliation-preparation helper only — does NOT call `/history` or
 * touch anything beyond `trades`. Returns distinct `owner_pubkey`s seen in
 * recently-ingested trades, most-recently-active first, as the candidate
 * wallet list a future phase would feed into per-wallet `/history` calls.
 */
export async function getRecentActiveWallets(
  options: GetRecentActiveWalletsOptions = {},
): Promise<string[]> {
  const sinceMinutes = options.sinceMinutes ?? 60;
  const limit = options.limit ?? 100;
  const pool = getPool();
  const result = await pool.query<{ owner_pubkey: string }>(
    `SELECT owner_pubkey
     FROM trades
     WHERE observed_at >= now() - make_interval(mins => $1)
     GROUP BY owner_pubkey
     ORDER BY MAX(observed_at) DESC
     LIMIT $2`,
    [sinceMinutes, limit],
  );
  return result.rows.map((row) => row.owner_pubkey);
}

export interface GetRecentTradesWithinMinutesOptions {
  /** Default: 2000 — generous enough for a busy `lookbackMinutes` window without being unbounded. */
  limit?: number;
}

/**
 * Signal-detection read path (`src/backend/analytics/signals/`,
 * Phase 3.5) — every trade with `upstream_timestamp` within the last
 * `minutes`, most-recent-first. Filters on `upstream_timestamp` (when the
 * trade actually happened), not `observed_at` (when we polled it),
 * matching how `recentTrades`/`WalletStats.lastTrade` already define
 * "recent" elsewhere in this project — unlike `getRecentActiveWallets`,
 * which deliberately uses `observed_at` for its own reconciliation
 * purpose.
 */
export async function getRecentTradesWithinMinutes(
  minutes: number,
  options: GetRecentTradesWithinMinutesOptions = {},
): Promise<Trade[]> {
  const limit = options.limit ?? 2000;
  const pool = getPool();
  const result = await pool.query<TradeRow>(
    `SELECT id, owner_pubkey, market_id, event_id, action, side, amount_usd, price_usd,
            event_title, market_title, message, is_team_market, upstream_timestamp, observed_at
     FROM trades
     WHERE upstream_timestamp >= now() - make_interval(mins => $1)
     ORDER BY upstream_timestamp DESC
     LIMIT $2`,
    [minutes, limit],
  );
  return result.rows.map(rowToTrade);
}

interface TradeRow {
  id: string;
  owner_pubkey: string;
  market_id: string;
  event_id: string | null;
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  amount_usd: string;
  price_usd: string;
  event_title: string | null;
  market_title: string | null;
  message: string | null;
  is_team_market: boolean | null;
  upstream_timestamp: Date;
  observed_at: Date;
}

function rowToTrade(row: TradeRow): Trade {
  return {
    id: row.id,
    ownerPubkey: row.owner_pubkey,
    marketId: row.market_id,
    eventId: row.event_id,
    action: row.action,
    side: row.side,
    amountUsd: row.amount_usd,
    priceUsd: row.price_usd,
    eventTitle: row.event_title,
    marketTitle: row.market_title,
    message: row.message,
    isTeamMarket: row.is_team_market,
    upstreamTimestamp: row.upstream_timestamp,
    observedAt: row.observed_at,
  };
}

export interface GetRecentTradesOptions {
  /** Default: 50. Callers (the API layer) are responsible for enforcing their own max — this repository does not clamp it. */
  limit?: number;
  marketId?: string;
  ownerPubkey?: string;
}

/** Read path for the API layer (`GET /api/trades/recent`) — filterable, ordered most-recent-first by upstream trade timestamp. */
export async function getRecentTrades(options: GetRecentTradesOptions = {}): Promise<Trade[]> {
  const limit = options.limit ?? 50;
  const pool = getPool();

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.marketId) {
    params.push(options.marketId);
    conditions.push(`market_id = $${params.length}`);
  }
  if (options.ownerPubkey) {
    params.push(options.ownerPubkey);
    conditions.push(`owner_pubkey = $${params.length}`);
  }
  params.push(limit);
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query<TradeRow>(
    `SELECT id, owner_pubkey, market_id, event_id, action, side, amount_usd, price_usd,
            event_title, market_title, message, is_team_market, upstream_timestamp, observed_at
     FROM trades
     ${whereClause}
     ORDER BY upstream_timestamp DESC
     LIMIT $${params.length}`,
    params,
  );

  return result.rows.map(rowToTrade);
}

/**
 * Analytics read path (`src/backend/analytics/walletStats/`) — every
 * trade for one wallet, not just the most recent N. Deliberately reuses
 * `getRecentTrades` (which already accepts `ownerPubkey` and an
 * un-clamped `limit`) rather than writing a near-duplicate query; the
 * limit here is just a generously-large safety bound, not a real cap for
 * any wallet's actual trade count.
 */
const ALL_ROWS_SAFETY_LIMIT = 1_000_000;

export async function getAllTradesForWallet(ownerPubkey: string): Promise<Trade[]> {
  return getRecentTrades({ ownerPubkey, limit: ALL_ROWS_SAFETY_LIMIT });
}

/**
 * Market-detail read path (`src/backend/analytics/marketDetail/`, Phase
 * 4.3) — every trade for one market, not just the most recent N. Same
 * "reuse `getRecentTrades` with a generously-large safety bound" pattern
 * as `getAllTradesForWallet`.
 */
export async function getAllTradesForMarket(marketId: string): Promise<Trade[]> {
  return getRecentTrades({ marketId, limit: ALL_ROWS_SAFETY_LIMIT });
}

export interface GetTradesSinceOptions {
  marketId?: string;
  ownerPubkey?: string;
  /** Safety cap so a stream resuming after a long gap can't return unbounded rows in one poll. Default: 500. */
  limit?: number;
}

/**
 * Read path for the SSE stream (`GET /api/trades/stream`). Returns trades
 * with `observed_at` strictly greater than `sinceObservedAt`, ordered
 * oldest-first — the caller streams them in that order and advances its
 * cursor to the last row's `observedAt`.
 *
 * Cursors on `observed_at` (our own ingestion wall-clock), not
 * `upstream_timestamp`: a trade could have an older upstream timestamp
 * but only just have been ingested, and `observed_at` is what "have I
 * already sent this to the client" actually needs to track. In practice
 * for this table the two stay correlated anyway — `trades` is populated
 * only by the live `/trades` poller, with no historical backfill path
 * that could insert an old row with a much newer `observed_at` out of
 * order relative to what a `getRecentTrades` snapshot already returned.
 */
export async function getTradesSince(
  sinceObservedAt: Date,
  options: GetTradesSinceOptions = {},
): Promise<Trade[]> {
  const limit = options.limit ?? 500;
  const pool = getPool();

  const conditions: string[] = ['observed_at > $1'];
  const params: unknown[] = [sinceObservedAt];
  if (options.marketId) {
    params.push(options.marketId);
    conditions.push(`market_id = $${params.length}`);
  }
  if (options.ownerPubkey) {
    params.push(options.ownerPubkey);
    conditions.push(`owner_pubkey = $${params.length}`);
  }
  params.push(limit);

  const result = await pool.query<TradeRow>(
    `SELECT id, owner_pubkey, market_id, event_id, action, side, amount_usd, price_usd,
            event_title, market_title, message, is_team_market, upstream_timestamp, observed_at
     FROM trades
     WHERE ${conditions.join(' AND ')}
     ORDER BY observed_at ASC
     LIMIT $${params.length}`,
    params,
  );

  return result.rows.map(rowToTrade);
}

export interface TopActiveMarket {
  marketId: string;
  /** Most recent non-null `event_title` among trades in this market within the window; `null` if none had one. */
  eventTitle: string | null;
  tradeCount: number;
  volumeUsd: string;
  lastTradeAt: Date;
}

interface TopActiveMarketRow {
  market_id: string;
  event_title: string | null;
  trade_count: string;
  volume_usd: string;
  last_trade_at: Date;
}

/**
 * Dashboard read path (`GET /api/dashboard`, Phase 3.7) — trades within
 * the last `lookbackMinutes`, aggregated per market and ranked by summed
 * `amount_usd` descending. The sum is computed in SQL over Postgres'
 * arbitrary-precision `NUMERIC`, not fetched row-by-row and summed in JS
 * — same precision-safety intent as `sumDecimalStrings`
 * (`../../utils/decimal.ts`), just done on the database side instead,
 * since aggregating over a whole market's trades in Node would mean
 * pulling every individual row across the network for no reason.
 */
export async function getTopActiveMarkets(
  lookbackMinutes: number,
  limit = 20,
): Promise<TopActiveMarket[]> {
  const pool = getPool();
  const result = await pool.query<TopActiveMarketRow>(
    `SELECT market_id,
            (ARRAY_AGG(event_title ORDER BY upstream_timestamp DESC) FILTER (WHERE event_title IS NOT NULL))[1] AS event_title,
            COUNT(*)::text AS trade_count,
            SUM(amount_usd)::text AS volume_usd,
            MAX(upstream_timestamp) AS last_trade_at
     FROM trades
     WHERE upstream_timestamp >= now() - make_interval(mins => $1)
     GROUP BY market_id
     ORDER BY SUM(amount_usd) DESC
     LIMIT $2`,
    [lookbackMinutes, limit],
  );

  return result.rows.map((row) => ({
    marketId: row.market_id,
    eventTitle: row.event_title,
    tradeCount: Number(row.trade_count),
    volumeUsd: row.volume_usd,
    lastTradeAt: row.last_trade_at,
  }));
}

export interface WalletActivityWindow {
  walletPubkey: string;
  /** Trade count within the last `recentMinutes`. */
  recentTradeCount: number;
  /** Sum of `amount_usd` within the last `recentMinutes`. */
  recentVolumeUsd: string;
  /** Trade count in the *previous* window of equal length (`recentMinutes` to `2 * recentMinutes` ago) — the baseline `recentTradeCount` is compared against to detect a pickup in activity. */
  previousTradeCount: number;
  previousVolumeUsd: string;
  /** This wallet's first trade ever seen by this project — NOT bounded to either window (see the function doc comment on why). */
  firstTradeAt: Date;
  lastTradeAt: Date;
}

interface WalletActivityWindowRow {
  owner_pubkey: string;
  recent_trade_count: string;
  recent_volume_usd: string;
  previous_trade_count: string;
  previous_volume_usd: string;
  first_trade_at: Date;
  last_trade_at: Date;
}

/**
 * Trending-wallet read path (`src/backend/analytics/trending/`, Phase
 * 4.1) — for every wallet with at least one trade in the last
 * `recentMinutes`, its trade count/volume in that window, the same in
 * the *previous* window of equal length (for detecting a pickup in
 * activity), and its first/last trade timestamps.
 *
 * Deliberately does NOT restrict the base scan to either window (no
 * `WHERE upstream_timestamp >= ...` on the outer query) — `first_trade_at`
 * needs to be each wallet's genuine first-ever trade, not just the
 * earliest one inside whatever window this call happens to ask for; a
 * long-time trader who happens to have `>= recentMinutes * 2` worth of
 * trades would otherwise look "brand new" to the "first appearance
 * recency" signal for no reason other than an arbitrary query bound. This
 * scans the whole `trades` table — acceptable at this project's current
 * scale (see `docs/trending-wallets.md`'s limitations section for the
 * real fix: backing this off the still-unused `wallets.first_seen_at`
 * column from `001_init.sql` instead of scanning `trades` for it).
 */
export async function getWalletActivityWindows(
  recentMinutes: number,
  limit = 500,
): Promise<WalletActivityWindow[]> {
  const pool = getPool();
  const result = await pool.query<WalletActivityWindowRow>(
    `SELECT owner_pubkey,
            COUNT(*) FILTER (WHERE upstream_timestamp >= now() - make_interval(mins => $1)) AS recent_trade_count,
            COALESCE(SUM(amount_usd) FILTER (WHERE upstream_timestamp >= now() - make_interval(mins => $1)), 0)::text AS recent_volume_usd,
            COUNT(*) FILTER (
              WHERE upstream_timestamp >= now() - make_interval(mins => $1 * 2)
                AND upstream_timestamp < now() - make_interval(mins => $1)
            ) AS previous_trade_count,
            COALESCE(SUM(amount_usd) FILTER (
              WHERE upstream_timestamp >= now() - make_interval(mins => $1 * 2)
                AND upstream_timestamp < now() - make_interval(mins => $1)
            ), 0)::text AS previous_volume_usd,
            MIN(upstream_timestamp) AS first_trade_at,
            MAX(upstream_timestamp) AS last_trade_at
     FROM trades
     GROUP BY owner_pubkey
     HAVING COUNT(*) FILTER (WHERE upstream_timestamp >= now() - make_interval(mins => $1)) > 0
     ORDER BY COUNT(*) FILTER (WHERE upstream_timestamp >= now() - make_interval(mins => $1)) DESC
     LIMIT $2`,
    [recentMinutes, limit],
  );

  return result.rows.map((row) => ({
    walletPubkey: row.owner_pubkey,
    recentTradeCount: Number(row.recent_trade_count),
    recentVolumeUsd: row.recent_volume_usd,
    previousTradeCount: Number(row.previous_trade_count),
    previousVolumeUsd: row.previous_volume_usd,
    firstTradeAt: row.first_trade_at,
    lastTradeAt: row.last_trade_at,
  }));
}

export interface MarketActivityWindow {
  marketId: string;
  /** Most recent non-null `event_title` seen for this market within the 2x window; `null` if none had one. */
  eventTitle: string | null;
  recentTradeCount: number;
  recentVolumeUsd: string;
  previousTradeCount: number;
  previousVolumeUsd: string;
  /** Distinct `owner_pubkey`s trading this market within the *recent* window only (not the previous one). */
  uniqueWallets: number;
  lastActivityAt: Date;
}

interface MarketActivityWindowRow {
  market_id: string;
  event_title: string | null;
  recent_trade_count: string;
  recent_volume_usd: string;
  previous_trade_count: string;
  previous_volume_usd: string;
  unique_wallets: string;
  last_activity_at: Date;
}

/**
 * Trending-market read path (`src/backend/analytics/trendingMarkets/`,
 * Phase 4.2) — the market-grouped counterpart to
 * `getWalletActivityWindows`. Unlike that function, this one DOES bound
 * its base scan to the `2 * recentMinutes` window — markets have no
 * "first appearance recency" signal (that's wallet-specific, see
 * `getWalletActivityWindows`'s own doc comment on why *it* can't be
 * bounded), so there's no `MIN(upstream_timestamp)` here that would be
 * corrupted by a bounded scan, and bounding it keeps this cheap on a
 * `trades` table that only keeps growing.
 */
export interface GetMarketActivityWindowsOptions {
  /**
   * Restrict to one market — used by the market-detail endpoint (Phase
   * 4.3, `gatherTrendingMarketInputForMarket`) to reuse this exact query
   * for a single market's trending inputs instead of scanning the full
   * candidate list and filtering client-side. Omitted, this behaves
   * identically to how Phase 4.2 left it.
   */
  marketId?: string;
}

export async function getMarketActivityWindows(
  recentMinutes: number,
  limit = 500,
  options: GetMarketActivityWindowsOptions = {},
): Promise<MarketActivityWindow[]> {
  const pool = getPool();
  const params: unknown[] = [recentMinutes, limit];
  let marketFilter = '';
  if (options.marketId !== undefined) {
    params.push(options.marketId);
    marketFilter = `AND market_id = $${params.length}`;
  }

  const result = await pool.query<MarketActivityWindowRow>(
    `SELECT market_id,
            (ARRAY_AGG(event_title ORDER BY upstream_timestamp DESC) FILTER (WHERE event_title IS NOT NULL))[1] AS event_title,
            COUNT(*) FILTER (WHERE upstream_timestamp >= now() - make_interval(mins => $1)) AS recent_trade_count,
            COALESCE(SUM(amount_usd) FILTER (WHERE upstream_timestamp >= now() - make_interval(mins => $1)), 0)::text AS recent_volume_usd,
            COUNT(*) FILTER (
              WHERE upstream_timestamp >= now() - make_interval(mins => $1 * 2)
                AND upstream_timestamp < now() - make_interval(mins => $1)
            ) AS previous_trade_count,
            COALESCE(SUM(amount_usd) FILTER (
              WHERE upstream_timestamp >= now() - make_interval(mins => $1 * 2)
                AND upstream_timestamp < now() - make_interval(mins => $1)
            ), 0)::text AS previous_volume_usd,
            COUNT(DISTINCT owner_pubkey) FILTER (WHERE upstream_timestamp >= now() - make_interval(mins => $1)) AS unique_wallets,
            MAX(upstream_timestamp) AS last_activity_at
     FROM trades
     WHERE upstream_timestamp >= now() - make_interval(mins => $1 * 2)
       ${marketFilter}
     GROUP BY market_id
     HAVING COUNT(*) FILTER (WHERE upstream_timestamp >= now() - make_interval(mins => $1)) > 0
     ORDER BY COUNT(*) FILTER (WHERE upstream_timestamp >= now() - make_interval(mins => $1)) DESC
     LIMIT $2`,
    params,
  );

  return result.rows.map((row) => ({
    marketId: row.market_id,
    eventTitle: row.event_title,
    recentTradeCount: Number(row.recent_trade_count),
    recentVolumeUsd: row.recent_volume_usd,
    previousTradeCount: Number(row.previous_trade_count),
    previousVolumeUsd: row.previous_volume_usd,
    uniqueWallets: Number(row.unique_wallets),
    lastActivityAt: row.last_activity_at,
  }));
}

export interface MarketTraderWallets {
  marketId: string;
  walletPubkeys: string[];
}

interface MarketTraderWalletsRow {
  market_id: string;
  wallet_pubkeys: string[];
}

/**
 * Trending-market read path (`src/backend/analytics/trendingMarkets/`,
 * Phase 4.2) — for a given set of (already-identified-as-candidate)
 * markets, every distinct wallet that traded each one within the recent
 * window. This is the identity list `gatherTrendingMarketsInput.ts`
 * cross-references against `wallet_score_snapshots` to compute "how many
 * of this market's traders are smart wallets" — a count
 * `getMarketActivityWindows` can't produce on its own (it only knows
 * `COUNT(DISTINCT owner_pubkey)`, not *which* pubkeys).
 */
export async function getMarketTraderWallets(
  marketIds: string[],
  recentMinutes: number,
): Promise<MarketTraderWallets[]> {
  if (marketIds.length === 0) return [];

  const pool = getPool();
  const result = await pool.query<MarketTraderWalletsRow>(
    `SELECT market_id, ARRAY_AGG(DISTINCT owner_pubkey) AS wallet_pubkeys
     FROM trades
     WHERE market_id = ANY($1)
       AND upstream_timestamp >= now() - make_interval(mins => $2)
     GROUP BY market_id`,
    [marketIds, recentMinutes],
  );

  return result.rows.map((row) => ({
    marketId: row.market_id,
    walletPubkeys: row.wallet_pubkeys,
  }));
}
