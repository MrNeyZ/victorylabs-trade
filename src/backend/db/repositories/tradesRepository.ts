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
