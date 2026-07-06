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
